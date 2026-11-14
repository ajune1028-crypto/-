// A small summary of a recording's loudness over time, enough to draw its
// waveform in a clip without the audio itself. Pure computation.

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

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Bytes to base64 text. Written out so it works the same in the page and in tests. */
export function toBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return out;
}

export function fromBase64(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2] ?? "A") & 63) << 6) | (B64.indexOf(clean[i + 3] ?? "A") & 63);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
