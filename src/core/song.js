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
//
// All times in this module are whole milliseconds.

import { cmpId, validId } from "./crdt.js";

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
};
export const CLIP_FIELDS = Object.keys(FIELD_OK);

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
        this.clipsById.set(op.id, { id: op.id, src: op.src, by: op.by, at: op.at, fields, rm: 0 });
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
      for (const n of src.notes) {
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
  }
  return ops;
}
