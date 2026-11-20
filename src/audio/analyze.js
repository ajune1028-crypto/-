// Recording in, notes out: mixes the pieces above into one step that can run
// live while someone sings, or over a whole file. Pure computation.

import { StreamResampler, resample, concealDropouts } from "./dsp.js";
import { ANALYSIS_RATE, PitchTracker } from "./pitch.js";
import { segmentNotes } from "./notes.js";
import { PeakCollector } from "./peaks.js";
import { fillPitches, frameCount, polyState, POLY_WINDOW } from "./poly.js";
import { chordNotes, agreement, tuneWithHarmony } from "./chords.js";
import { swiftF0Async } from "./swiftf0.js";
import { segmentPitch, checkPeriods, syllableDips } from "./segment.js";
import { intendedKeys } from "./intent.js";

// A take with harmony under less than this share of its tune is one voice alone: it is read by
// the pitch tracker, which hears a single voice best (measured on 40 real solo takes: the
// several-pitches path finds "harmony" in at most a tenth of a solo take's time, a mix has more).
export const SOLO_LIMIT = 0.2;
const SAME_TUNE = 0.75; // the pitch tracker's notes lie on this much of the tune found among several pitches: it followed the tune
const WHOLE_FRAMES = 4000; // takes up to 40 s are looked through whole…
const PROBE_FRAMES = 1000; // …longer ones first in three 10 s pieces
const PROBES = [0.04, 0.45, 0.86];
const STEP_FRAMES = 100; // frames worked out between two breaths of the page

/**
 * Feed it samples at the recording's own rate, as they arrive. `notes()` is
 * the best guess so far (for showing notes while singing); `finish()` gives
 * the final notes, the waveform summary and the length.
 */
export class Analyzer {
  constructor(rate) {
    this.rate = rate;
    this.resampler = new StreamResampler(rate, ANALYSIS_RATE);
    this.tracker = new PitchTracker();
    this.peaks = new PeakCollector(rate);
    this.frames = [];
    this.count = 0;
    this.cache = null;
    this.kept = []; // the take at the analysis rate, for the look for several pitches at the end
    this.done = null;
  }

  push(samples) {
    this.count += samples.length;
    this.peaks.push(samples);
    const low = this.resampler.push(samples);
    if (low.length) this.kept.push(Float32Array.from(low));
    for (const f of this.tracker.push(low)) this.frames.push(f);
  }

  get seconds() {
    return this.count / this.rate;
  }

  /** Notes so far. Recomputed at most once per new batch of frames. */
  notes() {
    if (!this.cache || this.cache.n !== this.frames.length) this.cache = { n: this.frames.length, notes: segmentNotes(this.frames) };
    return this.cache.notes;
  }

  /** One voice's notes (quick: the pitch tracker has been following all along). */
  finish() {
    if (this.done) return this.done;
    const tail = this.resampler.flush();
    if (tail.length) this.kept.push(Float32Array.from(tail));
    for (const f of this.tracker.push(tail)) this.frames.push(f);
    for (const f of this.tracker.flush()) this.frames.push(f);
    this.done = { notes: segmentNotes(this.frames), frames: this.frames, peaks: this.peaks.finish(), duration: this.seconds };
    return this.done;
  }

  /**
   * The final notes. The voice is read again, finely (SwiftF0, then notes by syllable and pitch,
   * then the keys meant: `voiceNotes`); each note keeps what was sung plainly as `s` where the key
   * meant differs, and the take its key as `scale`. Then the look for several pitches at once (a
   * voice over a guitar, two people, a song with its band): the tune and, marked `h`, the harmony
   * under it; `chords: true`. `onProgress` gets 0..1.
   */
  async finishAll({ onProgress = () => {} } = {}) {
    const result = this.finish();
    let total = 0;
    for (const part of this.kept) total += part.length;
    const whole = new Float32Array(total);
    let at = 0;
    for (const part of this.kept) { whole.set(part, at); at += part.length; }
    // Read with the moments the phone dropped filled in (the take itself is kept as it came).
    const low = concealDropouts(whole, ANALYSIS_RATE).samples;
    const voice = await voiceNotes(low, ANALYSIS_RATE, { onProgress: (p) => onProgress(VOICE_SHARE * p) });
    const solo = { ...result, notes: voice.notes, scale: voice.scale };
    const found = await chordsOf(low, { onProgress: (p) => onProgress(VOICE_SHARE + (1 - VOICE_SHARE) * p) });
    if (!found) return solo;
    // Where the tune is the voice that was read (the same line), its notes are the tune: they are
    // placed and parted more finely. The harmony comes from the look for several pitches. Where the
    // voice could not be followed (two voices, a loud band), that look gives both.
    const agree = agreement(found.notes.filter((n) => !n.h), solo.notes);
    const notes = agree >= SAME_TUNE ? tuneWithHarmony(solo.notes, found.notes) : found.notes;
    return { ...solo, notes, chords: true, agree };
  }
}

