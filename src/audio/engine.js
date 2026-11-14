// Plays a song: every clip on every row at once, from the playhead on, as
// piano notes or as the recorded sound.
//
// Sounds are booked a little ahead on the audio engine's own clock, so a busy
// screen never shakes the rhythm. The app keeps one audio context; browsers
// only allow sound after a tap, so it is made (or woken) from a tap.

import { PianoVoice, reverbImpulse, reverbMix } from "./piano.js";

const LOOKAHEAD = 0.25; // seconds booked ahead
const TICK_MS = 40;
const TAIL_MS = 400; // after the last clip ends, before stopping

let shared = null;

/** The app's audio context. Call from inside a tap. Null where the browser has none. */
export async function audioContext() {
  if (!shared) {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return null;
    shared = new Ctx({ latencyHint: "interactive" });
  }
  if (shared.state === "suspended") {
    try {
      await shared.resume();
    } catch {
      // Some browsers refuse outside a tap; the next tap tries again.
    }
  }
  return shared;
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
export class SongPlayer {
  constructor(ctx, { song, audioFor, onEnd = () => {} }) {
    this.ctx = ctx;
    this.song = song;
    this.audioFor = audioFor;
    this.onEnd = onEnd;
    this.voice = new PianoVoice(ctx);
    this.mode = "piano";
    this.tone = "bright";
    this.playing = false;
    this.nodes = new Set();
    this.timer = null;
    this.keepGoing = false;
    this.fallback = new Set();
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

  /** Where the playhead is, in ms. */
  get position() {
    if (!this.playing) return this.from;
    return this.from + (this.ctx.currentTime - this.startedAt) * 1000;
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
    return this.startedAt + (ms - this.from) / 1000;
  }

  book(first) {
    if (!this.playing) return;
    const song = this.song();
    const until = this.from + (this.ctx.currentTime - this.startedAt + LOOKAHEAD) * 1000;
    if (until <= this.booked) return;
    const from = this.booked;
    const opts = { ongoing: first };
    if (this.mode === "original") {
      for (const seg of song.audioSegments(from, until, opts)) {
        const buf = this.audioFor(seg.src);
        if (buf) this.playAudio(buf, seg);
        // A clip whose recording is not on this device plays as piano.
        else this.fallback.add(seg.clip);
      }
      if (this.fallback.size) for (const ev of song.noteEvents(from, until, opts)) if (this.fallback.has(ev.clip)) this.playNote(ev);
    } else {
      for (const ev of song.noteEvents(from, until, opts)) this.playNote(ev);
    }
    this.booked = until;
    if (!this.keepGoing && this.position > song.end() + TAIL_MS) {
      this.stop();
      this.onEnd();
    }
  }

  playNote(ev) {
    this.track(this.voice.play(this.bus, ev.p, this.when(ev.at), ev.d / 1000, ev.v, this.tone));
  }

  playAudio(buf, seg) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    const at = this.when(seg.at);
    const end = at + seg.d / 1000;
    // Short fades so a cut clip does not click.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(1, at + 0.006);
    gain.gain.setValueAtTime(1, Math.max(at + 0.006, end - 0.008));
    gain.gain.linearRampToValueAtTime(0, end);
    src.connect(gain);
    gain.connect(this.dry);
    src.start(at, seg.offset / 1000, seg.d / 1000 + 0.01);
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
