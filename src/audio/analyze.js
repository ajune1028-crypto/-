// Recording in, notes out: mixes the pieces above into one step that can run
// live while someone sings, or over a whole file. Pure computation.

import { StreamResampler } from "./dsp.js";
import { ANALYSIS_RATE, PitchTracker } from "./pitch.js";
import { segmentNotes } from "./notes.js";
import { PeakCollector } from "./peaks.js";

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
  }

  push(samples) {
    this.count += samples.length;
    this.peaks.push(samples);
    for (const f of this.tracker.push(this.resampler.push(samples))) this.frames.push(f);
  }

  get seconds() {
    return this.count / this.rate;
  }

  /** Notes so far. Recomputed at most once per new batch of frames. */
  notes() {
    if (!this.cache || this.cache.n !== this.frames.length) this.cache = { n: this.frames.length, notes: segmentNotes(this.frames) };
    return this.cache.notes;
  }

  finish() {
    for (const f of this.tracker.push(this.resampler.flush())) this.frames.push(f);
    for (const f of this.tracker.flush()) this.frames.push(f);
    return { notes: segmentNotes(this.frames), frames: this.frames, peaks: this.peaks.finish(), duration: this.seconds };
  }
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Analyses a whole recording in pieces, letting the page breathe between them.
 * `onProgress` gets 0..1.
 */
export async function analyzeSamples(samples, rate, { onProgress = () => {}, chunkSeconds = 2 } = {}) {
  const analyzer = new Analyzer(rate);
  const step = Math.max(1, Math.round(chunkSeconds * rate));
  for (let i = 0; i < samples.length; i += step) {
    analyzer.push(samples.subarray(i, i + step));
    onProgress(Math.min(0.99, (i + step) / samples.length));
    await pause();
  }
  const result = analyzer.finish();
  onProgress(1);
  return result;
}