/**
 * Looks through a 16 kHz take for several pitches at once. Null for a voice alone; else
 * { notes (the tune, and the harmony marked `h`), harmony (its share beside the tune) }.
 */
export async function chordsOf(samples, { onProgress = () => {} } = {}) {
  const n = frameCount(samples);
  if (n < 20) return null;
  // Windows quieter than a twentieth of the take's loud parts are not looked at.
  const rms = [];
  for (let start = 0; start + POLY_WINDOW <= samples.length; start += POLY_WINDOW) {
    let e = 0;
    for (let i = start; i < start + POLY_WINDOW; i++) e += samples[i] * samples[i];
    rms.push(Math.sqrt(e / POLY_WINDOW));
  }
  rms.sort((a, b) => a - b);
  const gate = rms.length ? 0.05 * rms[Math.floor(0.95 * (rms.length - 1))] : 0;
  const frames = new Array(n);
  const st = polyState();
  let worked = 0;
  let planned = n;
  const fill = async (from, to) => {
    for (let k = from; k < to; k += STEP_FRAMES) {
      fillPitches(frames, samples, { from: k, to: Math.min(to, k + STEP_FRAMES), gate, st });
      worked += Math.min(to, k + STEP_FRAMES) - k;
      onProgress(Math.min(0.99, worked / planned));
      await pause();
    }
  };
  if (n > WHOLE_FRAMES) {
    // A long take: three pieces first. A voice alone in all three is a voice alone.
    planned = PROBES.length * PROBE_FRAMES;
    let most = 0;
    for (const at of PROBES) {
      const from = Math.floor((at * n) / 2) * 2;
      const to = Math.min(n, from + PROBE_FRAMES);
      await fill(from, to);
      most = Math.max(most, chordNotes(frames.slice(from, to)).harmony);
    }
    if (most < SOLO_LIMIT) return null;
    worked = 0;
    planned = n;
  }
  await fill(0, n);
  const found = chordNotes(frames);
  onProgress(1);
  if (found.harmony < SOLO_LIMIT || !found.notes.some((note) => !note.h)) return null;
  return { notes: found.notes, harmony: found.harmony };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const MONO_SHARE = 0.15; // of the progress shown: the first quick pass while the take is read in
const VOICE_SHARE = 0.55; // of the rest: the voice read finely; then the look for several pitches

/**
 * One voice's notes, as a listener would write them down: SwiftF0's pitch and confidence every
 * 16 ms, notes by syllable and held pitch (`segmentPitch`), the keys meant (`intendedKeys`).
 * Returns { notes: [{ t, d, p (key meant), v (0..1), s (the key sung plainly, where it differs) }],
 * scale: { tonic, minor } or null }.
 */
export async function voiceNotes(samples, rate, { onProgress = () => {}, periods = true, dips = true, segment = {} } = {}) {
  // A moment the phone dropped (zeros) would read as a new syllable: it is filled in first.
  const x = concealDropouts(rate === ANALYSIS_RATE ? samples : resample(samples, rate, ANALYSIS_RATE), ANALYSIS_RATE).samples;
  const frames = await swiftF0Async(x, ANALYSIS_RATE, { onProgress, pause });
  if (periods) checkPeriods(x, frames);
  if (dips) frames.dips = syllableDips(x, ANALYSIS_RATE, frames.hz.length);
  const parts = segmentPitch(frames, segment);
  if (!parts.length) return { notes: [], scale: null };
  const { keys, sung, tonic, minor } = intendedKeys(parts);
  const levels = parts.map((n) => n.level).sort((a, b) => a - b);
  const loud = levels[Math.ceil(0.9 * (levels.length - 1))];
  const notes = parts.map((n, i) => {
    const note = { t: n.t, d: n.d, p: keys[i], v: Math.min(1, Math.max(0.05, 10 ** ((n.level - loud) / 20))) };
    if (sung[i] !== keys[i]) note.s = sung[i];
    return note;
  });
  return { notes, scale: tonic === null ? null : { tonic, minor } };
}

/**
 * Analyses a whole recording in pieces, letting the page breathe between them.
 * `onProgress` gets 0..1.
 */
export async function analyzeSamples(samples, rate, { onProgress = () => {}, chunkSeconds = 2 } = {}) {
  const analyzer = new Analyzer(rate);
  const step = Math.max(1, Math.round(chunkSeconds * rate));
  for (let i = 0; i < samples.length; i += step) {
    analyzer.push(samples.subarray(i, i + step));
    onProgress(MONO_SHARE * Math.min(1, (i + step) / samples.length));
    await pause();
  }
  const result = await analyzer.finishAll({ onProgress: (p) => onProgress(MONO_SHARE + (1 - MONO_SHARE) * p * 0.99) });
  onProgress(1);
  return result;
}
