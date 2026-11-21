// 애니메이션 방's frames: which frames there are, in which order, how long each is shown, and how
// the whole plays. What is drawn on a frame lives in its own drawing document (`k:F<frame id>`,
// an InkDoc), so brushes, erasers, live lines and undo work as in every room. The ideas come from
// the reference study (docs/superpowers/specs/2026-11-20-reference-study.md §3): FlipaClip's strip
// of frames, Procreate's per-frame hold, OpenToonz's timesheet exposure (BSD), 12 frames a second
// as animators draw "on twos".
//
//   frame  { id, by, at, o? }                 a new frame; o: its place (else after all others)
//   fset   { id, f: frame id, v: { order?, hold? } }   each field: the later op wins
//   frm    { id, f: frame id, n }             taken away while n is odd (undo brings it back)
//   aset   { id, v: { fps?, loop?, paper? } } how it plays and the paper under it: the later op wins

import { cmpId, validId } from "./crdt.js";
import { PAPERS } from "./draw.js";

export const FPS_CHOICES = [6, 8, 12, 24];
export const LOOPS = ["loop", "pingpong", "once"];
export const MAX_FRAMES = 240;
export const MAX_HOLD = 8;
const MAX_UNKNOWN = 300;
const FRAME_FIELDS = { order: (v) => typeof v === "number" && Number.isFinite(v), hold: (v) => Number.isInteger(v) && v >= 1 && v <= MAX_HOLD };
// The paper is the 그림 방's (one of its papers, or 투명): the rooms draw alike (the owner, 21 November: "다 연동").
const ANIM_FIELDS = { fps: (v) => FPS_CHOICES.includes(v), loop: (v) => LOOPS.includes(v), paper: (v) => PAPERS.some(([k]) => k === v) };
const DEFAULTS = { fps: 12, loop: "loop", paper: "white" };

/** The drawing document that holds a frame's strokes. */
export function frameDocOf(frameId) {
  return "k:F" + frameId;
}

const counterOf = (id) => Number(id.slice(0, id.indexOf("@")));
const fieldsOk = (v, rules) => v && typeof v === "object" && Object.keys(v).length > 0 && Object.keys(v).every((k) => rules[k] && rules[k](v[k]));

export class AnimDoc {
  constructor() {
    this.version = 0;
    this.byId = new Map();
    this.waiting = new Map();
    this.seen = new Set();
    this.unknown = [];
    this.maxN = 0;
    this.play = new Map(); // field → { v, at }
  }

  apply(op) {
    if (!op || typeof op !== "object" || !validId(op.id)) return this.setAside(op);
    if (this.seen.has(op.id)) return "dup";
    if (op.t === "frame") {
      if (typeof op.by !== "string" || op.by.length > 40 || !Number.isFinite(op.at) || (op.o !== undefined && !Number.isFinite(op.o))) return this.setAside(op);
      this.byId.set(op.id, { id: op.id, by: op.by, at: op.at, o: op.o, rm: 0, fields: new Map() });
      this.done(op);
      for (const later of this.waiting.get(op.id) || []) this.apply(later);
      this.waiting.delete(op.id);
      return "applied";
    }
    if (op.t === "fset") {
      if (!validId(op.f) || !fieldsOk(op.v, FRAME_FIELDS)) return this.setAside(op);
      const frame = this.byId.get(op.f);
      if (!frame) return this.wait(op);
      for (const [k, v] of Object.entries(op.v)) {
        const had = frame.fields.get(k);
        if (!had || cmpId(op.id, had.at) > 0) frame.fields.set(k, { v, at: op.id });
      }
      return this.done(op);
    }
    if (op.t === "frm") {
      if (!validId(op.f) || !Number.isInteger(op.n) || op.n < 1 || op.n > 1e9) return this.setAside(op);
      const frame = this.byId.get(op.f);
      if (!frame) return this.wait(op);
      if (op.n > frame.rm) frame.rm = op.n;
      return this.done(op);
    }
    if (op.t === "aset") {
      if (!fieldsOk(op.v, ANIM_FIELDS)) return this.setAside(op);
      for (const [k, v] of Object.entries(op.v)) {
        const had = this.play.get(k);
        if (!had || cmpId(op.id, had.at) > 0) this.play.set(k, { v, at: op.id });
      }
      return this.done(op);
    }
    return this.setAside(op);
  }

  applyAll(ops) {
    const before = this.version;
    for (const op of ops) this.apply(op);
    return this.version !== before;
  }

  wait(op) {
    if (!this.waiting.has(op.f)) this.waiting.set(op.f, []);
    this.waiting.get(op.f).push(op);
    return "pending";
  }

  done(op) {
    this.seen.add(op.id);
    this.version++;
    const n = counterOf(op.id);
    if (n > this.maxN) this.maxN = n;
    return "applied";
  }

  setAside(op) {
    if (this.unknown.length < MAX_UNKNOWN) this.unknown.push(op);
    return "unknown";
  }

  /** A frame as shown, or null. */
  frame(id) {
    const f = this.byId.get(id);
    if (!f) return null;
    const field = (k, d) => (f.fields.has(k) ? f.fields.get(k).v : d);
    return { id: f.id, by: f.by, at: f.at, removed: f.rm % 2 === 1, rm: f.rm, order: field("order", f.o ?? counterOf(f.id)), hold: field("hold", 1) };
  }

  /** The frames there are, first first. */
  frames() {
    const all = [...this.byId.keys()].map((id) => this.frame(id)).filter((f) => !f.removed);
    all.sort((a, b) => a.order - b.order || cmpId(a.id, b.id));
    return all;
  }

