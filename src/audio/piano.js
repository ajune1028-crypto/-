// The piano's sound, made by the app itself (no recorded samples).
//
// Each key is rendered once into a buffer from a small physical sketch of a
// struck string: partials a little sharper than whole multiples (string
// stiffness), two strings slightly out of tune with each other (the slow
// beating that makes a piano sound alive), high partials dying away faster
// than low ones, a fast first decay then a long tail, and a short knock of
// the hammer. "밝게" keeps more high partials and knock; "어둡게" rounds them
// off and lets the room's reverb carry more.
//
// renderPianoNote and reverbImpulse are pure; PianoVoice wraps them for the
// browser's audio engine. A recorded piano can later replace PianoVoice's
// buffers without touching anything else.

export const PIANO_RATE = 32000; // enough air for the top partials (the owner: "더 아름다워야")
export const TONES = ["bright", "dark"];

/** 0 = darkest, 1 = brightest. */
export function brightnessOf(tone) {
  if (typeof tone === "number") return Math.min(1, Math.max(0, tone));
  return tone === "dark" ? 0.15 : 0.85;
}

const hzOf = (midi) => 440 * 2 ** ((midi - 69) / 12);
const lerp = (a, b, t) => a + (b - a) * t;

/** Seconds a key keeps sounding (to about -50 dB) before it is cut off. */
export function noteSeconds(midi) {
  return Math.min(4, Math.max(1.6, 3.4 * 2 ** (-(midi - 60) / 30)));
}

/**
 * One key as mono samples. Deterministic: the same key, tone and velocity
 * always give the same samples.
 */
export function renderPianoNote(midi, opts = {}) {
  const [l, r] = renderPianoStereo(midi, opts);
  const out = new Float32Array(l.length);
  for (let n = 0; n < out.length; n++) out[n] = (l[n] + r[n]) * 0.5;
  // The same level as the stereo pair's loudest side.
  let peak = 0;
  for (let n = 0; n < out.length; n++) peak = Math.max(peak, Math.abs(out[n]));
  const want = 0.32 + 0.5 * Math.min(1, Math.max(0.05, opts.velocity ?? 0.8));
  if (peak > 0) for (let n = 0; n < out.length; n++) out[n] *= want / peak;
  return out;
}

/**
 * One key as two channels, as a piano sounds from the player's seat: low keys a little to the
 * left, high ones to the right, and each of a key's strings (one in the deep bass, two, then three
 * from the middle up) in its own place, a fraction of a cent apart, so the note shimmers and is wide.
 */
export function renderPianoStereo(midi, { rate = PIANO_RATE, tone = "bright", velocity = 0.8, seconds = noteSeconds(midi) } = {}) {
  const b = brightnessOf(tone);
  const v = Math.min(1, Math.max(0.05, velocity));
  // Stretched a few cents as a real piano is tuned (high keys a little sharp, low a little flat).
  const f0 = hzOf(midi) * 2 ** (Math.max(-6, Math.min(6, 0.1 * (midi - 64))) / 1200);
  const len = Math.round(seconds * rate);
  const outL = new Float32Array(len);
  const outR = new Float32Array(len);
  const strings = midi < 34 ? [[0, 0]] : midi < 46 ? [[-0.55, -0.08], [0.65, 0.08]] : [[-0.9, -0.12], [0.15, 0], [1.05, 0.12]];
  const keyPan = Math.max(-0.45, Math.min(0.45, (midi - 64) / 48));
  const stiffness = 0.00008 * 2 ** ((midi - 60) / 19);
  const slow = 3.2 * 2 ** (-(midi - 60) / 24); // time constant of the long tail
  const slope = lerp(2.15, 1.2, b) - 0.35 * (v - 0.5);
  const corner = lerp(1000, 6200, b) * (0.7 + 0.6 * v);
  const strike = 1 / 7.3; // the hammer hits about a seventh along the string
  const maxPartials = Math.round(lerp(14, 28, b));
  const nyquist = rate / 2 - 500;

  for (let k = 1; k <= maxPartials; k++) {
    const fk = k * f0 * Math.sqrt(1 + stiffness * k * k);
    if (fk >= nyquist) break;
    let amp = k ** -slope * (0.18 + 0.82 * Math.abs(Math.sin(Math.PI * k * strike)));
    amp /= 1 + (fk / corner) ** 2;
    if (amp < 1e-4) continue;
    const tail = slow / (1 + 0.012 * k * k * lerp(1.7, 1, b));
    const first = tail * 0.18;
    const d1 = Math.exp(-1 / (first * rate));
    const d2 = Math.exp(-1 / (tail * rate));
    // Each string a fraction of a cent apart, with its own oscillator and its own place.
    for (const [cents, spread] of strings) {
      const w = (2 * Math.PI * fk * 2 ** (cents / 1200)) / rate;
      const c = 2 * Math.cos(w);
      let y1 = Math.sin(-w + k + cents);
      let y2 = Math.sin(-2 * w + k + cents);
      let e1 = (amp * 0.55) / strings.length;
      let e2 = (amp * 0.45) / strings.length;
      const pan = Math.max(-1, Math.min(1, keyPan + spread));
      const gl = Math.cos(((pan + 1) * Math.PI) / 4);
      const gr = Math.sin(((pan + 1) * Math.PI) / 4);
      for (let n = 0; n < len; n++) {
        const y = c * y1 - y2;
        y2 = y1;
        y1 = y;
        const s = y * (e1 + e2);
        outL[n] += s * gl;
        outR[n] += s * gr;
        e1 *= d1;
        e2 *= d2;
      }
    }
  }

  // The hammer's knock: a short burst of filtered noise.
  let seed = (midi * 7919 + Math.round(v * 100)) >>> 0;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  const knock = lerp(0.02, 0.07, b) * v;
  const pole = Math.exp((-2 * Math.PI * lerp(1800, 6500, b)) / rate);
  let lp = 0;
  const knockLen = Math.round(0.03 * rate);
  const kl = Math.cos(((keyPan + 1) * Math.PI) / 4);
  const kr = Math.sin(((keyPan + 1) * Math.PI) / 4);
  for (let n = 0; n < Math.min(len, knockLen); n++) {
    lp = lp * pole + noise() * (1 - pole);
    const k = lp * knock * Math.exp(-n / (0.008 * rate));
    outL[n] += k * kl;
    outR[n] += k * kr;
  }

  // A quick rise (no click), a fade before the cut, and a level that follows velocity.
  const rise = Math.round(0.0015 * rate);
  const fade = Math.round(0.25 * rate);
  let peak = 0;
  for (let n = 0; n < len; n++) {
    const g = (n < rise ? n / rise : 1) * (n > len - fade ? (len - n) / fade : 1);
    outL[n] *= g;
    outR[n] *= g;
    peak = Math.max(peak, Math.abs(outL[n]), Math.abs(outR[n]));
  }
  const gain = peak > 0 ? (0.32 + 0.5 * v) / peak : 0;
  for (let n = 0; n < len; n++) {
    outL[n] *= gain;
    outR[n] *= gain;
  }
  return [outL, outR];
}

