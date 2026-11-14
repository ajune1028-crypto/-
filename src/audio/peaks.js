// A small summary of a recording's loudness over time, enough to draw its
// waveform in a clip without the audio itself. Pure computation.

import { toBase64 as encode64, fromBase64 as decode64 } from "../core/b64.js";

export const PEAKS_PER_SECOND = 25;

/** Collects the loudest sample of every 1/25 s, as values 0..255. */
export class PeakCollector {
  constructor(rate, perSecond = PEAKS_PER_SECOND) {
    this.size = rate / perSecond;
    this.values = [];
    this.max = 0;
    this.filled = 0;
  }

  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > this.max) this.max = a;
      if (++this.filled >= this.size) this.close();
    }
  }

  close() {
    // A square-root curve: quiet singing still shows, loud singing does not clip.
    this.values.push(Math.min(255, Math.round(Math.sqrt(Math.min(1, this.max)) * 255)));
    this.max = 0;
    this.filled -= this.size;
  }

  finish() {
    if (this.filled > 0.5) this.close();
    return Uint8Array.from(this.values);
  }
}

export function peaksOf(samples, rate, perSecond = PEAKS_PER_SECOND) {
  const c = new PeakCollector(rate, perSecond);
  c.push(samples);
  return c.finish();
}

// Base64 lives in core so the song document can join waveforms too.
export const toBase64 = encode64;
export const fromBase64 = decode64;
