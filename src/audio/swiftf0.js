// SwiftF0 in plain JS: a small neural network that reads the pitch of one voice (or any one pitched
// sound) from a spectrogram, with a confidence for every 16 ms. Ported from the ONNX model of
// swift-f0 0.3.0 (MIT License, Copyright (c) 2025-2026 Lars Nieradzik, https://github.com/lars76/swift-f0;
// see THIRD_PARTY.md). In the public pitch benchmark it was the best of 19 trackers (pitch F1 0.78;
// pYIN 0.51), for speech and singing alike, which is why the hummed and spoken takes go through it.
//
// What the model does, step by step (the same arithmetic as the ONNX graph):
//   1. three spectrograms of the 16 kHz audio, windows of 512, 1024 and 2048 samples (periodic Hann),
//      all centred every 256 samples (zeros outside the take), magnitudes → 128 log-frequency bands
//      each → log(x + 1e-8): an image of 3 channels × 128 bands × frames;
//   2. a 3×3 convolution to 12 channels and six residual blocks (7×3; 7×1, 5×1, 3×1, 3×1 with
//      dilations 17, 27, 40, 48 bands, which reach across harmonics; 7×3 dilated 2 in frequency);
//   3. the lowest 96 bands → a 3×3 convolution to 4 channels → 95 pitch logits per frame (1×1) and,
//      from their strongest band and the spectrogram's mean level, a confidence (sigmoid);
//   4. the pitch is the softmax-weighted mean of the log-frequencies of the best step and its two
//      neighbours (95 steps from 46.875 Hz to 2093.75 Hz, equal ratios).
// Pure computation: no browser audio, no network.

import { SWIFT_LAYERS, SWIFT_WEIGHTS, SWIFT_BANKS } from "./swiftf0-weights.js";
import { fromBase64 } from "../core/b64.js";
import { makeFft } from "./fft.js";
import { resample } from "./dsp.js";

export const SWIFT_RATE = 16000;
export const SWIFT_HOP = 256;
export const SWIFT_FRAME = SWIFT_HOP / SWIFT_RATE;
export const SWIFT_FMIN = 46.875;
export const SWIFT_FMAX = 2093.75;
export const SWIFT_STEPS = 95;
const BANDS = 128;
const SILENCE_PEAK = 1e-3; // digital silence answers with random voiced frames: those get confidence 0
const LOOK = 10; // frames after a window that still change it (half the 2048 window plus seven frames)
const LEFT = 11;
const WINDOW = 1875; // 30 s per pass keeps the working memory small

const floats = (b64) => { const u = fromBase64(b64); return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4); };
let model = null;
function load() {
  if (model) return model;
  const w = floats(SWIFT_WEIGHTS);
  const banks = [512, 1024, 2048].map((size) => {
    const b = SWIFT_BANKS["fb" + size];
    const binU = fromBase64(b.bin);
    return {
      size,
      fft: makeFft(size),
      win: Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)),
      bin: new Uint16Array(binU.buffer, binU.byteOffset, binU.byteLength / 2),
      band: fromBase64(b.band),
      w: floats(b.w),
      re: new Float64Array(size),
      im: new Float64Array(size),
      mag: new Float64Array(size / 2 + 1),
    };
  });
  const ratio = (SWIFT_FMAX / SWIFT_FMIN) ** (1 / (SWIFT_STEPS - 1));
  const stepHz = Float64Array.from({ length: SWIFT_STEPS }, (_, i) => Math.fround(SWIFT_FMIN * ratio ** i));
  stepHz[SWIFT_STEPS - 1] = SWIFT_FMAX;
  const stepLog = Float64Array.from({ length: SWIFT_STEPS }, (_, i) => Math.log(SWIFT_FMIN * ratio ** i));
  model = { w, banks, stepHz, stepLog, layers: {} };
  return model;
}