/**
 * A room's echo, as two channels: a few early reflections off near walls, then a soft tail whose
 * high sound dies sooner than its low (as in a real hall). Darker tones get a warmer, longer room.
 */
export function reverbImpulse(rate, tone = "bright") {
  const b = brightnessOf(tone);
  const seconds = lerp(2.4, 1.7, b);
  const len = Math.round(seconds * rate);
  const pole = Math.exp((-2 * Math.PI * lerp(2500, 7000, b)) / rate);
  let seed = 12345;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  return [0, 1].map((side) => {
    const ch = new Float32Array(len);
    let lp = 0;
    let energy = 0;
    const pre = Math.round(0.012 * rate);
    const tail = len - pre;
    for (let n = pre; n < len; n++) {
      lp = lp * pole + noise() * (1 - pole);
      const t = (n - pre) / tail;
      // The low part of the tail lasts; the high part (the noise around the low) fades faster.
      const low = lp * Math.exp(-6.9 * t);
      const high = (noise() * 0.35) * Math.exp(-6.9 * t * 2.2);
      ch[n] = low + high;
    }
    // Early reflections: a handful of taps in the first 40 ms, different on each side.
    for (const [ms, g] of side ? [[9, 0.5], [17, 0.32], [29, 0.22], [41, 0.14]] : [[11, 0.48], [21, 0.3], [33, 0.2], [37, 0.12]]) {
      const at = pre + Math.round((ms / 1000) * rate);
      if (at < len) ch[at] += g * 4;
    }
    for (let n = 0; n < len; n++) energy += ch[n] * ch[n];
    const norm = energy > 0 ? 1 / Math.sqrt(energy) : 0;
    for (let n = 0; n < len; n++) ch[n] *= norm;
    return ch;
  });
}

/** How much of the sound goes through the room's echo. */
export const reverbMix = (tone) => lerp(0.32, 0.14, brightnessOf(tone));

/**
 * Plays piano notes through the browser's audio engine. Keys are rendered on
 * first use and kept, per tone; velocity is applied as gain.
 */
export class PianoVoice {
  constructor(ctx) {
    this.ctx = ctx;
    this.buffers = new Map();
  }

  /** A key's sound, in two layers: struck firmly (bright) or softly (rounder, darker), as a piano does. */
  buffer(midi, tone, soft = false) {
    const key = tone + ":" + midi + (soft ? ":soft" : "");
    let buf = this.buffers.get(key);
    if (!buf) {
      const [l, r] = renderPianoStereo(midi, { tone, velocity: soft ? 0.38 : 0.85 });
      buf = this.ctx.createBuffer(2, l.length, PIANO_RATE);
      buf.getChannelData(0).set(l);
      buf.getChannelData(1).set(r);
      this.buffers.set(key, buf);
    }
    return buf;
  }

  /** Renders the given keys ahead of time, a few at a time, so playback starts without a stall. */
  async prepare(midis, tone) {
    let n = 0;
    for (const midi of new Set(midis)) {
      // Both the firm and the soft sound (soft sung notes play the soft one).
      this.buffer(midi, tone);
      this.buffer(midi, tone, true);
      if (++n % 2 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }

  /**
   * Sounds `midi` at context time `when` for `seconds`, then lets go like a
   * piano's damper. Returns the source node so it can be stopped early.
   */
  play(dest, midi, when, seconds, velocity, tone) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    const soft = velocity < 0.55;
    src.buffer = this.buffer(midi, tone, soft);
    const gain = ctx.createGain();
    const level = (soft ? 1.35 : 1) * (0.25 + 0.75 * Math.min(1, Math.max(0.05, velocity)));
    // A gentle damper (as with a little pedal): the note does not stop dead, it rings on a moment.
    const release = midi < 48 ? 0.6 : 0.42;
    const off = when + Math.max(0.12, seconds);
    gain.gain.setValueAtTime(level, when);
    gain.gain.setValueAtTime(level, off);
    gain.gain.setTargetAtTime(0, off, release / 4);
    src.connect(gain);
    gain.connect(dest);
    src.start(when);
    src.stop(Math.min(when + src.buffer.duration, off + release * 2));
    src.onended = () => gain.disconnect();
    return src;
  }
}
