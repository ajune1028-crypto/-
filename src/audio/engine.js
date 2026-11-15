// Plays a song: every clip on every row at once, from the playhead on, as
// piano notes or as the recorded sound.
//
// Sounds are booked a little ahead on the audio engine's own clock, so a busy
// screen never shakes the rhythm. The app keeps one audio context; browsers
// only allow sound after a tap, so it is made (or woken) from a tap.

import { PianoVoice, reverbImpulse, reverbMix } from "./piano.js";
import { timeStretch } from "./stretch.js";

const LOOKAHEAD = 0.25; // seconds booked ahead
const TICK_MS = 40;
const TAIL_MS = 400; // after the last clip ends, before stopping

let shared = null;

/**
 * The app's audio context; null where the browser has none. To make sound it
 * must be woken from inside a tap (`wake`). Reading files does not need that,
 * so importing never waits on it. Some app views never answer a wake, so the
 * wait is capped.
 */
export async function audioContext({ wake = true } = {}) {
  if (!shared) {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return null;
    shared = new Ctx({ latencyHint: "interactive" });
  }
  if (wake) soundFor(recordingNow ? "recording" : "playing");
  // iOS also stops a context when a call or another app takes the sound ("interrupted").
  if (wake && (shared.state === "suspended" || shared.state === "interrupted")) {
    try {
      await Promise.race([shared.resume(), new Promise((resolve) => setTimeout(resolve, 1500))]);
    } catch {
      // Some browsers refuse outside a tap; the next tap tries again.
    }
  }
  return shared;
}

let recordingNow = false;
let silentLoop = null;

const isApple = () => {
  const n = globalThis.navigator;
  return !!n && (/iP(hone|ad|od)/.test(n.userAgent || "") || (n.platform === "MacIntel" && n.maxTouchPoints > 1));
};

/**
 * iPhone and iPad play a page's sound through the silent switch (and the iPad's
 * silent mode) as "ambient": muted. A page that plays music says so ("playback");
 * while the mic records, "play-and-record". Older iOS without that switch learns it
 * from a silent sound looping in an audio element, started from the same tap.
 * Elsewhere this does nothing.
 */
export function soundFor(kind) {
  recordingNow = kind === "recording";
  try {
    const session = globalThis.navigator?.audioSession;
    if (session) {
      const want = recordingNow ? "play-and-record" : "playback";
      if (session.type !== want) session.type = want;
      return;
    }
    if (!isApple() || typeof Audio === "undefined" || recordingNow) return;
    if (!silentLoop) {
      // 0.1 s of silence, as an 8 kHz 8-bit WAV.
      const n = 800;
      const bytes = new Uint8Array(44 + n);
      const v = new DataView(bytes.buffer);
      const text = (at, str) => { for (let i = 0; i < str.length; i++) bytes[at + i] = str.charCodeAt(i); };
      text(0, "RIFF"); v.setUint32(4, 36 + n, true); text(8, "WAVEfmt "); v.setUint32(16, 16, true);
      v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
      v.setUint16(32, 1, true); v.setUint16(34, 8, true); text(36, "data"); v.setUint32(40, n, true);
      bytes.fill(128, 44);
      silentLoop = new Audio(URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })));
      silentLoop.loop = true;
      silentLoop.setAttribute("playsinline", "");
      document.addEventListener("visibilitychange", () => { if (document.hidden) silentLoop.pause(); });
    }
    if (silentLoop.paused) silentLoop.play().catch(() => {});
  } catch {
    // Never in the way of the sound itself.
  }
}

/** For tests: use this context instead of making one. */
export function useAudioContext(ctx) {
  shared = ctx;
}

/**
 * One player per open song room.
 *   song()        the SongDoc to play
 *   audioFor(id)  the decoded AudioBuffer of a sound, or null when this device
 *                 does not have the recording (its clips then play as piano)
 */
import { clicksIn } from "../core/beat.js";

