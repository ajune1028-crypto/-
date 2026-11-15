// Every sound put in anywhere (sung here, from the phone's recorder app, or a file)
// is also kept in 레퍼런스 녹음, with the room it went into. The sound itself is
// stored once, on this device; the list only points at it.

import { addRefSound } from "../reference.js";
import { toBase64 } from "../audio/peaks.js";
import { analyzeSamples } from "../audio/analyze.js";
import { resample } from "../audio/dsp.js";
import { encodeWav } from "../audio/wav.js";
import { newBlobId } from "../sync/blobs.js";
import { roomEntry } from "../identity.js";

const KEEP_RATE = 24000;

/** Where a take was made: this room's id, name and kind (for the line under it in 레퍼런스). */
export function takeWhere(app, roomId) {
  const entry = roomEntry(app.store, roomId);
  return { room: roomId, name: entry?.name || "", kind: entry?.kind || "" };
}

/** A take already analysed and stored (blob): listed in 레퍼런스 too. Never throws. */
export function keepTake(app, { name, result, blob, where }) {
  try {
    addRefSound(app.store, { name: name || "녹음", dur: result.duration, notes: result.notes, peaks: toBase64(result.peaks), blob, from: where });
  } catch (err) {
    console.warn(err);
  }
}

/** A take only the room has in its own form (a recording hidden in words): stored and analysed for 레퍼런스. */
export async function keepRawTake(app, samples, rate, { name, where }) {
  try {
    const kept = rate === KEEP_RATE ? samples : resample(samples, rate, KEEP_RATE);
    const blob = newBlobId();
    await app.blobs.put(blob, encodeWav(kept, KEEP_RATE), "audio/wav");
    const result = await analyzeSamples(samples, rate);
    keepTake(app, { name, result, blob, where });
  } catch (err) {
    console.warn(err);
  }
}
