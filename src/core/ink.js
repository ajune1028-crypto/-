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
//   stroke  { id, pts: [x, y, p, x, y, p, …], c: colour, w: width, z?: size, b?: brush, s?: style, q?: 1, by, at }
//
// `w` is one of three widths (2, 4, 8 px at 1 rem = 16 px); `z` a size of its own in tenths of a px
// (그림 방's size slider, 0.5 to 40 px), with `w` its nearest width for a device from before.
// `b` is a brush every device knows; `s` names a newer brush (만년필, 붓펜, 에어브러시) that a
// device from before draws as its `b`. `q: 1` is a shape made straight (its points are exact).
//   srm     { id, s: stroke id, n: removes counter }
//
// Used by the text room's sheets ("k:<day>" documents) and meant for the
// photo room and the whiteboard as well.

import { cmpId, validId } from "./crdt.js";

/** Pen colours: 빨주노초파남보 and 검정 (drawn white in the dark theme). */
export const INK_COLORS = ["red", "orange", "yellow", "green", "blue", "indigo", "violet", "black"];
export const INK_WIDTHS = [1, 2, 3];
/** Each width in px at 1 rem = 16 px. */
export const WIDTH_PX = { 1: 2, 2: 4, 3: 8 };
/** A size of one's own (그림 방): 0.5 to 40 px. */
export const SIZE_MIN = 0.5;
export const SIZE_MAX = 40;
/**
 * How a stroke is laid down. "erase" rubs out the strokes under it (an area
 * eraser); whole strokes are hidden with srm instead (the stroke eraser).
 * A stroke without `b` is a pen, as strokes were before brushes.
 */
export const BRUSHES = ["pen", "pencil", "marker", "highlighter", "erase"];
/** Newer brushes, each with the older brush a device from before draws it as. */
export const STYLES = { fountain: "pen", brushpen: "pen", airbrush: "highlighter", sketch: "pencil", crayon: "pencil", fill: "marker", smudge: "highlighter" };
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
        COLOR_OK(op.c) && INK_WIDTHS.includes(op.w) && typeof op.by === "string" && op.by.length <= 40 && Number.isFinite(op.at) &&
        (op.b === undefined || BRUSHES.includes(op.b)) &&
        // A style is a name; one this version does not know is drawn as its brush.
        (op.s === undefined || (typeof op.s === "string" && /^[a-z]{1,20}$/.test(op.s))) &&
        (op.q === undefined || op.q === 1) &&
        (op.z === undefined || isInt(op.z, SIZE_MIN * 10, SIZE_MAX * 10)) &&
        (op.o === undefined || isInt(op.o, 5, 99)) &&
        // 알파 잠금: drawn inside what its layer already had (a 그림 방 layer's lock).
        (op.a === undefined || op.a === 1);
      if (!ok) return this.setAside(op);
      const stroke = { id: op.id, pts: op.pts, c: op.c, w: op.w, b: op.b || "pen", by: op.by, at: op.at, rm: 0 };
      if (op.z) stroke.z = op.z;
      if (op.o) stroke.o = op.o;
      if (op.s) stroke.s = op.s;
      if (op.q) stroke.q = 1;
      if (op.a) stroke.a = 1;
      this.byId.set(op.id, stroke);
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
      if (list[i].b === "erase") continue;
      const pts = list[i].pts;
      const reach = radius + (list[i].z ? (list[i].z / 10) * 6 : list[i].w * 12);
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
// A point is kept when it is this far (stroke units, 0.6 px at 1 rem = 16 px) from the last one kept:
// the hand's fine detail stays (it was 25, 4 px, and small letters came out in straight pieces).
export const THIN_UNITS = 4;

export function thinPoints(pts, min = THIN_UNITS) {
  if (pts.length <= 6) return pts.slice();
  const out = pts.slice(0, 3);
  for (let i = 3; i < pts.length - 3; i += 3) {
    const k = out.length - 3;
    if (Math.hypot(pts[i] - out[k], pts[i + 1] - out[k + 1]) >= min) out.push(pts[i], pts[i + 1], pts[i + 2]);
  }
  out.push(...pts.slice(-3));
  return out;
}

