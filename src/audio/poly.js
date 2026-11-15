// Several pitches at once, every 10 ms: a voice over a guitar, two people singing together, a
// song with its band. (The owner: "모든 사람의 음을 인식해서… 다른 음이 있다면 화음으로 쌓는".)
//
// The method is Klapuri's (2006), "Multiple fundamental frequency estimation by summing harmonic
// amplitudes": the spectrum is flattened band by band, so that a quiet instrument counts beside a
// loud one; every candidate pitch is given the sum of the spectrum at its harmonics (its
// "salience"); the strongest candidate is taken, its harmonics are taken out of the spectrum, and
// the rest is asked again, until taking one more adds nothing. Pure computation.

import { ANALYSIS_RATE, HOP, WINDOW } from "./pitch.js";
import { makeFft } from "./fft.js";

export const POLY_WINDOW = 2048; // 128 ms: low voices' harmonics come apart
const K = 4096; // the transform's length (the window, padded: finer steps between bins)
const HALF = K / 2;
const BIN_HZ = ANALYSIS_RATE / K;
const STEPS = 5; // candidate pitches per semitone
const LOW_KEY = 36; // C2
const HIGH_KEY = 84; // C6
const CANDIDATES = (HIGH_KEY - LOW_KEY) * STEPS + 1;
const MAX_HARMONICS = 20;
const TOP_HZ = 7200;
const ALPHA = 52; // Klapuri's weights for a long window: g = (f + α) / (m·f + β)
const BETA = 320;
const NU = 0.33; // how far the spectrum is flattened
const TAKE = 1; // how much of a found sound's harmonics is taken out
const SMOOTH_OVER = 1.25; // a harmonic may stand this far above its neighbours and still be all this sound's
const GAMMA = 0.7; // one more pitch must add this much to count
export const MAX_VOICES = 5;
const REACH_CENTS = 14; // a harmonic is looked for this far round where it should be

const keyHz = (key) => 440 * 2 ** ((key - 69) / 12);

// The window, and its shape in the spectrum (for taking a harmonic out).
const hann = new Float64Array(POLY_WINDOW);
for (let i = 0; i < POLY_WINDOW; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / POLY_WINDOW);
const LOBE = [1, 0.849, 0.5, 0.17]; // a Hann window's main lobe, at the padded bins from its top

// Where each candidate's harmonics lie: bins [lo, hi] and the weight.
const candHz = new Float64Array(CANDIDATES);
const nHarm = new Uint8Array(CANDIDATES);
const lo = new Uint16Array(CANDIDATES * MAX_HARMONICS);
const hi = new Uint16Array(CANDIDATES * MAX_HARMONICS);
const weight = new Float64Array(CANDIDATES * MAX_HARMONICS);
for (let j = 0; j < CANDIDATES; j++) {
  const f = keyHz(LOW_KEY + j / STEPS);
  candHz[j] = f;
  const spread = 2 ** (REACH_CENTS / 1200) - 1;
  let m = 1;
  for (; m <= MAX_HARMONICS && m * f < TOP_HZ; m++) {
    const k0 = (m * f) / BIN_HZ;
    const half = Math.max(1, k0 * spread);
    lo[j * MAX_HARMONICS + m - 1] = Math.max(1, Math.round(k0 - half));
    hi[j * MAX_HARMONICS + m - 1] = Math.min(HALF - 2, Math.round(k0 + half));
    weight[j * MAX_HARMONICS + m - 1] = (f + ALPHA) / (m * f + BETA);
  }
  nHarm[j] = m - 1;
}