export class SongPlayer {
  constructor(ctx, { song, audioFor, onEnd = () => {} }) {
    this.ctx = ctx;
    this.song = song;
    this.audioFor = audioFor;
    this.onEnd = onEnd;
    this.voice = new PianoVoice(ctx);
    this.mode = "piano";
    this.tone = "bright";
    this.speed = 1;
    this.stretched = new Map();
    this.playing = false;
    this.nodes = new Set();
    this.timer = null;
    this.keepGoing = false;
    this.fallback = new Set();
    this.metronome = null; // 박자: { bpm, beats, unit } to click on the beats, or null
    this.clicked = 0;
    // Piano → bus → (dry, and the room's echo) → out. Recorded sound goes to dry only.
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    this.bus = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.reverb = ctx.createConvolver();
    this.bus.connect(this.dry);
    this.bus.connect(this.reverb);
    this.dry.connect(this.out);
    this.reverb.connect(this.wet);
    this.wet.connect(this.out);
    this.out.connect(ctx.destination);
    this.setTone(this.tone);
  }

  setTone(tone) {
    this.tone = tone;
    const [l, r] = reverbImpulse(this.ctx.sampleRate, tone);
    const ir = this.ctx.createBuffer(2, l.length, this.ctx.sampleRate);
    ir.getChannelData(0).set(l);
    ir.getChannelData(1).set(r);
    this.reverb.buffer = ir;
    this.wet.gain.value = reverbMix(tone);
    this.dry.gain.value = 1 - reverbMix(tone) * 0.5;
    if (this.playing) this.restart();
  }

  setMode(mode) {
    this.mode = mode;
    if (this.playing) this.restart();
  }

  /** 0.5 to 3: notes come closer together; recordings are stretched so their pitch stays. */
  setSpeed(speed) {
    if (this.playing) {
      const at = this.position;
      this.speed = speed;
      this.play(at, { keepGoing: this.keepGoing });
    } else this.speed = speed;
  }

  /** A recording at the current speed, made once per sound and speed. */
  /** The sound read `this.speed × clipSpeed` times as fast, pitch kept (kept for the next time). */
  atSpeed(src, buf, clipSpeed = 1) {
    const total = this.speed * clipSpeed;
    if (total === 1) return buf;
    const key = src + ":" + total;
    if (!this.stretched.has(key)) {
      const samples = timeStretch(buf.getChannelData(0), buf.sampleRate, total);
      const out = this.ctx.createBuffer(1, Math.max(1, samples.length), buf.sampleRate);
      out.getChannelData(0).set(samples);
      this.stretched.set(key, out);
    }
    return this.stretched.get(key);
  }

  /** Where the playhead is, in ms of the song. */
  get position() {
    if (!this.playing) return this.from;
    return this.from + (this.ctx.currentTime - this.startedAt) * 1000 * this.speed;
  }

  /**
   * Starts at `fromMs`. `keepGoing` keeps the clock running past the last clip
   * (while recording, the take may be longer than the song).
   */
  play(fromMs, { keepGoing = false } = {}) {
    this.stop();
    this.from = Math.max(0, fromMs);
    this.keepGoing = keepGoing;
    this.startedAt = this.ctx.currentTime + 0.03;
    this.booked = this.from;
    this.fallback = new Set();
    this.playing = true;
    // Notes already sounding at the playhead are picked up from where it is.
    this.book(true);
    this.timer = setInterval(() => this.book(false), TICK_MS);
  }

  restart() {
    const at = this.position;
    const keep = this.keepGoing;
    this.play(at, { keepGoing: keep });
  }

  /** Ctx time of a timeline position in ms. */
  when(ms) {
    return this.startedAt + (ms - this.from) / 1000 / this.speed;
  }