/** The spectrogram image, [band][frame][channel], channels in the model's order (1024, 2048, 512). */
function spectrogram(x, n) {
  const { banks } = load();
  const out = new Float32Array(BANDS * n * 3);
  const order = [1, 2, 0]; // the model stacks the 1024, the 2048 and then the 512 window
  const band = new Float64Array(BANDS);
  order.forEach((bi, c) => {
    const bk = banks[bi];
    const half = bk.size / 2;
    for (let f = 0; f < n; f++) {
      const start = f * SWIFT_HOP - half;
      for (let i = 0; i < bk.size; i++) {
        const s = start + i;
        bk.re[i] = s >= 0 && s < x.length ? x[s] * bk.win[i] : 0;
        bk.im[i] = 0;
      }
      bk.fft.forward(bk.re, bk.im);
      for (let k = 0; k <= half; k++) bk.mag[k] = Math.sqrt(bk.re[k] * bk.re[k] + bk.im[k] * bk.im[k]);
      band.fill(0);
      for (let e = 0; e < bk.w.length; e++) band[bk.band[e]] += bk.w[e] * bk.mag[bk.bin[e]];
      for (let b = 0; b < BANDS; b++) out[(b * n + f) * 3 + c] = Math.log(band[b] + 1e-8);
    }
  });
  return out;
}

/** A layer's weights rearranged as [kernel row][kernel column][in channel][out channel] (once). */
function weightsOf(name) {
  const m = load();
  if (m.layers[name]) return m.layers[name];
  const [shape, ws, bs] = SWIFT_LAYERS[name];
  // A 1-D layer ([out, in, k]) runs as a 2-D one over a single band.
  const [O, C, KH, KW] = shape.length === 3 ? [shape[0], shape[1], 1, shape[2]] : shape;
  const k = new Float32Array(O * C * KH * KW);
  for (let o = 0; o < O; o++) for (let c = 0; c < C; c++) for (let i = 0; i < KH; i++) for (let j = 0; j < KW; j++)
    k[((i * KW + j) * C + c) * O + o] = m.w[ws + ((o * C + c) * KH + i) * KW + j];
  const bias = m.w.slice(bs, bs + O);
  return (m.layers[name] = { O, C, KH, KW, k, bias });
}

/**
 * A 2-D convolution, as ONNX's Conv with zero padding, over [H][W][C] (H: bands, W: frames):
 * pads = [top, left, bottom, right], dilation [dh, dw]. Returns [H2][W2][O]. Each input value is read
 * once per kernel tap and added into all the output channels at once; zeros (after ReLU) are skipped.
 */
function conv2d(inp, C, H, Wd, name, { pad = [0, 0, 0, 0], dil = [1, 1] } = {}) {
  const L = weightsOf(name);
  if (L.C !== C) throw new Error("swiftf0: channels do not fit " + name);
  const { O, KH, KW, k, bias } = L;
  const [pt, pl, pb, pr] = pad;
  const [dh, dw] = dil;
  const H2 = H + pt + pb - dh * (KH - 1);
  const W2 = Wd + pl + pr - dw * (KW - 1);
  const out = new Float32Array(H2 * W2 * O);
  if (O === 12) {
    const b0 = bias[0], b1 = bias[1], b2 = bias[2], b3 = bias[3], b4 = bias[4], b5 = bias[5];
    const b6 = bias[6], b7 = bias[7], b8 = bias[8], b9 = bias[9], b10 = bias[10], b11 = bias[11];
    for (let y = 0; y < H2; y++) {
      for (let x = 0; x < W2; x++) {
        let a0 = b0, a1 = b1, a2 = b2, a3 = b3, a4 = b4, a5 = b5, a6 = b6, a7 = b7, a8 = b8, a9 = b9, a10 = b10, a11 = b11;
        for (let i = 0; i < KH; i++) {
          const yy = y + i * dh - pt;
          if (yy < 0 || yy >= H) continue;
          for (let j = 0; j < KW; j++) {
            const xx = x + j * dw - pl;
            if (xx < 0 || xx >= Wd) continue;
            const ib = (yy * Wd + xx) * C;
            let kb = (i * KW + j) * C * 12;
            for (let c = 0; c < C; c++, kb += 12) {
              const v = inp[ib + c];
              if (v === 0) continue;
              a0 += k[kb] * v; a1 += k[kb + 1] * v; a2 += k[kb + 2] * v; a3 += k[kb + 3] * v;
              a4 += k[kb + 4] * v; a5 += k[kb + 5] * v; a6 += k[kb + 6] * v; a7 += k[kb + 7] * v;
              a8 += k[kb + 8] * v; a9 += k[kb + 9] * v; a10 += k[kb + 10] * v; a11 += k[kb + 11] * v;
            }
          }
        }
        const ob = (y * W2 + x) * 12;
        out[ob] = a0; out[ob + 1] = a1; out[ob + 2] = a2; out[ob + 3] = a3; out[ob + 4] = a4; out[ob + 5] = a5;
        out[ob + 6] = a6; out[ob + 7] = a7; out[ob + 8] = a8; out[ob + 9] = a9; out[ob + 10] = a10; out[ob + 11] = a11;
      }
    }
    return { out, H: H2, W: W2 };
  }
  const acc = new Float64Array(O);
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      for (let o = 0; o < O; o++) acc[o] = bias[o];
      for (let i = 0; i < KH; i++) {
        const yy = y + i * dh - pt;
        if (yy < 0 || yy >= H) continue;
        for (let j = 0; j < KW; j++) {
          const xx = x + j * dw - pl;
          if (xx < 0 || xx >= Wd) continue;
          const ib = (yy * Wd + xx) * C;
          let kb = (i * KW + j) * C * O;
          for (let c = 0; c < C; c++, kb += O) {
            const v = inp[ib + c];
            if (v === 0) continue;
            for (let o = 0; o < O; o++) acc[o] += k[kb + o] * v;
          }
        }
      }
      const ob = (y * W2 + x) * O;
      for (let o = 0; o < O; o++) out[ob + o] = acc[o];
    }
  }
  return { out, H: H2, W: W2 };
}

