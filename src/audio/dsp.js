// Plain signal helpers: mono mixdown and sample-rate conversion.
//
// Pure computation, no browser APIs, so the same code runs in the page, in a
// recording's live analysis and in the unit tests.

/** Averages the channels into one. */
export function toMono(channels) {
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i];
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

// Windowed-sinc kernel, tabulated once per rate pair and read with linear
// interpolation: computing sin() per tap would make long takes slow.
const ZEROS = 8;
const STEPS = 256;
const kernels = new Map();

function kernelFor(fromRate, toRate) {
  const key = fromRate + ":" + toRate;
  if (kernels.has(key)) return kernels.get(key);
  // Cut a little below the lower Nyquist so the transition band does not fold back.
  const fc = 0.5 * Math.min(1, toRate / fromRate) * 0.92;
  const half = Math.ceil(ZEROS / (2 * fc));
  const size = half * STEPS;
  const table = new Float32Array(size + 2);
  for (let i = 0; i <= size + 1; i++) {
    const d = i / STEPS;
    const x = 2 * fc * d;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const u = Math.min(1, d / half);
    const window = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u); // Blackman
    table[i] = 2 * fc * sinc * window;
  }
  const kernel = { table, half };
  kernels.set(key, kernel);
  return kernel;
}

/**
 * Converts a stream of samples from one rate to another, chunk by chunk. The
 * output does not depend on how the input was cut into chunks.
 */
export class StreamResampler {
  constructor(fromRate, toRate) {
    this.from = fromRate;
    this.to = toRate;
    this.same = fromRate === toRate;
    this.kernel = kernelFor(fromRate, toRate);
    this.buf = new Float32Array(4096);
    this.base = 0; // absolute index of buf[0]
    this.len = 0; // samples held in buf
    this.total = 0; // samples pushed so far
    this.next = 0; // next output index
  }

  /** Input position of output sample j, in input samples. */
  pos(j) {
    return (j * this.from) / this.to;
  }

  append(chunk) {
    if (this.len + chunk.length > this.buf.length) {
      // Drop what no future output needs, then grow if still short.
      const keep = Math.max(0, Math.floor(this.pos(this.next)) - this.kernel.half - 1 - this.base);
      if (keep > 0) {
        this.buf.copyWithin(0, keep, this.len);
        this.base += keep;
        this.len -= keep;
      }
      if (this.len + chunk.length > this.buf.length) {
        const grown = new Float32Array(Math.max(this.buf.length * 2, this.len + chunk.length));
        grown.set(this.buf.subarray(0, this.len));
        this.buf = grown;
      }
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    this.total += chunk.length;
  }

  sample(p) {
    const { table, half } = this.kernel;
    const first = Math.ceil(p - half);
    const last = Math.floor(p + half);
    let sum = 0;
    let weight = 0;
    for (let k = first; k <= last; k++) {
      const at = Math.abs(p - k) * STEPS;
      const i = at | 0;
      const w = table[i] + (table[i + 1] - table[i]) * (at - i);
      weight += w;
      const idx = k - this.base;
      if (k >= 0 && k < this.total && idx >= 0 && idx < this.len) sum += this.buf[idx] * w;
    }
    return weight ? sum / weight : 0;
  }

  /** Adds input; returns every output sample that the input so far fully decides. */
  push(chunk) {
    if (this.same) {
      this.total += chunk.length;
      this.next += chunk.length;
      return Float32Array.from(chunk);
    }
    this.append(chunk);
    const out = [];
    while (Math.floor(this.pos(this.next) + this.kernel.half) < this.total) {
      out.push(this.sample(this.pos(this.next)));
      this.next++;
    }
    return Float32Array.from(out);
  }

  /** The remaining output, treating everything after the input as silence. */
  flush() {
    if (this.same) return new Float32Array(0);
    const out = [];
    while (this.pos(this.next) < this.total) {
      out.push(this.sample(this.pos(this.next)));
      this.next++;
    }
    return Float32Array.from(out);
  }
}

/** Converts a whole signal at once. */
export function resample(samples, fromRate, toRate) {
  const stream = new StreamResampler(fromRate, toRate);
  const a = stream.push(samples);
  const b = stream.flush();
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

const LOUD_TOP = 0.89; // about -1 dB under the top
const LOUD_MOST = 16; // never more than 24 dB louder (the room's hiss comes up too)
const LOUD_ENOUGH = 0.5;

/**
 * A quiet take made loud enough to hear (a phone far away records very softly):
 * scaled so its loudest sample stands just under the top, at most 16 times.
 * A take loud enough already comes back as it is. Returns { samples, gain }.
 */
export function louder(samples) {
  let top = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > top) top = a;
  }
  if (top >= LOUD_ENOUGH || top < 1e-6) return { samples, gain: 1 };
  const gain = Math.min(LOUD_MOST, LOUD_TOP / top);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return { samples: out, gain };
}

// ---- dropouts ----------------------------------------------------------------------------------

