// Synthetic singing for tests. The notes going in are known exactly, so what
// the analysis finds can be scored against them. Test-only code.

import { rng } from "../helpers.js";

export const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

// Vowel "아": formant centres and widths in Hz. Harmonics near a formant come
// out stronger than the fundamental, which is what tempts a pitch tracker
// into octave mistakes on low voices.
const FORMANTS = [[800, 90], [1200, 110], [2500, 160], [3400, 200]];

function formantGain(f) {
  let g = 0.06;
  for (const [c, b] of FORMANTS) g += 1 / (1 + ((f - c) / b) ** 2);
  return g;
}

/**
 * Renders notes as a voice-like signal.
 *
 * notes: [{ midi, dur, gap = 0, amp = 0.5, vibrato: { rate, depth } (depth in
 * semitones), slide: seconds at the end spent gliding to the next note,
 * dip: re-articulate the start (amplitude dips to this fraction for 50 ms) }]
 *
 * Returns { samples, rate, truth }, truth = [{ t, d, midi }] for the steady
 * part of every note (a slide's travel time belongs to no note).
 */
export function sing(notes, {
  rate = 16000, noise = 0, seed = 7, lead = 0.12, tail = 0.12, attack = 0.015, release = 0.025,
  harmonics = 24, jitter = 0.002, shimmer = 0.04, voice = true,
} = {}) {
  const r = rng(seed);
  let total = lead + tail;
  for (const n of notes) total += n.dur + (n.gap || 0);
  const len = Math.round(total * rate);
  const pitch = new Float64Array(len);
  const amp = new Float64Array(len);
  const truth = [];

  let t = lead;
  notes.forEach((n, i) => {
    const start = t;
    const end = t + n.dur;
    const next = notes[i + 1];
    const slide = next && !next.gap && !n.gap && n.slide ? n.slide : 0;
    const a = n.amp ?? 0.5;
    const s0 = Math.round(start * rate);
    const s1 = Math.round(end * rate);
    // Notes that run into each other (no gap) are sung legato: no amplitude break.
    // `syllable` (0..1) is a new syllable without stopping, like the l in 라라라:
    // the loudness sinks to that share around the boundary and comes back.
    const prevJoined = i > 0 && !(notes[i - 1].gap) && !n.dip;
    const nextJoined = next && !n.gap && !next.dip;
    const SYL = 0.025;
    for (let s = s0; s < s1 && s < len; s++) {
      const time = s / rate;
      let m = n.midi;
      if (n.vibrato) m += n.vibrato.depth * Math.sin(2 * Math.PI * n.vibrato.rate * (time - start));
      if (slide && time > end - slide) m += (next.midi - n.midi) * ((time - (end - slide)) / slide);
      pitch[s] = midiHz(m);
      let env = a;
      if (!prevJoined) env *= Math.min(1, (time - start) / attack);
      if (!nextJoined) env *= Math.min(1, (end - time) / release);
      if (n.dip && time - start < 0.05) env *= n.dip + (1 - n.dip) * ((time - start) / 0.05);
      if (n.syllable !== undefined && time - start < SYL) env *= n.syllable + (1 - n.syllable) * ((time - start) / SYL);
      if (next && next.syllable !== undefined && nextJoined && end - time < SYL) env *= next.syllable + (1 - next.syllable) * ((end - time) / SYL);
      amp[s] = Math.max(0, env);
    }
    // A slide travels during the end of this note; the next note starts where it lands.
    truth.push({ t: start, d: n.dur - slide, midi: n.midi });
    t = end + (n.gap || 0);
  });

  const out = new Float32Array(len);
  const hk = [];
  for (let k = 1; k <= harmonics; k++) hk.push({ k, phase: r() * Math.PI * 2 });
  let phase = 0;
  let wobble = 0;
  let shake = 0;
  for (let s = 0; s < len; s++) {
    const f = pitch[s];
    if (!f) {
      phase = 0;
      out[s] = noise ? (r() * 2 - 1) * noise : 0;
      continue;
    }
    // Slow random drift of pitch and loudness, the way a real voice wavers.
    wobble = wobble * 0.999 + (r() * 2 - 1) * 0.001;
    shake = shake * 0.995 + (r() * 2 - 1) * 0.005;
    const fNow = f * (1 + jitter * wobble * 30);
    phase += (2 * Math.PI * fNow) / rate;
    let v = 0;
    for (const { k, phase: p } of hk) {
      const fk = k * fNow;
      if (fk >= rate / 2 - 200) break;
      const g = voice ? formantGain(fk) / k ** 0.6 : 1 / k;
      v += g * Math.sin(k * phase + p);
    }
    out[s] = amp[s] * v * 0.35 * (1 + shimmer * shake * 20) + (noise ? (r() * 2 - 1) * noise : 0);
  }
  return { samples: out, rate, truth };
}

/** A plain sine, for the simplest cases. */
export function sine(freq, seconds, { rate = 16000, amp = 0.5, lead = 0.1 } = {}) {
  const len = Math.round((seconds + lead * 2) * rate);
  const out = new Float32Array(len);
  for (let s = Math.round(lead * rate); s < Math.round((lead + seconds) * rate); s++) out[s] = amp * Math.sin((2 * Math.PI * freq * s) / rate);
  return { samples: out, rate, truth: [{ t: lead, d: seconds, midi: 69 + 12 * Math.log2(freq / 440) }] };
}

/**
 * Scores found notes against the truth. Every true note is matched to the found
 * note it overlaps most. Returns per-note results and the notes nobody asked for.
 */
export function score(found, truth) {
  const used = new Set();
  const matches = truth.map((want) => {
    let best = null;
    let bestOverlap = 0;
    found.forEach((got, i) => {
      const overlap = Math.min(want.t + want.d, got.t + got.d) - Math.max(want.t, got.t);
      if (overlap > bestOverlap) { bestOverlap = overlap; best = i; }
    });
    if (best === null) return { want, got: null, pitchOk: false, onsetErr: Infinity };
    used.add(best);
    const got = found[best];
    return { want, got, pitchOk: got.p === Math.round(want.midi), onsetErr: Math.abs(got.t - want.t), durErr: Math.abs(got.d - want.d) };
  });
  const extra = found.filter((_, i) => !used.has(i));
  return { matches, extra, allPitches: matches.every((m) => m.pitchOk) };
}
