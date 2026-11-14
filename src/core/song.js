// The song of a song room: sounds and the clips that place them on the timeline.
//
// A sound (source) is one recording or imported file together with the notes
// found in it and a small waveform summary. It never changes once added. A
// clip is a rectangle on the timeline: it plays the part of a sound from
// `offset` for `length`, starting at `start`, on row `row`. Splitting,
// copying and pasting only make new clips; the sound stays as it was.
//
// Every change is an op, and ops can arrive in any order and more than once
// with the same result everywhere, exactly like the text sheets:
//   src   adds a sound (kept forever)
//   clip  adds a clip (kept forever; hidden by its removes counter)
//   cset  sets clip fields; per field, the op with the larger id wins
//   crm   sets a clip's removes counter; the larger counter wins, odd = removed
//   nfix  changes a note of a sound (pitch, start, length, loudness, gone);
//         per field, the op with the larger id wins
//   nadd  adds a note to a sound: { note: { t, d, p, v } }
// A sound's own notes never change; edits lie over them, so every device
// agrees and every edit can be undone. notesOf(src) gives the result.
//
// All times in this module are whole milliseconds.

import { cmpId, validId } from "./crdt.js";
import { toBase64, fromBase64 } from "./b64.js";

export const MAX_ROWS = 16;
export const MAX_CLIPS = 200;
export const MAX_TAKE_MS = 180000; // one recording: 3 minutes
const MAX_TIMELINE_MS = 1800000;
const MAX_SOURCE_MS = 600000;
const MAX_NOTES = 3000;
const MAX_PEAKS = 40000;
const MAX_UNKNOWN = 300;
const MIN_PIECE_MS = 50; // a split leaves at least this much on each side
const MIN_EVENT_MS = 30;

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const shortText = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;

const FIELD_OK = {
  row: (v) => isInt(v, 0, 63),
  start: (v) => isInt(v, 0, MAX_TIMELINE_MS),
  offset: (v) => isInt(v, 0, MAX_SOURCE_MS),
  length: (v) => isInt(v, 1, MAX_SOURCE_MS),
  muted: (v) => typeof v === "boolean",
  locked: (v) => typeof v === "boolean",
  // Who locked it: they and the room's owner may unlock it.
  lockBy: (v) => v === null || (typeof v === "string" && v.length > 0 && v.length <= 40),
};
export const CLIP_FIELDS = Object.keys(FIELD_OK);

const NOTE_FIELD_OK = {
  t: (v) => isInt(v, 0, MAX_SOURCE_MS),
  d: (v) => isInt(v, 1, MAX_SOURCE_MS),
  p: (v) => isInt(v, 0, 127),
  v: (v) => isInt(v, 0, 100),
  gone: (v) => typeof v === "boolean",
};
const NOTE_KEY = /^\d{1,5}$/;
const PEAK_MS = 40; // one waveform value per 40 ms (25 a second)

function validNotes(notes) {
  return Array.isArray(notes) && notes.length <= MAX_NOTES && notes.every((n) =>
    Array.isArray(n) && n.length === 4 && isInt(n[0], 0, MAX_SOURCE_MS) && isInt(n[1], 1, MAX_SOURCE_MS) && isInt(n[2], 0, 127) && isInt(n[3], 0, 100));
}

function validFields(f) {
  if (!f || typeof f !== "object" || Array.isArray(f)) return false;
  const keys = Object.keys(f);
  return keys.length > 0 && keys.every((k) => FIELD_OK[k] && FIELD_OK[k](f[k]));
}

export class SongDoc {
  constructor() {
    this.version = 0;
    this.sources = new Map();
    this.clipsById = new Map();
    this.waiting = new Map();
    this.seen = new Set();
    this.unknown = [];
    this.maxN = 0;
    this.cache = null;
    this.added = new Map();
    this.fixes = new Map();
    this.noteCache = null;
    this.tempoOp = null; // 박자: the latest tempo op wins; bpm 0 turns the grid off
  }

  /** The song's tempo and meter, { bpm, beats, unit }, or null when none is set. */
  tempo() {
    const op = this.tempoOp;
    return op && op.bpm > 0 ? { bpm: op.bpm, beats: op.beats, unit: op.unit } : null;
  }

  apply(op) {
    const result = this.step(op);
    if (result === "applied") this.wake(op);
    return result;
  }

  applyAll(ops) {
    const before = this.version;
    for (const op of ops) this.apply(op);
    return this.version !== before;
  }