/** The points thinned as little as fits a stroke (MAX_POINTS): a very long line more, never cut short. */
function thinToFit(pts) {
  let min = THIN_UNITS;
  let kept = thinPoints(pts, min);
  while (kept.length > MAX_POINTS * 3) {
    min *= 1.5;
    kept = thinPoints(pts, min);
  }
  return kept;
}

/** The brush a stroke is drawn with: its style where it has one. */
export function brushOf(stroke) {
  return stroke.s || stroke.b || "pen";
}

/** A stroke's width in px at 1 rem = 16 px: its own size, or its width's. */
export function widthOf(stroke) {
  return stroke.z ? stroke.z / 10 : WIDTH_PX[stroke.w] || 4;
}

/** Of the three widths, the one that looks nearest to `px` (halfway between them on a doubling scale). */
export function nearestWidth(px) {
  return px < 2 * Math.SQRT2 ? 1 : px < 4 * Math.SQRT2 ? 2 : 3;
}

export function strokeOps(clock, ink, { pts, color, width, size, by, at = Date.now(), brush = "pen", style, shape = false, opacity, inside = false }) {
  clock.atLeast(ink.maxN);
  // A shape's points are already few and exact (thinning would cut its corners).
  const op = { t: "stroke", id: clock.next(), pts: shape ? pts.slice(0, MAX_POINTS * 3) : thinToFit(pts), c: color, w: width, by, at };
  if (Number.isFinite(size)) {
    op.z = Math.round(Math.max(SIZE_MIN, Math.min(SIZE_MAX, size)) * 10);
    op.w = nearestWidth(op.z / 10);
  }
  // Pen strokes leave `b` out, so devices from before brushes draw them as they always did; a
  // newer brush goes as its style, with the older brush it falls back to.
  if (style === undefined && STYLES[brush]) {
    style = brush;
    brush = STYLES[brush];
  }
  if (brush !== "pen") op.b = brush;
  if (style) op.s = style;
  if (shape) op.q = 1;
  // 불투명 (Procreate's second slider) as a whole percent, 5 to 99; full strength is left out so
  // devices from before it draw the stroke as they always did.
  if (Number.isFinite(opacity) && opacity < 0.995) op.o = Math.max(5, Math.min(99, Math.round(opacity * 100)));
  // 알파 잠금: only over what its layer already had (devices from before it draw it plainly).
  if (inside) op.a = 1;
  return { ops: [op], atoms: [{ k: "ink+", s: op.id }] };
}

/** A stroke's 불투명, 0.05 to 1 (1 when it has none of its own). */
export function opacityOf(stroke) {
  return stroke?.o ? Math.max(5, Math.min(100, stroke.o)) / 100 : 1;
}

export function eraseOps(clock, ink, strokeId) {
  const stroke = ink.get(strokeId);
  if (!stroke || stroke.rm % 2 === 1) return { ops: [], atoms: [] };
  clock.atLeast(ink.maxN);
  return { ops: [{ t: "srm", id: clock.next(), s: strokeId, n: stroke.rm + 1 }], atoms: [{ k: "ink-", s: strokeId }] };
}

/**
 * Strokes moved by (dx, dy) stroke units, as the 올가미 moves what is inside it: each goes and comes
 * back further along (the same colour, width and brush). One undo step puts them back.
 */
export function moveStrokesOps(clock, ink, ids, dx, dy, by) {
  const ops = [];
  const atoms = [];
  for (const id of ids) {
    const s = ink.get(id);
    if (!s || s.rm % 2 === 1) continue;
    const gone = eraseOps(clock, ink, id);
    const pts = s.pts.map((v, i) => (i % 3 === 0 ? Math.round(v + dx) : i % 3 === 1 ? Math.round(v + dy) : v));
    const made = strokeOps(clock, ink, { pts, color: s.c, width: s.w, size: s.z ? s.z / 10 : undefined, by, brush: s.b || "pen", style: s.s, shape: !!s.q, opacity: opacityOf(s), inside: !!s.a });
    ops.push(...gone.ops, ...made.ops);
    atoms.push(...gone.atoms, ...made.atoms);
  }
  return { ops, atoms };
}

