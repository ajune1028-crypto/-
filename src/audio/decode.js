// Audio files in, samples out, and samples into the audio engine's buffers.

import { toMono } from "./dsp.js";
import { decodeWav } from "./wav.js";
import { isIsoMedia, audioOnlyM4a, audioAdts } from "./mp4.js";

function decodeWith(ctx, bytes) {
  return new Promise((resolve, reject) => {
    // Older Safari only knows the callback form; newer browsers return a promise too.
    const p = ctx.decodeAudioData(bytes, resolve, reject);
    if (p && typeof p.then === "function") p.then(resolve, reject);
  });
}

async function tryDecode(ctx, bytes) {
  try {
    return await decodeWith(ctx, bytes);
  } catch {
    return null;
  }
}

/**
 * Any audio file the browser can read (mp3, m4a, wav, webm, ogg…) as mono
 * samples, and the sound of a video (a camera clip: iPhones and iPads open the
 * camera for "record a sound"). Throws when it cannot be read.
 */
export async function decodeAudioFile(ctx, file) {
  const bytes = await file.arrayBuffer();
  let buffer = await tryDecode(ctx, bytes.slice(0));
  // A video the browser would not read for sound (Safari): its sound track alone, as an .m4a, then as ADTS.
  const whole = new Uint8Array(bytes);
  if (!buffer && isIsoMedia(whole)) {
    for (const make of [audioOnlyM4a, audioAdts]) {
      let out = null;
      try {
        out = make(whole);
      } catch {
        out = null;
      }
      if (!out) continue;
      buffer = await tryDecode(ctx, out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
      if (buffer) break;
    }
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
