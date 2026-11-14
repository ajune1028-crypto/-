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