  step(op) {
    if (!op || typeof op !== "object" || !validId(op.id)) return this.setAside(op);
    if (this.seen.has(op.id)) return "dup";
    switch (op.t) {
      case "src": {
        const ok = isInt(op.dur, 1, MAX_SOURCE_MS) && validNotes(op.notes) && typeof op.peaks === "string" && op.peaks.length <= MAX_PEAKS &&
          shortText(op.by, 40) && Number.isFinite(op.at) && (op.blob === undefined || shortText(op.blob, 80)) && (op.name === undefined || shortText(op.name, 60));
        if (!ok) return this.setAside(op);
        this.sources.set(op.id, {
          id: op.id, dur: op.dur, peaks: op.peaks, by: op.by, at: op.at, blob: op.blob || null, name: op.name || null,
          notes: op.notes.map(([t, d, p, v]) => ({ t, d, p, v: v / 100 })),
        });
        return this.done(op);
      }
      case "clip": {
        const ok = validId(op.src) && FIELD_OK.row(op.row) && FIELD_OK.start(op.start) && FIELD_OK.offset(op.offset) && FIELD_OK.length(op.length) &&
          shortText(op.by, 40) && Number.isFinite(op.at) && cmpId(op.id, op.src) > 0;
        if (!ok) return this.setAside(op);
        if (!this.sources.has(op.src)) return this.wait(op.src, op);
        const fields = new Map();
        for (const k of ["row", "start", "offset", "length"]) fields.set(k, { v: op[k], at: op.id });
        fields.set("muted", { v: false, at: op.id });
        fields.set("locked", { v: false, at: op.id });
        fields.set("lockBy", { v: null, at: op.id });
        this.clipsById.set(op.id, { id: op.id, src: op.src, by: op.by, at: op.at, fields, rm: 0 });
        return this.done(op);
      }
      case "tempo": {
        const ok = Number.isFinite(op.bpm) && (op.bpm === 0 || (op.bpm >= 30 && op.bpm <= 300)) &&
          Number.isInteger(op.beats) && op.beats >= 1 && op.beats <= 12 && [2, 4, 8, 16].includes(op.unit) && shortText(op.by, 40);
        if (!ok) return this.setAside(op);
        if (!this.tempoOp || cmpId(op.id, this.tempoOp.id) > 0) this.tempoOp = op;
        return this.done(op);
      }
      case "cset": {
        if (!validId(op.c) || !validFields(op.f)) return this.setAside(op);
        const clip = this.clipsById.get(op.c);
        if (!clip) return this.wait(op.c, op);
        for (const [k, v] of Object.entries(op.f)) {
          const cur = clip.fields.get(k);
          if (!cur || cmpId(op.id, cur.at) > 0) clip.fields.set(k, { v, at: op.id });
        }
        return this.done(op);
      }
      case "nadd": {
        const n = op.note;
        const ok = validId(op.src) && n && typeof n === "object" && NOTE_FIELD_OK.t(n.t) && NOTE_FIELD_OK.d(n.d) && NOTE_FIELD_OK.p(n.p) && NOTE_FIELD_OK.v(n.v) && cmpId(op.id, op.src) > 0;
        if (!ok) return this.setAside(op);
        if (!this.sources.has(op.src)) return this.wait(op.src, op);
        this.added.set(op.id, { key: op.id, src: op.src, t: n.t, d: n.d, p: n.p, v: n.v / 100 });
        return this.done(op);
      }
      case "nfix": {
        const f = op.f;
        const fieldsOk = f && typeof f === "object" && !Array.isArray(f) && Object.keys(f).length > 0 && Object.entries(f).every(([k, v]) => NOTE_FIELD_OK[k] && NOTE_FIELD_OK[k](v));
        const keyOk = typeof op.n === "string" && (NOTE_KEY.test(op.n) || validId(op.n));
        if (!validId(op.src) || !keyOk || !fieldsOk) return this.setAside(op);
        if (!this.sources.has(op.src)) return this.wait(op.src, op);
        if (!NOTE_KEY.test(op.n) && !this.added.has(op.n)) return this.wait(op.n, op);
        const at = op.src + "|" + op.n;
        if (!this.fixes.has(at)) this.fixes.set(at, new Map());
        const fields = this.fixes.get(at);
        for (const [k, v] of Object.entries(f)) {
          const cur = fields.get(k);
          if (!cur || cmpId(op.id, cur.at) > 0) fields.set(k, { v, at: op.id });
        }
        return this.done(op);
      }
      case "crm": {
        if (!validId(op.c) || !isInt(op.n, 1, 1e9)) return this.setAside(op);
        const clip = this.clipsById.get(op.c);
        if (!clip) return this.wait(op.c, op);
        if (op.n > clip.rm) clip.rm = op.n;
        return this.done(op);
      }
      default:
        return this.setAside(op);
    }
  }

