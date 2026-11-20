// Notes from a pitch contour (SwiftF0's frames: pitch, confidence, loudness every 16 ms).
//
// The base is SwiftF0's `segment_notes` (MIT License, Copyright (c) 2025-2026 Lars Nieradzik,
// https://github.com/lars76/swift-f0; THIRD_PARTY.md): the frames are split into notes and gaps with the
// smallest total cost, found exactly by dynamic programming:
//
//   J = Σ over notes [ β(start) + Σ over its frames (offpitch + unvoiced + quiet) ],  gaps cost nothing
//   offpitch = confidence × min(|pitch − μ|, 2 semitones)   (μ: the note's one pitch, a measured one)
//   unvoiced = −ln(c / (1 − c))                              (voiced frames pay for being left out)
//   quiet    = dB the frame lies more than 3 dB below the loudest frames within 64 ms on both sides
//
// What is ours: β, the price of a new note, depends on where it starts. Where a syllable starts — the
// sound comes back up after a dip, or the voice returns after a consonant — a note is cheap, even
// rewarded, so "라-라-라" on one pitch is three notes and a quick syllable keeps its own note; elsewhere a
// new note must earn its price by a held pitch change, so vibrato, scoops and a bend inside one breath
// stay one note. Nothing shorter than 40 ms is a note, and a sound alone must last 80 ms. A slide
// between two notes is cut where the two pitches pull equally (measured on 40 real songs, people mark
// the new note nearer the start of a slide than where it lands). (The idea of syllable starts as note starts:
// the phoneme-informed singing transcription of Yong et al. 2023 and the envelope onsets of Dynamic
// HumTrans 2024; both read, neither copied.)
// Pure computation.

export const SEG_FRAME = 0.016;
export const NOTE_PRICE_MS = 80; // a new pitch one semitone away becomes a note once it lasts longer than this
export const MIN_NOTE_MS = 40; // inside a line of notes
const ALONE_MS = 80; // a sound with nothing near it
const ONSET_BONUS = 1.35; // at a full syllable start the price becomes −0.35 β: the note is welcome

const FINE_HOP = 64; // 4 ms at 16 kHz
const FINE_WIN = 160; // 10 ms
const DIP_REACH_MS = 100; // the loudness on each side is the loudest within this
// A dip to 0.45 of the loudness on both sides (−7 dB) is a syllable sung again (the l of 라-라 sinks to
// about a third); vibrato swells and sinks only to about 0.55, so it is not.
const DIP_DB = -20 * Math.log10(0.45);

/**
 * Where syllables start, from the take itself (finer than the frames' 32 ms loudness): for each
 * 16 ms frame, how deep (dB) the deepest loudness dip just before it sank below the loudness on both
 * sides (4 ms steps, 10 ms windows, ±100 ms). 0 where there is none.
 */
export function syllableDips(samples, rate, nFrames, frame = SEG_FRAME) {
  const per = rate / 16000;
  const hop = Math.max(1, Math.round(FINE_HOP * per));
  const win = Math.max(2, Math.round(FINE_WIN * per));
  const n = Math.floor(samples.length / hop);
  const env = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = i * hop;
    let e = 0, k = 0;
    for (let j = Math.max(0, c - win / 2); j < Math.min(samples.length, c + win / 2); j++, k++) e += samples[j] * samples[j];
    env[i] = Math.sqrt(e / Math.max(1, k)) + 1e-7;
  }
  const reach = Math.round(DIP_REACH_MS / 1000 * rate / hop);
  const out = new Float32Array(nFrames);
  for (let i = 1; i < n - 1; i++) {
    if (!(env[i] <= env[i - 1] && env[i] <= env[i + 1])) continue;
    let before = 0, after = 0;
    for (let j = Math.max(0, i - reach); j < i; j++) if (env[j] > before) before = env[j];
    for (let j = i + 1; j <= Math.min(n - 1, i + reach); j++) if (env[j] > after) after = env[j];
    const depth = 20 * Math.log10(Math.min(before, after) / env[i]);
    if (depth < DIP_DB - 2) continue;
    // The syllable starts in the frame after the bottom of the dip.
    const f = Math.min(nFrames - 1, Math.floor((i * hop) / rate / frame) + 1);
    if (depth > out[f]) out[f] = depth;
  }
  return out;
}