const relu = (a) => { for (let i = 0; i < a.length; i++) if (a[i] < 0) a[i] = 0; return a; };

/** a = relu(a + conv2(relu(conv1(a)))) */
function block(a, H, Wd, n1, n2, opts) {
  const t = conv2d(a, 12, H, Wd, n1, opts);
  relu(t.out);
  const u = conv2d(t.out, 12, H, Wd, n2, opts);
  for (let i = 0; i < a.length; i++) { const v = a[i] + u.out[i]; a[i] = v > 0 ? v : 0; }
  return a;
}

/** The model on one stretch of 16 kHz audio: per frame (every 256 samples) pitch in Hz and confidence. */
function runModel(x, fmin, fmax) {
  const { stepHz, stepLog } = load();
  const n = Math.max(1, Math.floor(x.length / SWIFT_HOP));
  const spec = spectrogram(x, n);
  let a = relu(conv2d(spec, 3, BANDS, n, "conv1", { pad: [1, 1, 1, 1] }).out);
  a = block(a, BANDS, n, "a1", "a2", { pad: [3, 1, 3, 1] });
  a = block(a, BANDS, n, "b1", "b2", { pad: [51, 0, 51, 0], dil: [17, 1] });
  a = block(a, BANDS, n, "c1", "c2", { pad: [54, 0, 54, 0], dil: [27, 1] });
  a = block(a, BANDS, n, "d1", "d2", { pad: [40, 0, 40, 0], dil: [40, 1] });
  a = block(a, BANDS, n, "e1", "e2", { pad: [48, 0, 48, 0], dil: [48, 1] });
  a = block(a, BANDS, n, "f1", "f2", { pad: [6, 1, 6, 1], dil: [2, 1] });
  // The lowest 96 bands: in [band][frame][channel] order they are simply the front of the tensor.
  const low = a.subarray(0, 96 * n * 12);
  const h = relu(conv2d(low, 12, 96, n, "head", { pad: [1, 1, 0, 1] }).out); // [95][n][4]
  const logits = conv2d(h, 4, SWIFT_STEPS, n, "pitch").out; // [95][n][1]
  const c2 = conv2d(h, 4, SWIFT_STEPS, n, "conf2d", { pad: [2, 0, 2, 0] }).out; // [95][n][4]
  // The confidence: each channel's strongest step and the spectrogram's mean level, then two 1-D convolutions.
  const feat = new Float32Array(n * 5); // [1][n][5]
  for (let f = 0; f < n; f++) {
    for (let c = 0; c < 4; c++) {
      let m = -Infinity;
      for (let s = 0; s < SWIFT_STEPS; s++) { const v = c2[(s * n + f) * 4 + c]; if (v > m) m = v; }
      feat[f * 5 + c] = m;
    }
    let sum = 0;
    for (let b = 0; b < BANDS; b++) { const o = (b * n + f) * 3; sum += spec[o] + spec[o + 1] + spec[o + 2]; }
    feat[f * 5 + 4] = sum / (3 * BANDS);
  }
  const g = relu(conv2d(feat, 5, 1, n, "conf1a", { pad: [0, 1, 0, 1] }).out); // a 1×3 kernel over [1][n][5]
  const cl = conv2d(g, 16, 1, n, "conf1b").out;
  const hz = new Float32Array(n);
  const conf = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let best = -1, bestV = -Infinity, rawBest = 0, rawV = -Infinity;
    for (let s = 0; s < SWIFT_STEPS; s++) {
      const v = logits[s * n + f];
      if (v > rawV) { rawV = v; rawBest = s; }
      if (stepHz[s] >= fmin && stepHz[s] <= fmax && v > bestV) { bestV = v; best = s; }
    }
    let num = 0, den = 0;
    for (let d = -1; d <= 1; d++) {
      const s = best + d;
      if (s < 0 || s >= SWIFT_STEPS || !(stepHz[s] >= fmin && stepHz[s] <= fmax)) continue;
      const e = Math.exp(logits[s * n + f] - bestV);
      num += e * stepLog[s];
      den += e;
    }
    hz[f] = Math.exp(num / den);
    const inRange = stepHz[rawBest] >= fmin && stepHz[rawBest] <= fmax;
    conf[f] = inRange ? 1 / (1 + Math.exp(-cl[f])) : 0;
  }
  // Silence and loudness: the 256 samples after each frame's centre, and the 32 ms around it.
  const db = new Float32Array(n);
  let prev = 0;
  for (let f = 0; f < n; f++) {
    const from = x.length >= SWIFT_HOP ? f * SWIFT_HOP : 0;
    const to = x.length >= SWIFT_HOP ? from + SWIFT_HOP : x.length;
    let peak = 0, power = 0;
    for (let i = from; i < to; i++) { const v = x[i]; power += v * v; const av = v < 0 ? -v : v; if (av > peak) peak = av; }
    if (peak < SILENCE_PEAK) conf[f] = 0;
    db[f] = 20 * Math.log10(Math.max(Math.sqrt((prev + power) / 512), 1e-7));
    prev = power;
  }
  return { hz, conf, db };
}