const DROP_EPS = 1e-4; // as good as nothing (−80 dB): what a busy phone hands over for samples it lost
const DROP_MIN_S = 0.002;
const DROP_MAX_S = 0.06; // longer than this, a silence is a real one
const DROP_SMEAR_S = 0.001; // a resampler rings for about this long at each end of the gap
const DROP_EDGE_S = 0.003; // the sound right beside the gap…
const DROP_REACH_S = 0.04; // …against the loudest 10 ms within this much
const DROP_ABRUPT = 0.35; // beside the gap at least this share of that: it stopped dead, it did not fade
const DROP_SOUND = 1e-3; // and there was sound (−60 dB), not a quiet room

function rmsOf(x, a, b) {
  let e = 0;
  for (let i = a; i < b; i++) e += x[i] * x[i];
  return Math.sqrt(e / Math.max(1, b - a));
}

function loudest(x, a, b, win) {
  let top = 0;
  const hop = Math.max(1, win >> 2);
  for (let s = a; s + win <= b; s += hop) top = Math.max(top, rmsOf(x, s, s + win));
  return top;
}

/** Fills x[a..b) with what came just before, a period at a time, and blends it into what follows. */
function fillGap(x, a, b, rate) {
  const W = Math.round(0.012 * rate);
  const lo = Math.max(1, Math.round(0.002 * rate));
  const hi = Math.round(0.02 * rate);
  const r = new Float64Array(hi + 1);
  let best = 0;
  if (a - W - hi >= 0) {
    for (let lag = lo; lag <= hi; lag++) {
      let num = 0, e1 = 0, e2 = 0;
      for (let k = a - W; k < a; k++) { num += x[k] * x[k - lag]; e1 += x[k] * x[k]; e2 += x[k - lag] * x[k - lag]; }
      r[lag] = num / Math.sqrt(e1 * e2 + 1e-12);
      if (r[lag] > best) best = r[lag];
    }
  }
  // The first peak that repeats nearly as well as the best (one period, not two); not a tone: the last 20 ms again.
  let L = hi;
  if (best >= 0.5) for (let lag = lo + 1; lag < hi; lag++) if (r[lag] >= 0.9 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) { L = lag; break; }
  L = Math.min(L, a);
  for (let k = a; k < b; k++) x[k] = x[k - L];
  // What follows came in abruptly: the carried-on sound hands over to it within 4 ms.
  const C = Math.min(Math.round(0.004 * rate), x.length - b);
  const carry = new Float32Array(C);
  for (let c = 0; c < C; c++) carry[c] = c - L < 0 ? x[b + c - L] : carry[c - L];
  for (let c = 0; c < C; c++) {
    const w = 1 - (c + 1) / (C + 1);
    x[b + c] = w * carry[c] + (1 - w) * x[b + c];
  }
}

/**
 * Dropouts filled in, for reading the notes: where the sound stops dead for a moment inside loud
 * sound and starts again just as abruptly (a busy phone or browser lost a few blocks of samples
 * and handed over zeros), the gap is filled with the sound just before it, a pitch period at a
 * time, and handed smoothly over to what follows, as a phone call hides a lost packet. Without
 * this a held note is read as two (the stop looks like a new syllable). A stop that fades out or
 * in (a singer's own), the silence before the first sound and a silence longer than 60 ms are
 * left as they are. Returns { samples (a copy where anything was filled, else the same array),
 * filled: [[from, to], …] }.
 */
export function concealDropouts(samples, rate) {
  const n = samples.length;
  const minLen = Math.max(2, Math.round(DROP_MIN_S * rate));
  const maxLen = Math.round(DROP_MAX_S * rate);
  const smear = Math.round(DROP_SMEAR_S * rate);
  const edge = Math.max(2, Math.round(DROP_EDGE_S * rate));
  const reach = Math.round(DROP_REACH_S * rate);
  const win = Math.max(4, Math.round(0.01 * rate));
  let out = samples;
  const filled = [];
  for (let i = 0; i < n;) {
    if (Math.abs(samples[i]) >= DROP_EPS) { i++; continue; }
    let j = i;
    while (j < n && Math.abs(samples[j]) < DROP_EPS) j++;
    const a = i - smear, b = j + smear;
    i = j;
    if (j - (a + smear) < minLen || j - (a + smear) > maxLen) continue;
    if (a - edge - reach < 0 || b + edge + reach > n) continue;
    const before = rmsOf(samples, a - edge, a);
    const after = rmsOf(samples, b, b + edge);
    const aroundBefore = loudest(samples, a - edge - reach, a - edge, win);
    const aroundAfter = loudest(samples, b + edge, b + edge + reach, win);
    if (aroundBefore < DROP_SOUND || aroundAfter < DROP_SOUND) continue;
    if (before < DROP_ABRUPT * aroundBefore || after < DROP_ABRUPT * aroundAfter) continue;
    if (out === samples) out = Float32Array.from(samples);
    fillGap(out, a, b, rate);
    filled.push([a, b]);
  }
  return { samples: out, filled };
}