/** The normalized square difference (McLeod) of x at a lag around position c: 1 = repeats exactly. */
function nsdf(x, c, lag, half) {
  let best = -1;
  for (const L of [Math.floor(lag), Math.ceil(lag)]) {
    let num = 0, den = 0;
    const a = Math.max(0, c - half), b = Math.min(x.length - L, c + half);
    for (let i = a; i < b; i++) { num += x[i] * x[i + L]; den += x[i] * x[i] + x[i + L] * x[i + L]; }
    const r = den > 0 ? (2 * num) / den : 0;
    if (r > best) best = r;
  }
  return best;
}

/**
 * Pitch on a harmonic, put right: where the sound does not repeat at the period of the pitch read
 * (a voice whose fundamental is weak against its formants, read at 1.5 to 6 times its pitch) but
 * repeats strongly at a multiple of that period, the pitch is the lower one (the smallest such multiple). Changes `hz` in place;
 * returns how many frames changed.
 */
export function checkPeriods(samples16k, frames) {
  const { hz, conf } = frames;
  let changed = 0;
  for (let t = 0; t < hz.length; t++) {
    if (!(conf[t] >= 0.3) || !(hz[t] > 0)) continue;
    const lag = 16000 / hz[t];
    const c = t * 256;
    const half = Math.max(256, Math.ceil(lag * 6));
    const own = nsdf(samples16k, c, lag, half);
    if (own >= 0.5) continue;
    for (const m of [1.5, 2, 2.5, 3, 4, 5, 6]) {
      if (hz[t] / m < 46.875) break;
      const r = nsdf(samples16k, c, lag * m, half);
      if (r >= 0.8 && r - own >= 0.3) { hz[t] /= m; changed++; break; }
    }
  }
  return changed;
}

/**
 * How much each frame looks like the start of a syllable, 0..1: the loudness coming back up from a
 * dip within the last 64 ms (12 dB → 1), or the voice's confidence coming back (0.6 → 1), at the first
 * frame that is voiced again. Only the peak within ±80 ms counts, so one start is one cheap place.
 */
export function onsetStrength({ db, conf, dips }) {
  const n = db.length;
  const raw = new Float32Array(n);
  if (dips) for (let t = 0; t < n; t++) if (conf[t] >= 0.3 && dips[t] > 0) raw[t] = Math.min(1, Math.max(0, (dips[t] - (DIP_DB - 3)) / 4));
  for (let t = 1; t < n; t++) {
    if (conf[t] < 0.3) continue; // a start is where the voice is
    let lowDb = Infinity, lowC = Infinity;
    for (let k = Math.max(0, t - 4); k < t; k++) { if (db[k] < lowDb) lowDb = db[k]; if (conf[k] < lowC) lowC = conf[k]; }
    raw[t] = Math.max(raw[t], Math.min(1, Math.max(0, (db[t] - lowDb - 3) / 9, (conf[t] - lowC - 0.15) / 0.45)));
  }
  const out = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    let peak = true;
    for (let k = Math.max(0, t - 5); k <= Math.min(n - 1, t + 5); k++) if (raw[k] > raw[t] || (raw[k] === raw[t] && k < t)) { peak = false; break; }
    if (peak) out[t] = raw[t];
  }
  return out;
}

/**
 * Notes: [{ t, d, m (semitones, float: the note's pitch), c (mean confidence), level (mean dB),
 * spread (confidence-weighted mean distance of the frames from m, semitones), onset (how clearly it
 * began a syllable) }], in time order.
 */