  /** How it plays: { fps, loop }. */
  settings() {
    return { fps: this.play.get("fps")?.v ?? DEFAULTS.fps, loop: this.play.get("loop")?.v ?? DEFAULTS.loop, paper: this.play.get("paper")?.v ?? DEFAULTS.paper };
  }
}

/** A new frame; after: the frame it follows (else it goes last). */
export function addFrameOps(clock, doc, { by, at = Date.now(), after = null }) {
  clock.atLeast(doc.maxN);
  const op = { t: "frame", id: clock.next(), by, at };
  if (after) {
    const list = doc.frames();
    const i = list.findIndex((f) => f.id === after);
    if (i >= 0 && i < list.length - 1) op.o = (list[i].order + list[i + 1].order) / 2;
    else if (i >= 0) op.o = list[i].order + 1;
  }
  return { ops: [op], atoms: [{ k: "frame+", f: op.id }], id: op.id };
}

/** Changes a frame's place or hold; the atom remembers what they were. */
export function setFrameOps(clock, doc, id, fields) {
  const now = doc.frame(id);
  if (!now) return { ops: [], atoms: [] };
  const v = {};
  const before = {};
  for (const [k, ok] of Object.entries(FRAME_FIELDS)) {
    if (fields[k] === undefined || !ok(fields[k]) || fields[k] === now[k]) continue;
    v[k] = fields[k];
    before[k] = now[k];
  }
  if (!Object.keys(v).length) return { ops: [], atoms: [] };
  clock.atLeast(doc.maxN);
  return { ops: [{ t: "fset", id: clock.next(), f: id, v }], atoms: [{ k: "fset", f: id, before, after: v }] };
}

export function removeFrameOps(clock, doc, id) {
  const now = doc.frame(id);
  if (!now || now.removed) return { ops: [], atoms: [] };
  clock.atLeast(doc.maxN);
  return { ops: [{ t: "frm", id: clock.next(), f: id, n: now.rm + 1 }], atoms: [{ k: "frame-", f: id }] };
}

/** Moves a frame `delta` places later (or earlier); past the ends it stays at the end. */
export function moveFrameOps(clock, doc, id, delta) {
  const list = doc.frames();
  const at = list.findIndex((f) => f.id === id);
  if (at < 0 || !delta) return { ops: [], atoms: [] };
  const rest = list.filter((f) => f.id !== id);
  const to = Math.max(0, Math.min(rest.length, at + delta));
  if (to === at) return { ops: [], atoms: [] };
  const before = rest[to - 1];
  const after = rest[to];
  const order = !before ? after.order - 1 : !after ? before.order + 1 : (before.order + after.order) / 2;
  return setFrameOps(clock, doc, id, { order });
}

/** How the whole plays (fps, loop). */
export function setAnimOps(clock, doc, fields) {
  const now = doc.settings();
  const v = {};
  const before = {};
  for (const [k, ok] of Object.entries(ANIM_FIELDS)) {
    if (fields[k] === undefined || !ok(fields[k]) || fields[k] === now[k]) continue;
    v[k] = fields[k];
    before[k] = now[k];
  }
  if (!Object.keys(v).length) return { ops: [], atoms: [] };
  clock.atLeast(doc.maxN);
  return { ops: [{ t: "aset", id: clock.next(), v }], atoms: [{ k: "aset", before, after: v }] };
}

/** Undo or redo, judged against the frames as they are now. */
export function invertAnimOps(doc, clock, atoms, dir) {
  const ops = [];
  const flip = (id, wantRemoved) => {
    const now = doc.frame(id);
    if (!now || now.removed === wantRemoved) return;
    clock.atLeast(doc.maxN);
    ops.push({ t: "frm", id: clock.next(), f: id, n: now.rm + 1 });
  };
  const list = dir === "undo" ? atoms.slice().reverse() : atoms;
  for (const atom of list) {
    if (atom.k === "frame+") flip(atom.f, dir === "undo");
    else if (atom.k === "frame-") flip(atom.f, dir !== "undo");
    else if (atom.k === "fset" && doc.frame(atom.f)) {
      clock.atLeast(doc.maxN);
      ops.push({ t: "fset", id: clock.next(), f: atom.f, v: { ...(dir === "undo" ? atom.before : atom.after) } });
    } else if (atom.k === "aset") {
      clock.atLeast(doc.maxN);
      ops.push({ t: "aset", id: clock.next(), v: { ...(dir === "undo" ? atom.before : atom.after) } });
    }
  }
  return ops;
}

/** Every tick of one pass, frames repeated by their hold: [{ id, tick }]. */
export function timeline(doc) {
  const out = [];
  for (const f of doc.frames()) for (let i = 0; i < f.hold; i++) out.push({ id: f.id, tick: out.length });
  return out;
}

/**
 * The frames of one play through (each as many times as it is held), as a saved video shows them:
 * once from the first to the last; 왕복 there and back, stopping before the first comes again.
 */
export function onePass(doc) {
  const line = timeline(doc).map((t) => t.id);
  if (doc.settings().loop !== "pingpong" || line.length < 3) return line;
  return [...line, ...line.slice(1, -1).reverse()];
}

/** The frame shown at a tick, as the animation plays (looping, back and forth, or once). */
export function frameAt(doc, tick) {
  const line = timeline(doc);
  if (!line.length) return null;
  const n = line.length;
  const { loop } = doc.settings();
  let i;
  if (loop === "once") i = Math.min(n - 1, Math.max(0, tick));
  else if (loop === "pingpong" && n > 1) {
    const period = 2 * n - 2;
    const k = ((tick % period) + period) % period;
    i = k < n ? k : period - k;
  } else i = ((tick % n) + n) % n;
  return line[i].id;
}