/** Inside a closed loop [x, y, x, y, …] (even-odd). */
function insidePolygon(loop, x, y) {
  let inside = false;
  for (let i = 0, j = loop.length - 2; i < loop.length; j = i, i += 2) {
    const xi = loop[i], yi = loop[i + 1], xj = loop[j], yj = loop[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The strokes a lasso holds (the text room's and 그림 방's 올가미; loop in stroke units): more than half
 * of a stroke's points inside the loop, or its middle — as GoodNotes' lasso takes handwriting, and
 * ArtCraft's moodboard lasso takes what it mostly surrounds.
 */
export function strokesWithinLoop(strokes, loop) {
  if (!loop || loop.length < 6) return [];
  const out = [];
  for (const s of strokes) {
    let n = 0, inside = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < s.pts.length; i += 3) {
      const x = s.pts[i], y = s.pts[i + 1];
      n++;
      if (insidePolygon(loop, x, y)) inside++;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (n && (inside * 2 > n || insidePolygon(loop, (x0 + x1) / 2, (y0 + y1) / 2))) out.push(s.id);
  }
  return out;
}

/** Copies of strokes moved by (dx, dy) (the 올가미's 복제); the originals stay. */
export function copyStrokesOps(clock, ink, ids, dx, dy, by) {
  const ops = [];
  const atoms = [];
  for (const id of ids) {
    const s = ink.get(id);
    if (!s || s.rm % 2 === 1) continue;
    const pts = s.pts.map((v, i) => (i % 3 === 0 ? Math.round(v + dx) : i % 3 === 1 ? Math.round(v + dy) : v));
    const made = strokeOps(clock, ink, { pts, color: s.c, width: s.w, size: s.z ? s.z / 10 : undefined, by, brush: s.b || "pen", style: s.s, shape: !!s.q, opacity: opacityOf(s), inside: !!s.a });
    ops.push(...made.ops);
    atoms.push(...made.atoms);
  }
  return { ops, atoms };
}

/** Strokes in another colour (the 올가미's 색 on 그림): each goes and comes back the same but for its colour. */
export function recolorStrokesOps(clock, ink, ids, color, by) {
  const ops = [];
  const atoms = [];
  if (!COLOR_OK(color)) return { ops, atoms };
  for (const id of ids) {
    const s = ink.get(id);
    if (!s || s.rm % 2 === 1 || s.c === color || s.b === "erase") continue;
    const gone = eraseOps(clock, ink, id);
    const made = strokeOps(clock, ink, { pts: s.pts, color, width: s.w, size: s.z ? s.z / 10 : undefined, by, brush: s.b || "pen", style: s.s, shape: !!s.q, opacity: opacityOf(s), inside: !!s.a });
    ops.push(...gone.ops, ...made.ops);
    atoms.push(...gone.atoms, ...made.atoms);
  }
  return { ops, atoms };
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

/**
 * A line that came back on itself: the points it closes round, or null (ends meeting, or crossing itself).
 * `since`: how many of its points (4 px apart) were looked at before, so a line being drawn is only
 * looked at where it grew.
 */
export function closedLoop(path, rem = 16, since = 0) {
  const pts = [];
  for (const p of path) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 4) pts.push(p);
  }
  if (pts.length < 8) return null;
  const length = (list) => list.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - list[i - 1][0], p[1] - list[i - 1][1]) : 0), 0);
  const last = pts[pts.length - 1];
  if (length(pts) > 10 * rem && Math.hypot(last[0] - pts[0][0], last[1] - pts[0][1]) < 2.5 * rem) return pts;
  const cross = (a, b, c, d) => {
    const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
  };
  for (let j = Math.max(1, since); j < pts.length; j++) {
    for (let i = 0; i < j - 2; i++) {
      if (cross(pts[i], pts[i + 1], pts[j - 1], pts[j])) {
        const loop = pts.slice(i + 1, j);
        return length(loop) > 6 * rem ? loop : null;
      }
    }
  }
  return null;
}

/** Stroke units per whiteboard pixel (as on a sheet: hundredths of a 16 px rem). */
export const BOARD_INK_UNIT = 100 / 16;

