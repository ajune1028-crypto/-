// IMA ADPCM: a voice at four bits a sample, so a recording hidden in words can
// travel inside a room's ops. Mono. Layout: "AD" magic, rate (uint32 LE),
// sample count (uint32 LE), then nibbles, low nibble first, from a zero start.

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552,
  1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const HEAD = 10;

/** Float samples (-1 to 1) at `rate` → bytes. */
export function encodeAdpcm(samples, rate) {
  const out = new Uint8Array(HEAD + Math.ceil(samples.length / 2));
  out[0] = 0x41;
  out[1] = 0x44;
  const view = new DataView(out.buffer);
  view.setUint32(2, rate, true);
  view.setUint32(6, samples.length, true);
  let pred = 0;
  let index = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    const step = STEPS[index];
    let diff = s - pred;
    let code = 0;
    if (diff < 0) {
      code = 8;
      diff = -diff;
    }
    let delta = step >> 3;
    if (diff >= step) { code |= 4; diff -= step; delta += step; }
    if (diff >= step >> 1) { code |= 2; diff -= step >> 1; delta += step >> 1; }
    if (diff >= step >> 2) { code |= 1; delta += step >> 2; }
    pred = Math.max(-32768, Math.min(32767, code & 8 ? pred - delta : pred + delta));
    index = Math.max(0, Math.min(88, index + INDEX[code]));
    out[HEAD + (i >> 1)] |= i & 1 ? code << 4 : code;
  }
  return out;
}

/** Bytes → { samples (Float32Array), rate }; null for anything that is not ADPCM from encodeAdpcm. */
export function decodeAdpcm(bytes) {
  if (!bytes || bytes.length < HEAD || bytes[0] !== 0x41 || bytes[1] !== 0x44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rate = view.getUint32(2, true);
  const count = view.getUint32(6, true);
  if (rate < 3000 || rate > 96000 || count > (bytes.length - HEAD) * 2) return null;
  const samples = new Float32Array(count);
  let pred = 0;
  let index = 0;
  for (let i = 0; i < count; i++) {
    const byte = bytes[HEAD + (i >> 1)];
    const code = i & 1 ? byte >> 4 : byte & 15;
    const step = STEPS[index];
    let delta = step >> 3;
    if (code & 4) delta += step;
    if (code & 2) delta += step >> 1;
    if (code & 1) delta += step >> 2;
    pred = Math.max(-32768, Math.min(32767, code & 8 ? pred - delta : pred + delta));
    index = Math.max(0, Math.min(88, index + INDEX[code]));
    samples[i] = pred / 32768;
  }
  return { samples, rate };
}
