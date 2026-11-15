// Files that travel with a room: a room's background photo, a recording hidden
// in words. A file is base64 text cut into parts, one op each, so every part
// fits the smallest store a room may use; a file is whole once all its parts
// are there, whatever order they came in.
//
//   fpart { id, f, i, n, type, data, by }   part i of n of file f (f = part 0's id)

import { validId } from "./crdt.js";

export const FILE_PART_CHARS = 40000;
export const MAX_FILE_PARTS = 64; // 2.5 million characters, about 1.9 MB
export const FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "audio/adpcm"];
const MAX_UNKNOWN = 100;
const BASE64 = /^[A-Za-z0-9+/=]*$/;

export class FileDoc {
  constructor() {
    this.version = 0;
    this.files = new Map(); // f → { type, n, by, parts: Map(i → data) }
    this.seen = new Set();
    this.unknown = [];
    this.maxN = 0;
  }

  apply(op) {
    if (!op || typeof op !== "object" || op.t !== "fpart" || !validId(op.id) || !validId(op.f)) return this.setAside(op);
    if (this.seen.has(op.id)) return "dup";
    const ok = Number.isInteger(op.n) && op.n >= 1 && op.n <= MAX_FILE_PARTS && Number.isInteger(op.i) && op.i >= 0 && op.i < op.n &&
      FILE_TYPES.includes(op.type) && typeof op.data === "string" && op.data.length <= FILE_PART_CHARS && BASE64.test(op.data) &&
      typeof op.by === "string" && op.by.length <= 40;
    if (!ok) return this.setAside(op);
    let file = this.files.get(op.f);
    if (!file) this.files.set(op.f, (file = { type: op.type, n: op.n, by: op.by, parts: new Map() }));
    if (file.type !== op.type || file.n !== op.n) return this.setAside(op);
    if (!file.parts.has(op.i)) file.parts.set(op.i, op.data);
    this.seen.add(op.id);
    this.version++;
    const n = Number(op.id.slice(0, op.id.indexOf("@")));
    if (n > this.maxN) this.maxN = n;
    return "applied";
  }

  applyAll(ops) {
    const before = this.version;
    for (const op of ops) this.apply(op);
    return this.version !== before;
  }

  setAside(op) {
    if (this.unknown.length < MAX_UNKNOWN) this.unknown.push(op);
    return "unknown";
  }

  /** { type, data, by } once every part has come; null before. */
  file(f) {
    const file = this.files.get(f);
    if (!file || file.parts.size < file.n) return null;
    let data = "";
    for (let i = 0; i < file.n; i++) data += file.parts.get(i);
    return { type: file.type, data, by: file.by };
  }

  /** How much of a file has come, 0 to 1 (0 for one never heard of). */
  progress(f) {
    const file = this.files.get(f);
    return file ? file.parts.size / file.n : 0;
  }
}

/** The ops that carry a file; its id is the first part's id. */
export function fileOps(clock, { type, data, by }) {
  const n = Math.max(1, Math.ceil(data.length / FILE_PART_CHARS));
  if (n > MAX_FILE_PARTS) throw new Error("file too big");
  const ops = [];
  for (let i = 0; i < n; i++) {
    const id = clock.next();
    ops.push({ t: "fpart", id, f: i === 0 ? id : ops[0].id, i, n, type, data: data.slice(i * FILE_PART_CHARS, (i + 1) * FILE_PART_CHARS), by });
  }
  return { ops, id: ops[0].id };
}