// The bands the spectrum is flattened over (critical bands, 26 Hz to about 7 kHz), as triangles.
const bandHz = [];
for (let b = 0; b <= 32; b++) bandHz.push(229 * (10 ** ((b + 1) / 21.4) - 1));
const BANDS = 30;
const bandFrom = new Uint16Array(BANDS);
const bandTo = new Uint16Array(BANDS);
const bandCentre = new Float64Array(BANDS);
for (let b = 0; b < BANDS; b++) {
  bandFrom[b] = Math.max(1, Math.ceil(bandHz[b] / BIN_HZ));
  bandTo[b] = Math.min(HALF - 1, Math.floor(bandHz[b + 2] / BIN_HZ));
  bandCentre[b] = bandHz[b + 1] / BIN_HZ;
}

/** The work space for one stream of frames (so nothing is allocated per frame). */
export function polyState() {
  return {
    fft: makeFft(K), re: new Float64Array(K), im: new Float64Array(K),
    mag: new Float64Array(HALF + 1), flat: new Float64Array(HALF + 1), rest: new Float64Array(HALF + 1), taken: new Float64Array(HALF + 1),
    gain: new Float64Array(BANDS), sal: new Float64Array(CANDIDATES),
    peakBin: new Uint16Array(MAX_HARMONICS), peakAmp: new Float64Array(MAX_HARMONICS),
  };
}

/** The spectrum of the window that starts at `start` (zeros outside the signal), flattened. Returns the window's loudness. */
function spectrum(st, x, start) {
  const { re, im, mag, flat, gain } = st;
  re.fill(0);
  im.fill(0);
  let energy = 0;
  for (let i = 0; i < POLY_WINDOW; i++) {
    const s = start + i;
    const v = s >= 0 && s < x.length ? x[s] : 0;
    energy += v * v;
    re[i] = v * hann[i];
  }
  st.fft.forward(re, im);
  for (let k = 0; k <= HALF; k++) mag[k] = Math.hypot(re[k], im[k]);
  // Flatten: each band's level is pulled most of the way to the same height.
  for (let b = 0; b < BANDS; b++) {
    let sum = 0;
    const c = bandCentre[b];
    const left = c - bandFrom[b] + 1;
    const right = bandTo[b] - c + 1;
    for (let k = bandFrom[b]; k <= bandTo[b]; k++) {
      const w = k <= c ? (k - bandFrom[b] + 1) / left : (bandTo[b] - k + 1) / right;
      sum += w * mag[k] * mag[k];
    }
    const sigma = Math.sqrt(sum / K);
    gain[b] = sigma > 1e-9 ? sigma ** (NU - 1) : 0;
  }
  let b = 0;
  for (let k = 0; k <= HALF; k++) {
    while (b < BANDS - 1 && k > bandCentre[b + 1]) b++;
    let g;
    if (k <= bandCentre[0]) g = gain[0];
    else if (b >= BANDS - 1) g = gain[BANDS - 1];
    else {
      const u = (k - bandCentre[b]) / (bandCentre[b + 1] - bandCentre[b]);
      g = gain[b] + (gain[b + 1] - gain[b]) * u;
    }
    flat[k] = g * mag[k];
  }
  return Math.sqrt(energy / POLY_WINDOW);
}

/** Every candidate's salience in the spectrum `y`; returns the strongest candidate. */
function saliences(st, y) {
  const { sal } = st;
  let best = 0;
  for (let j = 0; j < CANDIDATES; j++) {
    let s = 0;
    const base = j * MAX_HARMONICS;
    for (let m = 0; m < nHarm[j]; m++) {
      let top = 0;
      for (let k = lo[base + m]; k <= hi[base + m]; k++) if (y[k] > top) top = y[k];
      s += weight[base + m] * top;
    }
    sal[j] = s;
    if (s > sal[best]) best = j;
  }
  return best;
}

/**
 * The pitches sounding in the window that starts at `start`: [{ hz, s (salience), a (about how
 * loud that sound is) }], strongest first, at most MAX_VOICES; and the window's loudness.
 */
