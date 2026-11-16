// A recording's own sound for everyone in the room (the owner: "다른 기기에서 올린 거는… 원본이
// 여기 없다고 뜨는데… 고쳐줘"). The take stays whole on the device that made it; a smaller copy
// (16 kHz, four bits a sample: about 8 kB a second) goes into the room's `files`, in parts, under
// the take's own key, so my other devices and my friends hear the voice itself and not only the
// piano. Whoever has the original and sees the room lacks it sends it; it is sent once.

import { encodeAdpcm, decodeAdpcm } from "../audio/adpcm.js";
import { fileOps, FILE_PART_CHARS, MAX_FILE_PARTS } from "../core/files.js";
import { toBase64, fromBase64 } from "../core/b64.js";
import { decodeWav } from "../audio/wav.js";
import { toMono, resample } from "../audio/dsp.js";

export const SHARE_RATE = 16000;
const PART_PAUSE_MS = 120; // between parts: the room's store takes them one by one

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const queues = new WeakMap(); // session → { busy, waiting: [key], sent: Set }

/** The longest take that fits the room's files, in seconds. */
export const MAX_SHARED_SECONDS = Math.floor((MAX_FILE_PARTS * FILE_PART_CHARS * 0.75 - 16) / (SHARE_RATE / 2));

/**
 * Makes sure the room has this take's sound: sends it (in the background) when this device has
 * the original and the room has none. Safe to call often.
 */
export function shareTake(app, session, key) {
  if (!key || !session || session.transport?.readOnly || app.transport?.readOnly) return;
  let q = queues.get(session);
  if (!q) queues.set(session, (q = { busy: false, waiting: [], sent: new Set() }));
  if (q.sent.has(key) || q.waiting.includes(key)) return;
  q.waiting.push(key);
  if (!q.busy) run(app, session, q);
}

async function run(app, session, q) {
  q.busy = true;
  try {
    const files = await session.load("files");
    while (q.waiting.length) {
      const key = q.waiting.shift();
      q.sent.add(key);
      if (!files || files.namedProgress(key) > 0) continue; // someone has sent it (or is sending)
      const kept = await app.blobs.get(key).catch(() => null);
      const wav = kept && decodeWav(kept.data);
      if (!wav) continue;
      const mono = toMono(wav.channels);
      if (mono.length / wav.rate > MAX_SHARED_SECONDS) continue;
      const low = wav.rate === SHARE_RATE ? mono : resample(mono, wav.rate, SHARE_RATE);
      const data = toBase64(encodeAdpcm(low, SHARE_RATE));
      // Looked again just before sending: two of my devices open at once send it only once.
      if (files.namedProgress(key) > 0) continue;
      const made = fileOps(session.clock, { type: "audio/adpcm", data, by: session.memberId || "", name: key });
      for (const op of made.ops) {
        if (!session.docs) return;
        session.commit("files", [op]);
        await pause(PART_PAUSE_MS);
      }
    }
  } catch (err) {
    console.warn(err);
  } finally {
    q.busy = false;
  }
}

/**
 * A take's sound: this device's own copy if it has one, else the room's. { samples, rate } or null.
 * `files` is the room's files document (already loaded).
 */
export async function takeSound(app, files, key) {
  if (!key) return null;
  const kept = await app.blobs.get(key).catch(() => null);
  const wav = kept && decodeWav(kept.data);
  if (wav) return { samples: toMono(wav.channels), rate: wav.rate, own: true };
  const shared = files?.named(key);
  if (!shared || shared.type !== "audio/adpcm") return null;
  const sound = decodeAdpcm(fromBase64(shared.data));
  return sound ? { samples: sound.samples, rate: sound.rate, own: false } : null;
}