export function segmentPitch(frames, { price = NOTE_PRICE_MS, minMs = MIN_NOTE_MS, onsets = true } = {}) {
  const { hz, conf, db } = frames;
  const F = frames.frame || SEG_FRAME;
  const n = hz.length;
  const m = new Float64Array(n);
  const w = new Float64Array(n);
  let anyVoiced = false;
  for (let t = 0; t < n; t++) {
    const ok = Number.isFinite(hz[t]) && hz[t] > 0;
    if (ok) { m[t] = 69 + 12 * Math.log2(hz[t] / 440); w[t] = conf[t]; anyVoiced = true; }
  }
  if (!anyVoiced) return [];
  // Per-frame costs of being inside a note.
  const q = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const cc = Math.min(0.99, Math.max(0.01, w[t]));
    let left = -Infinity, right = -Infinity;
    for (let j = 0; j < 5; j++) {
      const a = t - 4 + j, b = t + j;
      const la = db[a < 0 ? -a - 1 : a >= n ? 2 * n - a - 1 : a];
      const lb = db[b < 0 ? -b - 1 : b >= n ? 2 * n - b - 1 : b];
      if (la > left) left = la;
      if (lb > right) right = lb;
    }
    q[t] = -Math.log(cc / (1 - cc)) + Math.max(0, Math.min(left, right) - db[t] - 10 * Math.log10(2));
  }
  // The candidate pitches: every measured pitch, to the cent.
  const set = new Set();
  for (let t = 0; t < n; t++) if (w[t] > 0 || hz[t] > 0) set.add(Math.floor(m[t] * 100 + 0.5));
  const mu = Float64Array.from([...set].sort((a, b) => a - b), (c) => c / 100);
  const K = mu.length;
  const beta = price / 1000 / F;
  const on = onsets ? onsetStrength(frames) : null;
  const vn = new Float64Array(K).fill(Infinity);
  const noteStart = new Int32Array(K);
  const back = new Int32Array(n + 1);
  const kind = new Int32Array(n + 1).fill(-1);
  let best = 0;
  for (let t = 0; t < n; t++) {
    const start = best + (on ? beta * (1 - ONSET_BONUS * on[t]) : beta);
    const mt = m[t], wt = w[t], qt = q[t];
    let jBest = -1, vBest = Infinity;
    for (let j = 0; j < K; j++) {
      if (start < vn[j]) { vn[j] = start; noteStart[j] = t; }
      let d = mu[j] - mt;
      if (d < 0) d = -d;
      if (d > 2) d = 2;
      const v = (vn[j] += d * wt + qt);
      if (v < vBest) { vBest = v; jBest = j; }
    }
    if (vBest < best) { best = vBest; back[t + 1] = noteStart[jBest]; kind[t + 1] = jBest; }
    else back[t + 1] = t;
  }
  const notes = [];
  for (let b = n; b > 0;) {
    const a = back[b];
    if (kind[b] >= 0) notes.push({ a, b, m: mu[kind[b]] });
    b = a;
  }
  notes.reverse();
  const out = [];
  for (const { a, b, m: pitch } of notes) {
    if ((b - a) * F * 1000 < minMs) continue;
    let cs = 0, ls = 0, sp = 0, ws = 0, onset = 0;
    for (let t = a; t < b; t++) {
      cs += conf[t]; ls += db[t];
      if (w[t] > 0) { sp += Math.min(2, Math.abs(m[t] - pitch)) * w[t]; ws += w[t]; }
      if (on && t < a + 3 && on[t] > onset) onset = on[t];
    }
    out.push({ t: a * F, d: (b - a) * F, m: pitch, c: cs / (b - a), level: ls / (b - a), spread: ws > 0 ? sp / ws : 2, onset });
  }
  // A short sound standing alone (nothing within 100 ms on either side) is a blip, not a note, under 80 ms.
  return out.filter((n, i) => {
    if (n.d >= ALONE_MS / 1000) return true;
    const before = i > 0 ? n.t - (out[i - 1].t + out[i - 1].d) : Infinity;
    const after = i < out.length - 1 ? out[i + 1].t - (n.t + n.d) : Infinity;
    return !(before >= 0.1 && after >= 0.1);
  });
}