/** The model on 16 kHz audio in one pass (short sounds; tests). */
export function swiftPitch(x16k, { fmin = SWIFT_FMIN, fmax = SWIFT_FMAX } = {}) {
  return runModel(x16k, Math.fround(fmin), Math.fround(fmax));
}

/** The windows a take is worked through in: each with the frames it needs on both sides. */
function* windowsOf(x, n, size) {
  for (let start = 0; start < n; start += size) {
    const end = Math.min(start + size, n);
    const left = Math.max(0, start - LEFT);
    const piece = end < n ? x.subarray(left * SWIFT_HOP, (end + LOOK) * SWIFT_HOP) : x.subarray(left * SWIFT_HOP);
    yield { start, end, left, piece };
  }
}

function prepare(samples, rate) {
  const x = rate === SWIFT_RATE ? samples : resample(samples, rate, SWIFT_RATE);
  const n = Math.max(1, Math.floor(x.length / SWIFT_HOP));
  return { x, n, out: { hz: new Float32Array(n), conf: new Float32Array(n), db: new Float32Array(n), frame: SWIFT_FRAME } };
}

function place(out, r, { start, end, left }) {
  out.hz.set(r.hz.subarray(start - left, end - left), start);
  out.conf.set(r.conf.subarray(start - left, end - left), start);
  out.db.set(r.db.subarray(start - left, end - left), start);
}

/**
 * Pitch, confidence (voiced when ≥ 0.5) and loudness (dB) every 16 ms of a take at any rate. Long
 * takes are worked through 30 s at a time with the frames each window needs on both sides, so the
 * result is the same as one pass. `onProgress(0..1)` after each window.
 */
export function swiftF0(samples, rate, { fmin = SWIFT_FMIN, fmax = SWIFT_FMAX, onProgress = () => {} } = {}) {
  const { x, n, out } = prepare(samples, rate);
  for (const w of windowsOf(x, n, WINDOW)) {
    place(out, runModel(w.piece, Math.fround(fmin), Math.fround(fmax)), w);
    onProgress(w.end / n);
  }
  return out;
}

/** The same, a few seconds at a time, awaiting `pause()` between them so a page stays responsive. */
export async function swiftF0Async(samples, rate, { fmin = SWIFT_FMIN, fmax = SWIFT_FMAX, onProgress = () => {}, pause = () => Promise.resolve(), seconds = 4 } = {}) {
  const { x, n, out } = prepare(samples, rate);
  const size = Math.max(32, Math.round(seconds / SWIFT_FRAME));
  for (const w of windowsOf(x, n, size)) {
    place(out, runModel(w.piece, Math.fround(fmin), Math.fround(fmax)), w);
    onProgress(w.end / n);
    await pause();
  }
  return out;
}