  done(op) {
    this.seen.add(op.id);
    this.version++;
    const n = Number(op.id.slice(0, op.id.indexOf("@")));
    if (n > this.maxN) this.maxN = n;
    return "applied";
  }

  /** Ops about a sound or clip that has not arrived yet wait for it. */
  wait(missing, op) {
    if (!this.waiting.has(missing)) this.waiting.set(missing, []);
    this.waiting.get(missing).push(op);
    return "pending";
  }

  wake(op) {
    const queue = [op.id];
    while (queue.length) {
      const id = queue.pop();
      const list = this.waiting.get(id);
      if (!list) continue;
      this.waiting.delete(id);
      for (const waiting of list) if (this.step(waiting) === "applied") queue.push(waiting.id);
    }
  }

  setAside(op) {
    if (this.unknown.length < MAX_UNKNOWN) this.unknown.push(op);
    return "unknown";
  }

  get pendingCount() {
    let n = 0;
    for (const list of this.waiting.values()) n += list.length;
    return n;
  }

  // ---- reading ------------------------------------------------------------------

  source(id) {
    return this.sources.get(id) || null;
  }

  /** A clip as plain values, or null when it does not exist. Removed clips included. */
  clip(id) {
    const c = this.clipsById.get(id);
    if (!c) return null;
    const out = { id: c.id, src: c.src, by: c.by, at: c.at, rm: c.rm, removed: c.rm % 2 === 1 };
    for (const [k, { v }] of c.fields) out[k] = v;
    return out;
  }

  /**
   * A sound's notes with every edit applied, by start time. Each note has a
   * `key`: its index among the sound's own notes ("0", "1"…) or, for an added
   * note, the id of the op that added it. `withGone` keeps removed notes too.
   */
  notesOf(srcId, { withGone = false } = {}) {
    if (!this.noteCache || this.noteCache.version !== this.version) this.noteCache = { version: this.version, by: new Map() };
    const key = srcId + (withGone ? "+" : "");
    if (this.noteCache.by.has(key)) return this.noteCache.by.get(key);
    const src = this.sources.get(srcId);
    if (!src) return [];
    const list = src.notes.map((n, i) => ({ key: String(i), t: n.t, d: n.d, p: n.p, v: n.v, gone: false }));
    for (const a of this.added.values()) if (a.src === srcId) list.push({ key: a.key, t: a.t, d: a.d, p: a.p, v: a.v, gone: false });
    for (const n of list) {
      const fields = this.fixes.get(srcId + "|" + n.key);
      if (fields) for (const [k, { v }] of fields) n[k] = k === "v" ? v / 100 : v;
    }
    const out = list.filter((n) => withGone || !n.gone).sort((a, b) => a.t - b.t || a.p - b.p);
    this.noteCache.by.set(key, out);
    return out;
  }

  /** The clip right after this one on the same drawn row, or null. */
  nextOnRow(clipId) {
    const clips = this.layout();
    const me = clips.find((c) => c.id === clipId);
    if (!me) return null;
    let best = null;
    for (const c of clips) {
      if (c.id === me.id || c.lane !== me.lane || c.start < me.start + me.length) continue;
      if (!best || c.start < best.start) best = c;
    }
    return best;
  }

  /**
   * Visible clips with `lane`, the row they are drawn on. A row holds no two
   * clips at the same moment: when clips meet (two people placed them at the
   * same time), the one with the larger id moves down to the next row with
   * room. Every device computes the same lanes.
   */
  layout() {
    if (this.cache && this.cache.version === this.version) return this.cache.clips;
    const clips = [...this.clipsById.keys()].map((id) => this.clip(id)).filter((c) => !c.removed);
    clips.sort((a, b) => a.row - b.row || cmpId(a.id, b.id));
    const lanes = [];
    for (const clip of clips) {
      let lane = clip.row;
      while (overlapsAny(lanes[lane], clip.start, clip.start + clip.length)) lane++;
      (lanes[lane] ||= []).push([clip.start, clip.start + clip.length]);
      clip.lane = lane;
    }
    clips.sort((a, b) => a.lane - b.lane || a.start - b.start || cmpId(a.id, b.id));
    this.cache = { version: this.version, clips };
    return clips;
  }