export function pitchesAt(st, x, start, maxVoices = MAX_VOICES, stop = true) {
  const rms = spectrum(st, x, start);
  const { mag, flat, rest, taken, sal, peakBin, peakAmp } = st;
  const found = [];
  if (rms < 1e-5) return { rms, found, peak: 0 };
  rest.set(flat);
  taken.fill(0);
  let total = 0;
  let before = 0;
  let peak = 0;
  for (let n = 1; n <= maxVoices; n++) {
    const j = saliences(st, rest);
    const s = sal[j];
    if (n === 1) {
      // How far the strongest pitch stands above the usual candidate: high where something is
      // sung or played, near 1 in noise and breath (whatever the loudness or the voice's height).
      const sorted = Float64Array.from(sal).sort();
      peak = s / (sorted[sorted.length >> 1] || 1e-12);
    }
    // One more pitch counts only while the summed salience, shared among them, still grows.
    const now = (total + s) / n ** GAMMA;
    if (stop && n > 1 && now <= before) break;
    total += s;
    before = now;
    // Its harmonics: where each really lies and how loud.
    const base = j * MAX_HARMONICS;
    const count = nHarm[j];
    let fSum = 0;
    let wSum = 0;
    let power = 0;
    for (let m = 0; m < count; m++) {
      let k = lo[base + m];
      for (let q = k + 1; q <= hi[base + m]; q++) if (rest[q] > rest[k]) k = q;
      peakBin[m] = k;
      peakAmp[m] = rest[k];
      if (m < 8 && k > 1 && rest[k] >= rest[k - 1] && rest[k] >= rest[k + 1]) {
        // The top between bins (a parabola through three), as this harmonic's own frequency.
        const a = mag[k - 1], b2 = mag[k], c = mag[k + 1];
        const curve = a - 2 * b2 + c;
        const shift = curve < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curve)) : 0;
        const amp = weight[base + m] * rest[k];
        fSum += (amp * (k + shift) * BIN_HZ) / (m + 1);
        wSum += amp;
      }
      power += mag[k] * mag[k];
    }
    // Out of the spectrum they go. Where another sound's harmonic lies on one of these, that one
    // stands out above its neighbours: only as much as the neighbours have is this sound's
    // (a sound's harmonics rise and fall smoothly), the rest stays for the other sound.
    for (let m = 0; m < count; m++) {
      const a = peakAmp[m];
      const prev = m > 0 ? peakAmp[m - 1] : peakAmp[Math.min(count - 1, 1)];
      const next = m + 1 < count ? peakAmp[m + 1] : peakAmp[Math.max(0, m - 1)];
      const smooth = Math.max(Math.min(a, prev), Math.min(a, next), Math.min(prev, next)); // the middle of the three
      const out = Math.min(a, smooth * SMOOTH_OVER);
      const k = peakBin[m];
      for (let d = -3; d <= 3; d++) {
        const q = k + d;
        if (q < 1 || q > HALF) continue;
        taken[q] += out * LOBE[Math.abs(d)];
        rest[q] = Math.max(0, flat[q] - TAKE * taken[q]);
      }
    }
    const hz = wSum > 0 ? fSum / wSum : candHz[j];
    // A Hann window shows a sine of height A as A·N/4: back to the sound's own loudness.
    found.push({ hz, s, a: Math.sqrt(power / 2) * (4 / POLY_WINDOW) });
  }
  return { rms, found, peak };
}

/** The sample where frame k's window starts: its middle is the middle of the pitch tracker's frame k. */
export const polyStart = (k) => k * HOP + WINDOW / 2 - POLY_WINDOW / 2;

/** Frames for a whole 16 kHz signal: [{ rms, found: [{ hz, s, a }] }] every 10 ms. */
export function trackPitches(samples, { maxVoices = MAX_VOICES, onProgress = null, stop = true } = {}) {
  const st = polyState();
  const n = Math.max(0, Math.ceil(samples.length / HOP));
  const frames = new Array(n);
  for (let k = 0; k < n; k++) {
    frames[k] = pitchesAt(st, samples, polyStart(k), maxVoices, stop);
    if (onProgress && k % 200 === 0) onProgress(k / n);
  }
  return frames;
}
