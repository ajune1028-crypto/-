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

export const PIANO_RATE = 24000;
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
export function renderPianoNote(midi, { rate = PIANO_RATE, tone = "bright", velocity = 0.8, seconds = noteSeconds(midi) } = {}) {
  const b = brightnessOf(tone);
  const v = Math.min(1, Math.max(0.05, velocity));
  const f0 = hzOf(midi);
  const len = Math.round(seconds * rate);
  const out = new Float32Array(len);
  const stiffness = 0.00008 * 2 ** ((midi - 60) / 19);
  const slow = 3.2 * 2 ** (-(midi - 60) / 24); // time constant of the long tail
  const slope = lerp(2.15, 1.2, b) - 0.35 * (v - 0.5);
  const corner = lerp(1300, 5200, b) * (0.7 + 0.6 * v);
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
    // Two strings a fraction of a cent apart, each with its own oscillator.
    for (const cents of [-0.55, 0.65]) {
      const w = (2 * Math.PI * fk * 2 ** (cents / 1200)) / rate;
      const c = 2 * Math.cos(w);
      let y1 = Math.sin(-w + k);
      let y2 = Math.sin(-2 * w + k);
      let e1 = amp * 0.55 * 0.5;
      let e2 = amp * 0.45 * 0.5;
      for (let n = 0; n < len; n++) {
        const y = c * y1 - y2;
        y2 = y1;
        y1 = y;
        out[n] += y * (e1 + e2);
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
  for (let n = 0; n < Math.min(len, knockLen); n++) {
    lp = lp * pole + noise() * (1 - pole);
    out[n] += lp * knock * Math.exp(-n / (0.008 * rate));
  }

  // A quick rise (no click), a fade before the cut, and a level that follows velocity.
  const rise = Math.round(0.0015 * rate);
  const fade = Math.round(0.25 * rate);
  let peak = 0;
  for (let n = 0; n < len; n++) {
    if (n < rise) out[n] *= n / rise;
    if (n > len - fade) out[n] *= (len - n) / fade;
    peak = Math.max(peak, Math.abs(out[n]));
  }
  const gain = peak > 0 ? (0.32 + 0.5 * v) / peak : 0;
  for (let n = 0; n < len; n++) out[n] *= gain;
  return out;
}

/** A room's echo, as two channels of decaying noise. Darker tones get a warmer, longer room. */
export function reverbImpulse(rate, tone = "bright") {
  const b = brightnessOf(tone);
  const seconds = lerp(2.2, 1.5, b);
  const len = Math.round(seconds * rate);
  const pole = Math.exp((-2 * Math.PI * lerp(2500, 7000, b)) / rate);
  let seed = 12345;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  return [0, 1].map(() => {
    const ch = new Float32Array(len);
    let lp = 0;
    let energy = 0;
    const pre = Math.round(0.012 * rate);
    for (let n = pre; n < len; n++) {
      lp = lp * pole + noise() * (1 - pole);
      ch[n] = lp * Math.exp((-6.9 * (n - pre)) / (len - pre));
      energy += ch[n] * ch[n];
    }
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

  buffer(midi, tone) {
    const key = tone + ":" + midi;
    let buf = this.buffers.get(key);
    if (!buf) {
      const samples = renderPianoNote(midi, { tone, velocity: 0.8 });
      buf = this.ctx.createBuffer(1, samples.length, PIANO_RATE);
      buf.getChannelData(0).set(samples);
      this.buffers.set(key, buf);
    }
    return buf;
  }

  /** Renders the given keys ahead of time, a few at a time, so playback starts without a stall. */
  async prepare(midis, tone) {
    let n = 0;
    for (const midi of new Set(midis)) {
      this.buffer(midi, tone);
      if (++n % 3 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }

  /**
   * Sounds `midi` at context time `when` for `seconds`, then lets go like a
   * piano's damper. Returns the source node so it can be stopped early.
   */
  play(dest, midi, when, seconds, velocity, tone) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer(midi, tone);
    const gain = ctx.createGain();
    const level = 0.25 + 0.75 * Math.min(1, Math.max(0.05, velocity));
    const release = midi < 48 ? 0.35 : 0.22;
    const off = when + Math.max(0.06, seconds);
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