  clips() {
    return this.layout();
  }

  /** Where the last clip ends. */
  end() {
    let end = 0;
    for (const c of this.layout()) end = Math.max(end, c.start + c.length);
    return end;
  }

  /** Rows in use, plus the always-empty one below them. */
  rowCount() {
    let rows = 0;
    for (const c of this.layout()) rows = Math.max(rows, c.lane + 1);
    return rows < MAX_ROWS ? rows + 1 : rows;
  }

  /**
   * The nearest row at or below `row` where a clip of this span fits, or null
   * when every row down to the last one is taken there. `ignore` is a clip
   * that is being moved and so does not count as in the way.
   */
  freeRow(start, length, row = 0, ignore = null) {
    const lanes = [];
    for (const c of this.layout()) if (c.id !== ignore) (lanes[c.lane] ||= []).push([c.start, c.start + c.length]);
    for (let r = Math.max(0, row); r < MAX_ROWS; r++) if (!overlapsAny(lanes[r], start, start + length)) return r;
    return null;
  }

  canAddClip() {
    return this.layout().length < MAX_CLIPS;
  }

  /**
   * Piano notes to sound between `from` and `to` (timeline ms), from clips that
   * are not muted. A note crossing a clip's edge is cut there. With `ongoing`,
   * a note already sounding at `from` is included from `from` on.
   */
  noteEvents(from, to, { ongoing = false } = {}) {
    const out = [];
    for (const clip of this.layout()) {
      if (clip.muted) continue;
      const src = this.sources.get(clip.src);
      if (!src) continue;
      const lo = clip.offset;
      const hi = clip.offset + clip.length;
      for (const n of this.notesOf(clip.src)) {
        const s = Math.max(n.t, lo);
        const e = Math.min(n.t + n.d, hi);
        if (e - s < MIN_EVENT_MS) continue;
        let at = clip.start + (s - lo);
        let d = e - s;
        if (at < from) {
          if (!ongoing || at + d - from < MIN_EVENT_MS * 2) continue;
          d = at + d - from;
          at = from;
        }
        if (at >= to) continue;
        out.push({ at, d, p: n.p, v: n.v, clip: clip.id });
      }
    }
    return out.sort((a, b) => a.at - b.at || a.p - b.p);
  }

  /** Stretches of recorded sound to play between `from` and `to`, like `noteEvents`. */
  audioSegments(from, to, { ongoing = false } = {}) {
    const out = [];
    for (const clip of this.layout()) {
      if (clip.muted) continue;
      let at = clip.start;
      let offset = clip.offset;
      let d = clip.length;
      if (at < from) {
        if (!ongoing || at + d - from < MIN_EVENT_MS) continue;
        offset += from - at;
        d -= from - at;
        at = from;
      }
      if (at >= to) continue;
      out.push({ at, d, offset, src: clip.src, clip: clip.id });
    }
    return out.sort((a, b) => a.at - b.at);
  }
}

function overlapsAny(spans, start, end) {
  return !!spans && spans.some(([s, e]) => start < e && s < end);
}

// ---- ops ------------------------------------------------------------------------

const ms = (seconds) => Math.max(0, Math.round(seconds * 1000));

/**
 * The op that adds a sound. `notes` come from the analysis in seconds
 * ({ t, d, p, v }); they are stored in whole milliseconds.
 */
export function sourceOp(clock, song, { duration, notes, peaks, by, at, blob, name }) {
  clock.atLeast(song.maxN);
  const op = {
    t: "src", id: clock.next(), dur: Math.max(1, ms(duration)), peaks, by, at,
    notes: notes.slice(0, MAX_NOTES).map((n) => [ms(n.t), Math.max(1, ms(n.d)), Math.round(n.p), Math.round(Math.min(1, Math.max(0, n.v)) * 100)]),
  };
  if (blob) op.blob = blob;
  if (name) op.name = String(name).slice(0, 60);
  return op;
}

/** Adds a clip; returns the ops and the undo atoms. */
export function addClipOps(clock, song, { src, row, start, offset = 0, length, by, at }) {
  clock.atLeast(song.maxN);
  const op = { t: "clip", id: clock.next(), src, row, start: Math.round(start), offset: Math.round(offset), length: Math.max(1, Math.round(length)), by, at };
  return { ops: [op], atoms: [{ k: "add", clip: op.id }], id: op.id };
}

