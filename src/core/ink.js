// Drawings: pen strokes on a surface, shared like everything else.
//
// A stroke never changes once drawn; erasing hides it with the same removes
// counter as text (odd = hidden, larger counter wins), so undo and redo work
// and two devices always agree. Strokes are drawn in id order.
//
// Points are whole numbers in hundredths of a rem from the surface's top
// left, with pressure 0..100: the same place on every screen size, because
// the whole layout is measured in rem.
//
//   stroke  { id, pts: [x, y, p, x, y, p, …], c: colour, w: width, by, at }
//   srm     { id, s: stroke id, n: removes counter }
//
// Used by the text room's sheets ("k:<day>" documents) and meant for the
// photo room and the whiteboard as well.

import { cmpId, validId } from "./crdt.js";

/** Pen colours: 빨주노초파남보 and 검정 (drawn white in the dark theme). */
export const INK_COLORS = ["red", "orange", "yellow", "green", "blue", "indigo", "violet", "black"];
export const INK_WIDTHS = [1, 2, 3];
const MAX_POINTS = 3000;
const MAX_UNKNOWN = 300;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const COLOR_OK = (c) => INK_COLORS.includes(c) || (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c));

export class InkDoc {
  constructor() {
    this.version = 0;
    this.byId = new Map();
    this.waiting = new Map();
    this.seen = new Set();
    this.unknown = [];
    this.maxN = 0;
    this.cache = null;
  }

  apply(op) {
    if (!op || typeof op !== "object" || !validId(op.id)) return this.setAside(op);
    if (this.seen.has(op.id)) return "dup";
    if (op.t === "stroke") {
      const ok = Array.isArray(op.pts) && op.pts.length >= 3 && op.pts.length % 3 === 0 && op.pts.length <= MAX_POINTS * 3 &&
        op.pts.every((v, i) => (i % 3 === 2 ? isInt(v, 0, 100) : isInt(v, -100000, 1000000))) &&
        COLOR_OK(op.c) && INK_WIDTHS.includes(op.w) && typeof op.by === "string" && op.by.length <= 40 && Number.isFinite(op.at);
      if (!ok) return this.setAside(op);
      this.byId.set(op.id, { id: op.id, pts: op.pts, c: op.c, w: op.w, by: op.by, at: op.at, rm: 0 });
      this.done(op);
      for (const waiting of this.waiting.get(op.id) || []) this.apply(waiting);
      this.waiting.delete(op.id);
      return "applied";
    }
    if (op.t === "srm") {
      if (!validId(op.s) || !isInt(op.n, 1, 1e9)) return this.setAside(op);
      const stroke = this.byId.get(op.s);
      if (!stroke) {
        if (!this.waiting.has(op.s)) this.waiting.set(op.s, []);
        this.waiting.get(op.s).push(op);
        return "pending";
      }
      if (op.n > stroke.rm) stroke.rm = op.n;
      return this.done(op);
    }
    return this.setAside(op);
  }

  applyAll(ops) {
    const before = this.version;
    for (const op of ops) this.apply(op);
    return this.version !== before;
  }

  done(op) {
    this.seen.add(op.id);
    this.version++;
    const n = Number(op.id.slice(0, op.id.indexOf("@")));
    if (n > this.maxN) this.maxN = n;
    return "applied";
  }

  setAside(op) {
    if (this.unknown.length < MAX_UNKNOWN) this.unknown.push(op);
    return "unknown";
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  /** Visible strokes, oldest first (the order they are painted in). */
  strokes() {
    if (this.cache && this.cache.version === this.version) return this.cache.list;
    const list = [...this.byId.values()].filter((s) => s.rm % 2 === 0).sort((a, b) => cmpId(a.id, b.id));
    this.cache = { version: this.version, list };
    return list;
  }

  /** The topmost visible stroke passing within `radius` of (x, y), or null. */
  strokeAt(x, y, radius) {
    const list = this.strokes();
    for (let i = list.length - 1; i >= 0; i--) {
      const pts = list[i].pts;
      const reach = radius + list[i].w * 12;
      for (let j = 0; j < pts.length; j += 3) {
        const x2 = pts[j + 3] ?? pts[j];
        const y2 = pts[j + 4] ?? pts[j + 1];
        if (distToSegment(x, y, pts[j], pts[j + 1], x2, y2) <= reach) return list[i].id;
      }
    }
    return null;
  }
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Drops points closer than `min` to the last kept one; keeps the ends. */
export function thinPoints(pts, min = 25) {
  if (pts.length <= 6) return pts.slice();
  const out = pts.slice(0, 3);
  for (let i = 3; i < pts.length - 3; i += 3) {
    const k = out.length - 3;
    if (Math.hypot(pts[i] - out[k], pts[i + 1] - out[k + 1]) >= min) out.push(pts[i], pts[i + 1], pts[i + 2]);
  }
  out.push(...pts.slice(-3));
  return out;
}

export function strokeOps(clock, ink, { pts, color, width, by, at = Date.now() }) {
  clock.atLeast(ink.maxN);
  const op = { t: "stroke", id: clock.next(), pts: thinPoints(pts).slice(0, MAX_POINTS * 3), c: color, w: width, by, at };
  return { ops: [op], atoms: [{ k: "ink+", s: op.id }] };
}

export function eraseOps(clock, ink, strokeId) {
  const stroke = ink.get(strokeId);
  if (!stroke || stroke.rm % 2 === 1) return { ops: [], atoms: [] };
  clock.atLeast(ink.maxN);
  return { ops: [{ t: "srm", id: clock.next(), s: strokeId, n: stroke.rm + 1 }], atoms: [{ k: "ink-", s: strokeId }] };
}

/** Undo or redo of drawing and erasing, judged against the drawing as it is now. */
export function invertInkOps(ink, clock, atoms, dir) {
  clock.atLeast(ink.maxN);
  const undo = dir === "undo";
  const ops = [];
  const counters = new Map();
  for (const atom of undo ? atoms.slice().reverse() : atoms) {
    const stroke = ink.get(atom.s);
    if (!stroke) continue;
    const rm = counters.has(atom.s) ? counters.get(atom.s) : stroke.rm;
    const shown = rm % 2 === 0;
    const want = atom.k === "ink+" ? !undo : undo;
    if (shown === want) continue;
    counters.set(atom.s, rm + 1);
    ops.push({ t: "srm", id: clock.next(), s: atom.s, n: rm + 1 });
  }
  return ops;
}
