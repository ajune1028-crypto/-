// WAV files: the one audio format every browser plays and decodes. Recordings
// are kept as 16-bit mono WAV. Pure computation.

/** Mono samples (-1..1) to a 16-bit PCM WAV file. */
export function encodeWav(samples, rate) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return bytes;
}

/**
 * Reads PCM WAV (8, 16, 24 or 32 bit, or 32-bit float). Returns
 * { rate, channels: Float32Array[] }, or null for anything else.
 */
export function decodeWav(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let fmt = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-format GUID.
      if (fmt.format === 0xfffe && size >= 26) fmt.format = view.getUint16(body + 24, true);
    } else if (id === "data" && fmt) {
      const { format, channels, rate, bits } = fmt;
      const width = bits / 8;
      if (!channels || ![8, 16, 24, 32].includes(bits) || !(format === 1 || (format === 3 && bits === 32))) return null;
      const end = Math.min(bytes.length, body + size);
      const frames = Math.floor((end - body) / (width * channels));
      const out = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < channels; c++) {
          const p = body + (f * channels + c) * width;
          let v;
          if (format === 3) v = view.getFloat32(p, true);
          else if (bits === 8) v = (bytes[p] - 128) / 128;
          else if (bits === 16) v = view.getInt16(p, true) / 32768;
          else if (bits === 24) v = (((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)) << 8) >> 8) / 8388608;
          else v = view.getInt32(p, true) / 2147483648;
          out[c][f] = v;
        }
      }
      return { rate, channels: out };
    }
    at = body + size + (size % 2);
  }
  return null;
}