/** Changes clip fields (move, mute, lock, trim). */
export function setClipOps(clock, song, clipId, fields) {
  const clip = song.clip(clipId);
  if (!clip) return { ops: [], atoms: [] };
  clock.atLeast(song.maxN);
  const prev = {};
  for (const k of Object.keys(fields)) prev[k] = clip[k];
  return { ops: [{ t: "cset", id: clock.next(), c: clipId, f: { ...fields } }], atoms: [{ k: "set", clip: clipId, prev, next: { ...fields } }] };
}

export function removeClipOps(clock, song, clipId) {
  const clip = song.clip(clipId);
  if (!clip || clip.removed) return { ops: [], atoms: [] };
  clock.atLeast(song.maxN);
  return { ops: [{ t: "crm", id: clock.next(), c: clipId, n: clip.rm + 1 }], atoms: [{ k: "del", clip: clipId }] };
}

/**
 * Cuts a clip in two at timeline time `at`: the clip keeps the front, a new
 * clip plays the back. Null when `at` is not inside the clip, or too near an edge.
 */
export function splitClipOps(clock, song, clipId, at, by, now = Date.now()) {
  const clip = song.clip(clipId);
  if (!clip || clip.removed) return null;
  const cut = Math.round(at) - clip.start;
  if (cut < MIN_PIECE_MS || clip.length - cut < MIN_PIECE_MS) return null;
  const front = setClipOps(clock, song, clipId, { length: cut });
  const back = addClipOps(clock, song, { src: clip.src, row: clip.row, start: clip.start + cut, offset: clip.offset + cut, length: clip.length - cut, by, at: now });
  // The new clip takes over the old one's muting and locking.
  const extra = clip.muted || clip.locked ? [{ t: "cset", id: clock.next(), c: back.id, f: { muted: clip.muted, locked: clip.locked } }] : [];
  return { ops: [...front.ops, ...back.ops, ...extra], atoms: [...front.atoms, ...back.atoms], id: back.id };
}

/** Ops that undo or redo a recorded step, judged against the song as it is now. */
export function invertSongOps(song, clock, atoms, dir) {
  clock.atLeast(song.maxN);
  const undo = dir === "undo";
  const ops = [];
  const counters = new Map();
  const show = (id, shown) => {
    const clip = song.clip(id);
    if (!clip) return;
    const rm = counters.has(id) ? counters.get(id) : clip.rm;
    if ((rm % 2 === 0) === shown) return;
    counters.set(id, rm + 1);
    ops.push({ t: "crm", id: clock.next(), c: id, n: rm + 1 });
  };
  for (const atom of undo ? atoms.slice().reverse() : atoms) {
    if (atom.k === "add") show(atom.clip, !undo);
    else if (atom.k === "del") show(atom.clip, undo);
    else if (atom.k === "set") ops.push({ t: "cset", id: clock.next(), c: atom.clip, f: { ...(undo ? atom.prev : atom.next) } });
    else if (atom.k === "nset") ops.push({ t: "nfix", id: clock.next(), src: atom.src, n: atom.n, f: { ...(undo ? atom.prev : atom.next) } });
    else if (atom.k === "nadd") ops.push({ t: "nfix", id: clock.next(), src: atom.src, n: atom.n, f: { gone: undo } });
    else if (atom.k === "tempo") ops.push({ t: "tempo", id: clock.next(), ...(undo ? atom.prev : atom.next), by: atom.by });
  }
  return ops;
}

// ---- note edits -------------------------------------------------------------------

const toStored = (k, v) => (k === "v" ? Math.round(Math.min(1, Math.max(0, v)) * 100) : k === "gone" ? !!v : Math.max(k === "d" ? 1 : 0, Math.round(v)));

/** Changes fields of one note (t, d, p in ms and key numbers, v 0..1, gone). */
export function noteSetOps(clock, song, src, key, fields) {
  const note = song.notesOf(src, { withGone: true }).find((n) => n.key === key);
  if (!note) return { ops: [], atoms: [] };
  clock.atLeast(song.maxN);
  const next = {};
  const prev = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!NOTE_FIELD_OK[k]) continue;
    next[k] = toStored(k, v);
    prev[k] = toStored(k, note[k]);
  }
  if (!Object.keys(next).length) return { ops: [], atoms: [] };
  return { ops: [{ t: "nfix", id: clock.next(), src, n: key, f: next }], atoms: [{ k: "nset", src, n: key, prev, next }] };
}

