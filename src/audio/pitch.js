// How high the voice is, every 10 ms.
//
// The YIN method (de Cheveigné and Kawahara, 2002): for each short window, find
// the smallest delay at which the signal repeats itself. One sung note at a
// time works well; chords and loud rooms do not. Pure computation.

export const ANALYSIS_RATE = 16000;
export const HOP = ANALYSIS_RATE / 100; // 10 ms
export const HOP_SECONDS = HOP / ANALYSIS_RATE;
export const WINDOW = 400; // 25 ms compared against itself
export const MIN_HZ = 65; // about C2, the lowest a person sings
export const MAX_HZ = 1050; // about C6, the highest a person sings

const TAU_MIN = Math.floor(ANALYSIS_RATE / MAX_HZ);
const TAU_MAX = Math.ceil(ANALYSIS_RATE / MIN_HZ);
const SPAN = WINDOW + TAU_MAX + 1;
const THRESHOLD = 0.15; // dips below this count as "repeats"
const UNVOICED = 0.4; // a best dip above this is no pitch at all
const SILENT_RMS = 1e-4;

/** Seconds at the middle of frame k's window. */
export function frameTime(k) {
  return (k * HOP + WINDOW / 2) / ANALYSIS_RATE;
}

/**
 * One frame: `hz` (0 when there is no clear pitch), `conf` (0..1, how cleanly
 * the window repeats) and `rms` (loudness of the window).
 */
export function pitchAt(x, start, d = new Float64Array(TAU_MAX + 2), cmnd = new Float64Array(TAU_MAX + 2)) {
  let energy = 0;
  for (let j = 0; j < WINDOW; j++) energy += x[start + j] * x[start + j];
  const rms = Math.sqrt(energy / WINDOW);
  if (rms < SILENT_RMS) return { hz: 0, conf: 0, rms, level: rms };

  // Difference function: how unlike itself the window is at each delay.
  for (let tau = 1; tau <= TAU_MAX + 1; tau++) {
    let sum = 0;
    const off = start + tau;
    for (let j = 0; j < WINDOW; j++) {
      const diff = x[start + j] - x[off + j];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  // Cumulative mean normalised difference: removes the bias toward tiny delays.
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= TAU_MAX + 1; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  // The first dip under the threshold, followed down to its bottom.
  let tau = -1;
  for (let t = TAU_MIN; t <= TAU_MAX; t++) {
    if (cmnd[t] < THRESHOLD) {
      while (t + 1 <= TAU_MAX && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    tau = TAU_MIN;
    for (let t = TAU_MIN + 1; t <= TAU_MAX; t++) if (cmnd[t] < cmnd[tau]) tau = t;
  }
  const best = cmnd[tau];
  if (best > UNVOICED) return { hz: 0, conf: Math.max(0, 1 - best), rms, level: rms };
  // Parabola through the bottom and its neighbours: a delay between samples.
  let exact = tau;
  if (tau > 1 && tau <= TAU_MAX) {
    const a = d[tau - 1];
    const b = d[tau];
    const c = d[tau + 1];
    const curve = a - 2 * b + c;
    if (curve > 0) exact = tau + (a - c) / (2 * curve);
  }
  return { hz: ANALYSIS_RATE / exact, conf: 1 - best, rms, level: periodLevel(x, start, exact) };
}

/**
 * Loudness over two whole periods around the frame's middle. Short enough to
 * see the dip of a consonant (the l in 라라라), and the same whatever the phase.
 */
function periodLevel(x, start, period) {
  const len = Math.max(80, Math.min(WINDOW, Math.round(2 * period)));
  const from = start + Math.round(WINDOW / 2 - len / 2);
  let e = 0;
  for (let j = 0; j < len; j++) e += x[from + j] * x[from + j];
  return Math.sqrt(e / len);
}

/** Takes 16 kHz samples as they come and hands back frames as soon as their window is complete. */
export class PitchTracker {
  constructor() {
    this.buf = new Float32Array(ANALYSIS_RATE);
    this.base = 0;
    this.len = 0;
    this.total = 0;
    this.k = 0;
    this.d = new Float64Array(TAU_MAX + 2);
    this.cmnd = new Float64Array(TAU_MAX + 2);
  }

  append(samples) {
    if (this.len + samples.length > this.buf.length) {
      const keep = Math.max(0, this.k * HOP - this.base);
      this.buf.copyWithin(0, keep, this.len);
      this.base += keep;
      this.len -= keep;
      if (this.len + samples.length > this.buf.length) {
        const grown = new Float32Array(Math.max(this.buf.length * 2, this.len + samples.length));
        grown.set(this.buf.subarray(0, this.len));
        this.buf = grown;
      }
    }
    this.buf.set(samples, this.len);
    this.len += samples.length;
    this.total += samples.length;
  }

  frame() {
    const f = pitchAt(this.buf, this.k * HOP - this.base, this.d, this.cmnd);
    this.k++;
    return f;
  }

  push(samples) {
    this.append(samples);
    const out = [];
    while (this.k * HOP + SPAN <= this.total) out.push(this.frame());
    return out;
  }

  /** The last frames, with silence after the end of the input. */
  flush() {
    const end = this.total;
    const out = [];
    if (this.k * HOP >= end) return out;
    this.append(new Float32Array(SPAN + HOP));
    while (this.k * HOP < end) out.push(this.frame());
    return out;
  }
}

/** Frames for a whole 16 kHz signal. */
export function trackPitch(samples) {
  const tracker = new PitchTracker();
  const frames = tracker.push(samples);
  for (const f of tracker.flush()) frames.push(f);
  return frames;
}
