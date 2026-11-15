// The sound out of a video (an iPhone or iPad camera clip, .mov or .mp4): its AAC
// track copied, unchanged, into a plain .m4a, the kind the browser reads like a
// Voice Memos file. Some browsers (Safari) read no sound from a file that also
// holds a picture. Pure computation on bytes.

const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const name = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

/** The boxes in b[from..to): [{ type, start, head, end }] (head: where its content starts). */
function boxes(b, from = 0, to = b.length) {
  const out = [];
  let i = from;
  while (i + 8 <= to) {
    let size = u32(b, i);
    let head = 8;
    if (size === 1) {
      if (i + 16 > to) break;
      size = u32(b, i + 8) * 2 ** 32 + u32(b, i + 12);
      head = 16;
    } else if (size === 0) size = to - i;
    if (size < head || i + size > to) break;
    out.push({ type: name(b, i + 4), start: i, head: i + head, end: i + size });
    i += size;
  }
  return out;
}

const child = (b, box, type, skip = 0) => boxes(b, box.head + skip, box.end).find((x) => x.type === type) || null;

/** Whether the bytes look like an ISO media file (mp4, mov, m4a, 3gp). */
export function isIsoMedia(b) {
  if (b.length < 12) return false;
  const first = name(b, 4);
  return ["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(first);
}

/** Looks for a box of this type anywhere under b[from..to). */
function find(b, from, to, type) {
  for (const x of boxes(b, from, to)) {
    if (x.type === type) return x;
    const inner = find(b, x.head, x.end, type);
    if (inner) return inner;
  }
  return null;
}

/**
 * The first AAC sound track: its tables and sample bytes.
 * Returns null when there is none (or the file is cut short).
 */
export function soundTrack(b) {
  const moov = boxes(b).find((x) => x.type === "moov");
  if (!moov) return null;
  for (const trak of boxes(b, moov.head, moov.end).filter((x) => x.type === "trak")) {
    const mdia = child(b, trak, "mdia");
    const hdlr = mdia && child(b, mdia, "hdlr");
    if (!hdlr || name(b, hdlr.head + 8) !== "soun") continue;
    const mdhd = child(b, mdia, "mdhd");
    const stbl = mdia && child(b, mdia, "minf") && child(b, child(b, mdia, "minf"), "stbl");
    if (!mdhd || !stbl) continue;
    const stsd = child(b, stbl, "stsd");
    const entry = stsd && boxes(b, stsd.head + 8, stsd.end)[0];
    if (!entry || entry.type !== "mp4a") continue;
    // The decoder's own setup (AudioSpecificConfig), inside esds, which a .mov keeps in a 'wave' box.
    const version = u16(b, entry.head + 8);
    const extra = version === 1 ? 16 : version === 2 ? 36 : 0;
    const esds = find(b, entry.head + 28 + extra, entry.end, "esds");
    if (!esds) continue;
    const v1 = b[mdhd.head] === 1;
    const timescale = u32(b, mdhd.head + (v1 ? 20 : 12));
    const duration = v1 ? u32(b, mdhd.head + 24) * 2 ** 32 + u32(b, mdhd.head + 28) : u32(b, mdhd.head + 16);
    const stts = child(b, stbl, "stts");
    const stsc = child(b, stbl, "stsc");
    const stsz = child(b, stbl, "stsz");
    const stco = child(b, stbl, "stco") || child(b, stbl, "co64");
    if (!stts || !stsc || !stsz || !stco) continue;
    // Sample sizes.
    const fixed = u32(b, stsz.head + 4);
    const count = u32(b, stsz.head + 8);
    const sizes = new Array(count);
    for (let k = 0; k < count; k++) sizes[k] = fixed || u32(b, stsz.head + 12 + 4 * k);
    // Chunk offsets.
    const wide = stco.type === "co64";
    const chunks = u32(b, stco.head + 4);
    const offsets = new Array(chunks);
    for (let k = 0; k < chunks; k++) offsets[k] = wide ? u32(b, stco.head + 8 + 8 * k) * 2 ** 32 + u32(b, stco.head + 12 + 8 * k) : u32(b, stco.head + 8 + 4 * k);
    // Samples per chunk, from runs.
    const runs = u32(b, stsc.head + 4);
    const per = [];
    for (let k = 0; k < runs; k++) per.push([u32(b, stsc.head + 8 + 12 * k), u32(b, stsc.head + 12 + 12 * k)]);
    const samples = [];
    let s = 0;
    for (let c = 0; c < chunks && s < count; c++) {
      let run = 0;
      while (run + 1 < per.length && per[run + 1][0] <= c + 1) run++;
      let at = offsets[c];
      for (let n = 0; n < per[run][1] && s < count; n++, s++) {
        if (at + sizes[s] > b.length) return null;
        samples.push([at, sizes[s]]);
        at += sizes[s];
      }
    }
    if (samples.length !== count) return null;
    const asc = ascOf(b, esds);
    return {
      timescale, duration, asc, samples,
      stts: b.subarray(stts.start, stts.end),
      esds: b.subarray(esds.start, esds.end),
      channels: asc?.channels || u16(b, entry.head + 16) || 2,
      rate: asc?.rate || u32(b, entry.head + 24) >>> 16 || timescale,
    };
  }
  return null;
}

const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** The AAC setup inside esds: object type, rate and channels (null when it cannot be read). */
function ascOf(b, esds) {
  // Descriptors: tag, a length in 7-bit groups, then the body.
  let i = esds.head + 4;
  const read = () => {
    const tag = b[i++];
    let len = 0;
    for (let k = 0; k < 4; k++) {
      const v = b[i++];
      len = (len << 7) | (v & 0x7f);
      if (!(v & 0x80)) break;
    }
    return { tag, len, at: i };
  };
  while (i < esds.end) {
    const d = read();
    if (d.tag === 3) {
      const flags = b[i + 2];
      i += 3 + (flags & 0x80 ? 2 : 0) + (flags & 0x40 ? 1 + b[i + 3] : 0) + (flags & 0x20 ? 2 : 0);
    } else if (d.tag === 4) i += 13;
    else if (d.tag === 5) {
      const bytes = b.subarray(i, i + d.len);
      const type = bytes[0] >> 3;
      const index = ((bytes[0] & 7) << 1) | (bytes[1] >> 7);
      const channels = (bytes[1] >> 3) & 15;
      return { bytes, type, index, rate: RATES[index] || 0, channels };
    } else i = d.at + d.len;
  }
  return null;
}

/** Writes a box: its size, its type, then its parts. */
function box(type, ...parts) {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, size);
  for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function bytes(...words) {
  // [value, width] pairs → big-endian bytes.
  const out = new Uint8Array(words.reduce((n, [, w]) => n + w, 0));
  let at = 0;
  for (const [val, w] of words) {
    for (let k = w - 1; k >= 0; k--) out[at + (w - 1 - k)] = Math.floor(val / 2 ** (8 * k)) & 0xff;
    at += w;
  }
  return out;
}

const MATRIX = bytes([0x10000, 4], [0, 4], [0, 4], [0, 4], [0x10000, 4], [0, 4], [0, 4], [0, 4], [0x40000000, 4]);

/** The sound track as a plain .m4a file (null when the file has no AAC sound). */
export function audioOnlyM4a(b) {
  const t = soundTrack(b);
  if (!t) return null;
  const total = t.samples.reduce((n, [, size]) => n + size, 0);
  const dur32 = Math.min(0xffffffff, t.duration);
  const ftyp = box("ftyp", new TextEncoder().encode("M4A "), bytes([0, 4]), new TextEncoder().encode("M4A mp42isom"));
  const mvhd = box("mvhd", bytes([0, 4], [0, 4], [0, 4], [t.timescale, 4], [dur32, 4], [0x10000, 4], [0x100, 2], [0, 10]), MATRIX, new Uint8Array(24), bytes([2, 4]));
  const tkhd = box("tkhd", bytes([7, 4], [0, 4], [0, 4], [1, 4], [0, 4], [dur32, 4], [0, 8], [0, 2], [0, 2], [0x100, 2], [0, 2]), MATRIX, bytes([0, 4], [0, 4]));
  const mdhd = box("mdhd", bytes([0, 4], [0, 4], [0, 4], [t.timescale, 4], [dur32, 4], [0x55c4, 2], [0, 2]));
  const hdlr = box("hdlr", bytes([0, 4], [0, 4]), new TextEncoder().encode("soun"), new Uint8Array(12), new TextEncoder().encode("SoundHandler\0"));
  const smhd = box("smhd", bytes([0, 4], [0, 2], [0, 2]));
  const dinf = box("dinf", box("dref", bytes([0, 4], [1, 4]), box("url ", bytes([1, 4]))));
  const rate16 = Math.min(65535, t.rate);
  const mp4a = box("mp4a", new Uint8Array(6), bytes([1, 2]), new Uint8Array(8), bytes([t.channels, 2], [16, 2], [0, 2], [0, 2], [rate16 * 0x10000, 4]), t.esds);
  const stsd = box("stsd", bytes([0, 4], [1, 4]), mp4a);
  const stsc = box("stsc", bytes([0, 4], [1, 4], [1, 4], [t.samples.length, 4], [1, 4]));
  const sizes = new Uint8Array(12 + 4 * t.samples.length);
  const sv = new DataView(sizes.buffer);
  sv.setUint32(8, t.samples.length);
  t.samples.forEach(([, size], k) => sv.setUint32(12 + 4 * k, size));
  const stsz = box("stsz", sizes);
  // The one chunk's offset is known once the header is laid out; written with a stand-in first.
  const build = (offset) => {
    const stco = box("stco", bytes([0, 4], [1, 4], [offset, 4]));
    const stbl = box("stbl", stsd, t.stts, stsc, stsz, stco);
    const minf = box("minf", smhd, dinf, stbl);
    const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, minf));
    return box("moov", mvhd, trak);
  };
  const head = ftyp.length + build(0).length + 8;
  const moov = build(head);
  const out = new Uint8Array(head + total);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  const mdat = ftyp.length + moov.length;
  new DataView(out.buffer).setUint32(mdat, 8 + total);
  out.set([0x6d, 0x64, 0x61, 0x74], mdat + 4);
  let at = head;
  for (const [from, size] of t.samples) {
    out.set(b.subarray(from, from + size), at);
    at += size;
  }
  return out;
}

/** The sound track as ADTS (raw AAC frames each with a 7-byte header), a second way in. */
export function audioAdts(b) {
  const t = soundTrack(b);
  if (!t || !t.asc || t.asc.index > 12) return null;
  const profile = Math.max(0, Math.min(3, t.asc.type - 1));
  const total = t.samples.reduce((n, [, size]) => n + size + 7, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const [from, size] of t.samples) {
    const len = size + 7;
    out[at] = 0xff;
    out[at + 1] = 0xf1;
    out[at + 2] = (profile << 6) | (t.asc.index << 2) | ((t.asc.channels >> 2) & 1);
    out[at + 3] = ((t.asc.channels & 3) << 6) | ((len >> 11) & 3);
    out[at + 4] = (len >> 3) & 0xff;
    out[at + 5] = ((len & 7) << 5) | 0x1f;
    out[at + 6] = 0xfc;
    out.set(b.subarray(from, from + size), at + 7);
    at += len;
  }
  return out;
}