/** Adds a note to a sound (t and d in ms). */
export function noteAddOps(clock, song, src, { t, d, p, v = 0.8 }) {
  clock.atLeast(song.maxN);
  const op = { t: "nadd", id: clock.next(), src, note: { t: toStored("t", t), d: toStored("d", d), p: Math.min(127, Math.max(0, Math.round(p))), v: toStored("v", v) } };
  return { ops: [op], atoms: [{ k: "nadd", src, n: op.id }], key: op.id };
}

// ---- joining ----------------------------------------------------------------------

/**
 * Joins a clip with the next one on its row (잇기). Two pieces of one recording
 * lying end to end become one clip again: returns { ops, atoms }. Anything else
 * needs a new sound made of both: returns { combine: { a, b } } for the caller
 * to build with combinedSource (and the recordings, when this device has them)
 * and finish with joinWithSourceOps. Null when no clip follows.
 */
export function joinClipOps(clock, song, clipId, by, now = Date.now()) {
  const a = song.layout().find((c) => c.id === clipId);
  const b = a && song.nextOnRow(clipId);
  if (!a || !b) return null;
  if (a.src === b.src && b.start === a.start + a.length && b.offset === a.offset + a.length && !a.locked && !b.locked) {
    const grow = setClipOps(clock, song, a.id, { length: a.length + b.length });
    const drop = removeClipOps(clock, song, b.id);
    return { ops: [...grow.ops, ...drop.ops], atoms: [...grow.atoms, ...drop.atoms], id: a.id };
  }
  void by;
  void now;
  return { combine: { a, b } };
}

/** The notes and waveform of two clips as one sound, the gap between them kept as silence. */
export function combinedSource(song, a, b) {
  const total = b.start + b.length - a.start;
  const part = (clip, shift) => song.notesOf(clip.src)
    .map((n) => ({ s: Math.max(n.t, clip.offset), e: Math.min(n.t + n.d, clip.offset + clip.length), n }))
    .filter((x) => x.e - x.s >= 20)
    .map((x) => ({ t: (x.s - clip.offset + shift) / 1000, d: (x.e - x.s) / 1000, p: x.n.p, v: x.n.v }));
  const peaks = new Uint8Array(Math.ceil(total / PEAK_MS));
  const lay = (clip, shift) => {
    const bytes = fromBase64(song.source(clip.src)?.peaks || "");
    const first = Math.floor(clip.offset / PEAK_MS);
    const count = Math.ceil(clip.length / PEAK_MS);
    const at = Math.round(shift / PEAK_MS);
    for (let i = 0; i < count && at + i < peaks.length; i++) peaks[at + i] = bytes[first + i] || 0;
  };
  lay(a, 0);
  lay(b, b.start - a.start);
  return { duration: total / 1000, notes: [...part(a, 0), ...part(b, b.start - a.start)], peaks: toBase64(peaks) };
}

/** Finishes a join with the new sound: one clip where the two were. */
export function joinWithSourceOps(clock, song, a, b, srcOp, by, now = Date.now()) {
  clock.atLeast(song.maxN);
  const clip = { t: "clip", id: clock.next(), src: srcOp.id, row: a.row, start: a.start, offset: 0, length: b.start + b.length - a.start, by, at: now };
  const dropA = { t: "crm", id: clock.next(), c: a.id, n: (song.clip(a.id)?.rm ?? 0) + 1 };
  const dropB = { t: "crm", id: clock.next(), c: b.id, n: (song.clip(b.id)?.rm ?? 0) + 1 };
  return { ops: [srcOp, clip, dropA, dropB], atoms: [{ k: "add", clip: clip.id }, { k: "del", clip: a.id }, { k: "del", clip: b.id }], id: clip.id };
}

/** Sets the song's tempo and meter ({ bpm, beats, unit }; null turns 박자 off). Undoable. */
export function tempoOps(clock, song, tempo, by) {
  clock.atLeast(song.maxN);
  const before = song.tempo();
  const next = tempo ? { bpm: Math.round(tempo.bpm * 10) / 10, beats: tempo.beats, unit: tempo.unit } : { bpm: 0, beats: before?.beats || 4, unit: before?.unit || 4 };
  const prev = before || { bpm: 0, beats: 4, unit: 4 };
  return { ops: [{ t: "tempo", id: clock.next(), ...next, by }], atoms: [{ k: "tempo", prev, next, by }] };
}
