// Beats: a song's tempo and meter, bars, the grid, and putting notes on it, as
// pro apps (GarageBand, Logic, BandLab) do. Pure functions; times in ms.
//
// A tempo is { bpm, beats, unit }: `bpm` counts the meter's unit (in 6/8 the
// beat is an eighth), `beats` per bar. A grid is a note value: 4 = quarter
// notes, 8 = eighths, 16 = sixteenths.

export const METERS = [[2, 4], [3, 4], [4, 4], [6, 8]];
export const GRIDS = [4, 8, 16];
export const MIN_BPM = 30;
export const MAX_BPM = 300;

export function beatMs(tempo) {
  return 60000 / tempo.bpm;
}

/** One grid step (a note value) in ms. */
export function stepMs(tempo, grid) {
  return (beatMs(tempo) * tempo.unit) / grid;
}

export function barMs(tempo) {
  return beatMs(tempo) * tempo.beats;
}

/** Bar and beat at a time, counted from 1. */
export function barBeat(ms, tempo) {
  const b = Math.floor(ms / beatMs(tempo) + 1e-6);
  return { bar: Math.floor(b / tempo.beats) + 1, beat: (b % tempo.beats) + 1 };
}

/** Metronome clicks in [from, until): { at, accent } with the first beat of each bar accented. */
export function clicksIn(from, until, tempo) {
  const beat = beatMs(tempo);
  const out = [];
  for (let k = Math.max(0, Math.ceil(from / beat - 1e-9)); k * beat < until; k++) out.push({ at: Math.round(k * beat * 1000) / 1000, accent: k % tempo.beats === 0 });
  return out;
}

export function snapMs(ms, step) {
  return Math.round(ms / step) * step;
}

/**
 * 박자 맞추기 (quantize): each note's start and end go to the nearest grid step.
 * A note stays at least one step long and starts after the one before it (one
 * voice sings one note at a time); the one before ends where it starts.
 * notes: [{ t, d, … }] in ms. Returns new notes, sorted by start, other fields kept.
 */
export function quantizeNotes(notes, step) {
  const out = [];
  for (const n of [...notes].sort((a, b) => a.t - b.t)) {
    const prev = out[out.length - 1];
    let t = snapMs(n.t, step);
    if (prev && t <= prev.t) t = prev.t + step;
    const end = Math.max(t + step, snapMs(n.t + n.d, step));
    if (prev && prev.t + prev.d > t) prev.d = t - prev.t;
    out.push({ ...n, t, d: end - t });
  }
  return out.map((n) => ({ ...n, t: Math.round(n.t), d: Math.max(1, Math.round(n.d)) }));
}

/**
 * The tempo of sung notes from their starts (ms), or null with too few. For each
 * tempo from 70 to 150 BPM: how well the starts line up on its beats and on its
 * half-beats, whatever the phase; the best wins.
 */
export function estimateTempo(starts) {
  if (starts.length < 4) return null;
  const fit = (period) => {
    let re = 0;
    let im = 0;
    for (const t of starts) {
      const a = (2 * Math.PI * t) / period;
      re += Math.cos(a);
      im += Math.sin(a);
    }
    return Math.hypot(re, im) / starts.length;
  };
  let best = null;
  for (let bpm = 70; bpm <= 150; bpm += 0.5) {
    const beat = 60000 / bpm;
    const score = fit(beat) + 0.5 * fit(beat / 2);
    if (!best || score > best.score) best = { bpm, score };
  }
  return Math.round(best.bpm);
}

/** Tap tempo: the average gap between taps (ms), leaving out pauses and double taps; null with fewer than two. */
export function tapTempo(times) {
  if (times.length < 2) return null;
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const mid = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  const kept = gaps.filter((g) => g < mid * 1.6 && g > mid / 1.6);
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  return Math.round(Math.min(MAX_BPM, Math.max(MIN_BPM, 60000 / mean)));
}