/**
 * Strokes to carry to another room (비서's 바구니, the day's plan 6.8): their points as the screen px
 * they were seen at (units ÷ unitsPerPx), from their own top left; colour, width, brush, shape and
 * 불투명 as they were. Rubbed-out strokes and the eraser's own are left.
 */
export function carryStrokes(ink, ids, unitsPerPx) {
  const list = ids.map((id) => ink.get(id)).filter((s) => s && s.rm % 2 !== 1 && s.b !== "erase");
  if (!list.length) return [];
  let x0 = Infinity;
  let y0 = Infinity;
  for (const s of list) {
    for (let i = 0; i < s.pts.length; i += 3) {
      if (s.pts[i] < x0) x0 = s.pts[i];
      if (s.pts[i + 1] < y0) y0 = s.pts[i + 1];
    }
  }
  const k = unitsPerPx > 0 ? unitsPerPx : 1;
  const px = (v) => Math.round(v * 10) / 10;
  return list.map((s) => ({
    pts: s.pts.map((v, i) => (i % 3 === 0 ? px((v - x0) / k) : i % 3 === 1 ? px((v - y0) / k) : v)),
    c: s.c,
    w: s.w,
    ...(s.z ? { z: s.z } : {}),
    b: s.b || "pen",
    ...(s.s ? { s: s.s } : {}),
    ...(s.q ? { q: 1 } : {}),
    ...(opacityOf(s) < 1 ? { o: Math.round(opacityOf(s) * 100) } : {}),
  }));
}

/**
 * Carried strokes put down in a layer whose units are px × unitsPerPx, their middle at (cx, cy):
 * new strokes of mine, one undo. `color` may change each stroke's colour on the way (a 그림 방's
 * black stays black).
 */
export function landStrokesOps(clock, ink, carried, unitsPerPx, cx, cy, by, color = (c) => c) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of carried) {
    for (let i = 0; i < (s.pts?.length || 0); i += 3) {
      x0 = Math.min(x0, s.pts[i]);
      x1 = Math.max(x1, s.pts[i]);
      y0 = Math.min(y0, s.pts[i + 1]);
      y1 = Math.max(y1, s.pts[i + 1]);
    }
  }
  if (!Number.isFinite(x0)) return { ops: [], atoms: [] };
  const k = unitsPerPx > 0 ? unitsPerPx : 1;
  const ox = cx - ((x0 + x1) / 2) * k;
  const oy = cy - ((y0 + y1) / 2) * k;
  const ops = [];
  const atoms = [];
  for (const s of carried) {
    if (!Array.isArray(s.pts) || s.pts.length < 3) continue;
    const pts = s.pts.map((v, i) => (i % 3 === 0 ? Math.round(ox + v * k) : i % 3 === 1 ? Math.round(oy + v * k) : v));
    const made = strokeOps(clock, ink, { pts, color: color(s.c), width: s.w, size: s.z ? s.z / 10 : undefined, by, brush: s.b || "pen", style: s.s, shape: !!s.q, opacity: s.o ? s.o / 100 : undefined });
    ops.push(...made.ops);
    atoms.push(...made.atoms);
  }
  return { ops, atoms };
}

/**
 * 아래로 합치기 (그림 방): the strokes of a layer go into the layer below, in their order and on top of
 * what it had, each as it was; the layer above is left empty. Two docs change: { into, from }, each
 * { ops, atoms } for its own doc (one undo takes both back).
 */
export function mergeStrokesOps(clock, above, below, by) {
  const into = { ops: [], atoms: [] };
  const from = { ops: [], atoms: [] };
  clock.atLeast(Math.max(above.maxN, below.maxN));
  for (const s of above.strokes()) {
    const made = strokeOps(clock, below, { pts: s.pts, color: s.c, width: s.w, size: s.z ? s.z / 10 : undefined, by, brush: s.b || "pen", style: s.s, shape: true, opacity: opacityOf(s), inside: !!s.a });
    into.ops.push(...made.ops);
    into.atoms.push(...made.atoms);
    const gone = eraseOps(clock, above, s.id);
    from.ops.push(...gone.ops);
    from.atoms.push(...gone.atoms);
  }
  return { into, from };
}
