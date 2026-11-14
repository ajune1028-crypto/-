// Audio files in, samples out, and samples into the audio engine's buffers.

import { toMono } from "./dsp.js";
import { decodeWav } from "./wav.js";

function decodeWith(ctx, bytes) {
  return new Promise((resolve, reject) => {
    // Older Safari only knows the callback form; newer browsers return a promise too.
    const p = ctx.decodeAudioData(bytes, resolve, reject);
    if (p && typeof p.then === "function") p.then(resolve, reject);
  });
}

/**
 * Any audio file the browser can read (mp3, m4a, wav, webm, ogg…) as mono
 * samples. Throws when it cannot be read.
 */
export async function decodeAudioFile(ctx, file) {
  const bytes = await file.arrayBuffer();
  let buffer = null;
  try {
    buffer = await decodeWith(ctx, bytes.slice(0));
  } catch {
    buffer = null;
  }
  if (buffer) {
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    return { samples: toMono(channels), rate: buffer.sampleRate };
  }
  const wav = decodeWav(bytes);
  if (wav) return { samples: toMono(wav.channels), rate: wav.rate };
  throw new Error("unreadable audio");
}

/** Mono samples as an AudioBuffer for playing. */
export function bufferFromSamples(ctx, samples, rate) {
  const buf = ctx.createBuffer(1, Math.max(1, samples.length), rate);
  buf.getChannelData(0).set(samples);
  return buf;
}