  book(first) {
    if (!this.playing) return;
    const song = this.song();
    const until = this.from + (this.ctx.currentTime - this.startedAt + LOOKAHEAD) * 1000 * this.speed;
    if (until <= this.booked) return;
    const from = this.booked;
    const opts = { ongoing: first };
    if (this.mode === "original") {
      for (const seg of song.audioSegments(from, until, opts)) {
        const buf = this.audioFor(seg.src);
        if (buf) this.playAudio(this.atSpeed(seg.src, buf, seg.speed || 1), seg);
        // A clip whose recording is not on this device plays as piano.
        else this.fallback.add(seg.clip);
      }
      if (this.fallback.size) for (const ev of song.noteEvents(from, until, opts)) if (this.fallback.has(ev.clip)) this.playNote(ev);
    } else {
      for (const ev of song.noteEvents(from, until, opts)) this.playNote(ev);
      // A recording in which no notes were found would be silent as piano: it plays as recorded.
      for (const seg of song.audioSegments(from, until, opts)) {
        if (!this.bare(song, seg.clip)) continue;
        const buf = this.audioFor(seg.src);
        if (buf) this.playAudio(this.atSpeed(seg.src, buf, seg.speed || 1), seg);
      }
    }
    if (this.metronome) for (const c of clicksIn(from, until, this.metronome)) this.click(c);
    this.booked = until;
    if (!this.keepGoing && this.position > song.end() + TAIL_MS) {
      this.stop();
      this.onEnd();
    }
  }

  /** Whether a clip's stretch of its recording holds no notes at all. */
  bare(song, clipId) {
    const clip = song.clip(clipId);
    if (!clip) return false;
    const lo = clip.offset;
    const hi = clip.offset + clip.length;
    return !song.notesOf(clip.src).some((n) => n.t < hi && n.t + n.d > lo);
  }

  /** 박자: click on the beats while playing (null: no clicks). Takes effect from the next beat. */
  setMetronome(tempo) {
    this.metronome = tempo || null;
  }

  /** One metronome click: a short high tick, higher on a bar's first beat. */
  click({ at, accent }) {
    const ctx = this.ctx;
    const t = this.when(at);
    if (t < ctx.currentTime - 0.005) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1320;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(accent ? 0.5 : 0.3, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(t);
    osc.stop(t + 0.06);
    osc.onended = () => gain.disconnect();
    this.track(osc);
    this.clicked++;
  }

  playNote(ev) {
    this.track(this.voice.play(this.bus, ev.p, this.when(ev.at), ev.d / 1000 / this.speed, ev.v, this.tone));
  }

  playAudio(buf, seg) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    const at = this.when(seg.at);
    const end = at + seg.d / 1000 / this.speed;
    // Short fades so a cut clip does not click.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(1, at + 0.006);
    gain.gain.setValueAtTime(1, Math.max(at + 0.006, end - 0.008));
    gain.gain.linearRampToValueAtTime(0, end);
    src.connect(gain);
    gain.connect(this.dry);
    // seg.d is song time; seg.offset is the sound's own time, read (speed × the clip's speed) times as fast.
    src.start(at, seg.offset / 1000 / (this.speed * (seg.speed || 1)), seg.d / 1000 / this.speed + 0.01);
    src.onended = () => gain.disconnect();
    this.track(src);
  }

  track(node) {
    this.nodes.add(node);
    const done = node.onended;
    node.onended = (e) => {
      this.nodes.delete(node);
      done?.(e);
    };
  }

  stop() {
    if (this.playing) this.from = this.position;
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
    for (const node of this.nodes) {
      try {
        node.stop();
      } catch {
        // Already stopped.
      }
    }
    this.nodes.clear();
  }

  /** Moves the playhead; playing continues from there. */
  seek(ms) {
    if (this.playing) this.play(ms, { keepGoing: this.keepGoing });
    else this.from = Math.max(0, ms);
  }

  /** Sounds one note now, for trying a note out. */
  preview(midi, seconds = 0.6, velocity = 0.8) {
    this.track(this.voice.play(this.bus, midi, this.ctx.currentTime + 0.01, seconds, velocity, this.tone));
  }

  close() {
    this.stop();
    try {
      this.out.disconnect();
    } catch {
      // Nothing connected.
    }
  }
}
