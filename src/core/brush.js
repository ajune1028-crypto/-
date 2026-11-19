// Brush geometry: how the points of a stroke become what is painted. Plain maths with no screen,
// the same on every device, so a friend's screen draws a line exactly as it was drawn.
//
// The pens' outline (strokePoints, outline) is adapted from perfect-freehand by Steve Ruiz,
// MIT License, Copyright (c) 2021 Stephen Ruiz Ltd. Permission is hereby granted, free of charge,
// to any person obtaining a copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
// Software, and to permit persons to whom the Software is furnished to do so, subject to the
// following conditions: The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
// WITHOUT WARRANTY OF ANY KIND (full text in THIRD_PARTY.md).
// Changed here: flat point lists, pressure from the hand's speed where a finger gives none, a
// fountain pen's slanted nib, and shapes made straight when the hand rests (quickShape).
//
// Points: [x, y, p, x, y, p, …] with p the pen's pressure 0..100 (50 throughout from a finger
// or a mouse). Units are the drawing's own (hundredths of a rem).

/**
 * How each brush is drawn.
 *   outline   a filled shape around the line, as wide as the pressure (pens, marker, highlighter)
 *   dabs      many small marks along the line (pencil grain, airbrush mist)
 * scale: size against the chosen width; thinning: how much pressure changes the width (a finger's
 * speed stands in for pressure where fingerThinning is given); streamline: how much the hand's
 * shake is smoothed; taperStart/taperEnd: the ends thin out over that many sizes; nib: a flat nib
 * held at 45°; flat: square ends.
 */
export const BRUSH_LOOKS = {
  pen: { kind: "outline", scale: 1, alpha: 1, thinning: 0.45, fingerThinning: 0.22, streamline: 0.45 },
  fountain: { kind: "outline", scale: 1.3, alpha: 1, thinning: 0.5, fingerThinning: 0.4, streamline: 0.5, taperEnd: 1.2, nib: true },
  brushpen: { kind: "outline", scale: 1.7, alpha: 1, thinning: 0.78, fingerThinning: 0.72, streamline: 0.55, taperStart: 2.2, taperEnd: 3 },
  pencil: { kind: "dabs", scale: 0.9, alpha: 0.9, spacing: 0.28, grain: true },
  marker: { kind: "outline", scale: 1.6, alpha: 1, thinning: 0, streamline: 0.5 },
  airbrush: { kind: "dabs", scale: 4.2, alpha: 0.2, spacing: 0.16, soft: true },
  highlighter: { kind: "outline", scale: 3.4, alpha: 0.32, thinning: 0, streamline: 0.62, flat: true },
  sketch: { kind: "sketch", scale: 1, alpha: 0.85, streamline: 0.35 },
  crayon: { kind: "dabs", scale: 1.7, alpha: 0.7, spacing: 0.24, crayon: true, streamline: 0.4 },
  erase: { kind: "outline", scale: 3.2, alpha: 1, thinning: 0, streamline: 0.3 },
};

export function brushLook(brush) {
  return BRUSH_LOOKS[brush] || BRUSH_LOOKS.pen;
}

/** Whether the pressures came from a pen (they vary); a finger or a mouse gives 50 throughout. */
export function hasPressure(pts) {
  for (let i = 2; i < pts.length; i += 3) if (pts[i] !== 50) return true;
  return false;
}

/**
 * The line as the brush follows it: each point eased toward the hand by `streamline` (0 follows
 * exactly), the last one where the hand is. Each point: { x, y, p (0..1), vx, vy (the unit step
 * back to the point before), d (that step's length), run (length so far) }.
 */
export function strokePoints(pts, { streamline = 0.5 } = {}) {
  const n = Math.floor(pts.length / 3);
  if (!n) return [];
  const t = 0.15 + (1 - streamline) * 0.85;
  const out = [{ x: pts[0], y: pts[1], p: pts[2] / 100, vx: 0, vy: 0, d: 0, run: 0 }];
  let px = pts[0];
  let py = pts[1];
  let run = 0;
  for (let i = 1; i < n; i++) {
    const ix = pts[i * 3];
    const iy = pts[i * 3 + 1];
    const x = i === n - 1 ? ix : px + (ix - px) * t;
    const y = i === n - 1 ? iy : py + (iy - py) * t;
    if (x === px && y === py) continue;
    const d = Math.hypot(x - px, y - py);
    run += d;
    out.push({ x, y, p: pts[i * 3 + 2] / 100, vx: (px - x) / d, vy: (py - y) / d, d, run });
    px = x;
    py = y;
  }
  if (out.length > 1) {
    out[0].vx = out[1].vx;
    out[0].vy = out[1].vy;
  }
  return out;
}

// A finger gives no pressure: a slow hand presses, a quick one skims (as a pen does). d is the
// step between points; drawn points are at least 25 units apart, more the faster the hand.
function speedPressure(prev, d) {
  const v = Math.min(1, Math.max(0, (d - 26) / 150));
  const target = 1 - 0.7 * v;
  return prev + (target - prev) * 0.32;
}

const PI = Math.PI + 0.0001;
const rot = (x, y, cx, cy, r) => {
  const s = Math.sin(r);
  const c = Math.cos(r);
  const px = x - cx;
  const py = y - cy;
  return [px * c - py * s + cx, px * s + py * c + cy];
};
// A flat nib held at 45° (lower left to upper right): strokes across it are wide, along it thin.
const NIB = Math.SQRT1_2;
const nibWidth = (vx, vy) => 0.28 + 0.72 * Math.abs(vx * -NIB - vy * NIB);

/**
 * The shape around the line, as [x, y, x, y, …] in drawing order (fill it). Options: size (the
 * width at middle pressure), thinning, smoothing (how close outline points may be), simulate
 * (pressure from speed), taperStart/taperEnd (distances), nib, flat.
 */
export function outline(points, { size, thinning = 0.5, smoothing = 0.5, simulate = false, taperStart = 0, taperEnd = 0, nib = false, flat = false } = {}) {
  if (!points.length || !(size > 0)) return [];
  const radiusAt = (pressure) => size * (0.5 - thinning * (0.5 - pressure));
  if (points.length === 1) {
    const r = Math.max(0.5, thinning ? radiusAt(simulate ? 0.7 : points[0].p) : size / 2);
    const dot = [];
    for (let i = 0; i < 16; i++) dot.push(points[0].x + Math.cos((i / 16) * Math.PI * 2) * r, points[0].y + Math.sin((i / 16) * Math.PI * 2) * r);
    return dot;
  }
  const total = points[points.length - 1].run;
  const tStart = Math.min(taperStart, total * 0.45);
  const tEnd = Math.min(taperEnd, total * 0.55);
  const minDistance = (size * smoothing) ** 2;
  const left = [];
  const right = [];
  let prevPressure = simulate ? 0.6 : points[0].p;
  if (simulate) for (const pt of points.slice(0, 6)) prevPressure = speedPressure(prevPressure, pt.d || 26);
  let radius = size / 2;
  let prevVx = points[0].vx;
  let prevVy = points[0].vy;
  let prevL = [points[0].x, points[0].y];
  let prevR = prevL;
  let sharpBefore = false;
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const last = i === points.length - 1;
    // Wobbles in the last few units of a line are the hand leaving the glass.
    if (!last && total - pt.run < 3) continue;
    let pressure = pt.p;
    if (thinning) {
      if (simulate) pressure = speedPressure(prevPressure, pt.d);
      radius = radiusAt(pressure);
    } else radius = size / 2;
    if (nib) radius *= nibWidth(pt.vx, pt.vy);
    const ts = tStart && pt.run < tStart ? (pt.run / tStart) * (2 - pt.run / tStart) : 1;
    const te = tEnd && total - pt.run < tEnd ? 1 - (1 - (total - pt.run) / tEnd) ** 3 : 1;
    radius = Math.max(0.01, radius * Math.min(ts, te));
    const next = last ? pt : points[i + 1];
    const nextDot = last ? 1 : pt.vx * next.vx + pt.vy * next.vy;
    const prevDot = pt.vx * prevVx + pt.vy * prevVy;
    const sharp = prevDot < 0 && !sharpBefore;
    const sharpNext = nextDot < 0;
    if (sharp || sharpNext) {
      // A sharp turn: a round cap at the corner.
      const ox = prevVy * radius;
      const oy = -prevVx * radius;
      for (let k = 0; k <= 13; k++) {
        const t = k / 13;
        const l = rot(pt.x - ox, pt.y - oy, pt.x, pt.y, PI * t);
        const r = rot(pt.x + ox, pt.y + oy, pt.x, pt.y, -PI * t);
        left.push(l);
        right.push(r);
        prevL = l;
        prevR = r;
      }
      if (sharpNext) sharpBefore = true;
      continue;
    }
    sharpBefore = false;
    if (last) {
      const ox = pt.vy * radius;
      const oy = -pt.vx * radius;
      left.push([pt.x - ox, pt.y - oy]);
      right.push([pt.x + ox, pt.y + oy]);
      continue;
    }
    // Sideways from the line, between this step's direction and the next's.
    const mx = next.vx + (pt.vx - next.vx) * nextDot;
    const my = next.vy + (pt.vy - next.vy) * nextDot;
    const ox = my * radius;
    const oy = -mx * radius;
    const l = [pt.x - ox, pt.y - oy];
    if (i <= 1 || (l[0] - prevL[0]) ** 2 + (l[1] - prevL[1]) ** 2 > minDistance) {
      left.push(l);
      prevL = l;
    }
    const r = [pt.x + ox, pt.y + oy];
    if (i <= 1 || (r[0] - prevR[0]) ** 2 + (r[1] - prevR[1]) ** 2 > minDistance) {
      right.push(r);
      prevR = r;
    }
    prevPressure = pressure;
    prevVx = pt.vx;
    prevVy = pt.vy;
  }
  const first = points[0];
  const end = points[points.length - 1];
  const startCap = [];
  const endCap = [];
  if (!tStart && right.length && left.length) {
    if (flat) {
      const cx = (left[0][0] - right[0][0]) / 2;
      const cy = (left[0][1] - right[0][1]) / 2;
      startCap.push([first.x - cx * 1.0, first.y - cy * 1.0], [first.x + cx, first.y + cy]);
    } else {
      for (let k = 1; k <= 13; k++) startCap.push(rot(right[0][0], right[0][1], first.x, first.y, PI * (k / 13)));
    }
  }
  // The end: round, square, or the point a taper comes to.
  const dx = -end.vy;
  const dy = end.vx;
  if (tEnd) endCap.push([end.x, end.y]);
  else if (flat) endCap.push([end.x + dx * radius, end.y + dy * radius], [end.x - dx * radius, end.y - dy * radius]);
  else {
    const sx = end.x + dx * radius;
    const sy = end.y + dy * radius;
    for (let k = 1; k < 29; k++) endCap.push(rot(sx, sy, end.x, end.y, PI * 3 * (k / 29)));
  }
  const ring = left.concat(endCap, right.reverse(), startCap);
  const flatList = [];
  for (const [x, y] of ring) flatList.push(x, y);
  return flatList;
}

/**
 * Marks along the line, `step` apart: [{ x, y, p, i }] (p 0..1, i the mark's number, for a grain
 * that is the same on every screen).
 */
export function dabs(points, { step }) {
  const out = [];
  if (!points.length) return out;
  step = Math.max(1, step);
  out.push({ x: points[0].x, y: points[0].y, p: points[0].p, i: 0 });
  let carry = 0;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    const len = b.d;
    let at = step - carry;
    while (at <= len) {
      const t = at / len;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: a.p + (b.p - a.p) * t, i: out.length });
      at += step;
    }
    carry = len - (at - step);
  }
  return out;
}

// ---- ported brush parts --------------------------------------------------------------------

/**
 * 손떨림 보정: the brush on a string. It waits while the hand moves within `radius`, and is pulled
 * along the line toward the hand when the hand goes further, so the line comes out smooth however
 * the hand shakes. friction (0..1) makes it slower still. Adapted from lazy-brush (Copyright 2018
 * Jan Hug, MIT License; THIRD_PARTY.md).
 */
export class LazyBrush {
  constructor(radius = 0, x = 0, y = 0) {
    this.radius = radius;
    this.x = x;
    this.y = y;
  }

  /** The hand is at (x, y): whether the brush moved (it is then at this.x, this.y). */
  update(x, y, friction = 0) {
    if (!(this.radius > 0)) {
      const moved = x !== this.x || y !== this.y;
      this.x = x;
      this.y = y;
      return moved;
    }
    const dx = x - this.x;
    const dy = y - this.y;
    const d = Math.hypot(dx, dy);
    if (Math.round((d - this.radius) * 10) / 10 <= 0) return false;
    let step = d - this.radius;
    if (friction > 0 && friction < 1) step *= 1 - Math.sqrt(1 - (1 - friction) ** 2);
    this.x += (dx / d) * step;
    this.y += (dy / d) * step;
    return true;
  }
}

/**
 * 스케치: besides the line itself, faint strokes join each point to the earlier points near it, the
 * nearer the likelier, as Harmony's sketchy brush (Mr.doob) does in Klecks (bitbof, MIT License).
 * The chance for each pair of points comes from the stroke's seed, so every device draws the same
 * strokes, and those of a line still being drawn stay as it grows. Returns [x1, y1, x2, y2, …].
 */
export function sketchLines(points, { reach, seed = 0 }) {
  const out = [];
  if (points.length < 2 || !(reach > 0)) return out;
  const r2 = reach * reach;
  const grid = new Map();
  for (let c = 0; c < points.length; c++) {
    const p = points[c];
    const cx = Math.floor(p.x / reach);
    const cy = Math.floor(p.y / reach);
    const near = [];
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const list = grid.get(gx + "," + gy);
      if (list) near.push(...list);
    }
    near.sort((a, b) => a - b);
    for (const e of near) {
      const q = points[e];
      const b = q.x - p.x;
      const a = q.y - p.y;
      const g = b * b + a * a;
      if (g < r2 && (wobble(c * 3001 + e, seed) + 1) / 2 > g / r2) out.push(p.x + b * 0.3, p.y + a * 0.3, q.x - b * 0.3, q.y - a * 0.3);
    }
    const k = cx + "," + cy;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(c);
  }
  return out;
}

/**
 * 크레용: each mark along the line a little different, as in Easy-Brush's shape, scatter and
 * transparency dynamics (DQLean, MIT License): size between 60% and full, flattened to 45–85% and
 * slanted about the way the line goes, scattered a little around it, of uneven strength. With a
 * pen's pressure, harder is bigger and stronger. The same marks every time (a friend's screen too).
 */
export function crayonMarks(marks, { size, seed = 0, pressure = false }) {
  const half = size / 2;
  return marks.map((m, i) => {
    const u = (k) => (wobble(i * 7 + k, seed) + 1) / 2;
    const prev = marks[Math.max(0, i - 1)];
    const next = marks[Math.min(marks.length - 1, i + 1)];
    const way = Math.atan2(next.y - prev.y, next.x - prev.x) || 0;
    const press = pressure ? 0.55 + 0.45 * m.p : 1;
    const rx = half * (1 - 0.4 * u(0)) * press;
    const ry = rx * (0.45 + 0.4 * u(1));
    const across = half * 0.6 * (u(3) * 2 - 1);
    const along = half * 0.3 * (u(4) * 2 - 1);
    return {
      x: m.x + Math.cos(way) * along - Math.sin(way) * across,
      y: m.y + Math.sin(way) * along + Math.cos(way) * across,
      rx,
      ry,
      angle: way + (u(2) - 0.5) * 0.9,
      alpha: (0.55 + 0.45 * u(5)) * (pressure ? 0.45 + 0.55 * m.p : 1),
    };
  });
}

/** A small number in -1..1 that is always the same for the same mark (pencil grain). */
export function wobble(i, seed = 0) {
  let h = Math.imul((i + 1) ^ Math.imul(seed | 0, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

// ---- shapes: a line, a circle, an ellipse, a triangle or a rectangle when the hand rests -------

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function toSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

/** The path evenly spaced into n points. */
function resample(path, n) {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += dist(path[i - 1], path[i]);
  if (!total) return path.slice(0, 1);
  const step = total / (n - 1);
  const out = [path[0]];
  let carry = 0;
  for (let i = 1; i < path.length && out.length < n; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = dist(a, b);
    let at = step - carry;
    while (at <= len && out.length < n) {
      const t = at / len;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      at += step;
    }
    carry = len - (at - step);
  }
  while (out.length < n) out.push(path[path.length - 1]);
  return out;
}

/** Ramer–Douglas–Peucker: the points a path cannot do without. */
function simplify(path, eps) {
  if (path.length < 3) return path.slice();
  let worst = 0;
  let at = 0;
  for (let i = 1; i < path.length - 1; i++) {
    const d = toSegment(path[i], path[0], path[path.length - 1]);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= eps) return [path[0], path[path.length - 1]];
  return simplify(path.slice(0, at + 1), eps).slice(0, -1).concat(simplify(path.slice(at), eps));
}

/** The corners of a closed path (it is cut at its point farthest from the start). */
function corners(ring, eps) {
  let far = 0;
  for (let i = 1; i < ring.length; i++) if (dist(ring[i], ring[0]) > dist(ring[far], ring[0])) far = i;
  const a = simplify(ring.slice(0, far + 1), eps);
  const b = simplify(ring.slice(far).concat([ring[0]]), eps);
  let list = a.slice(0, -1).concat(b.slice(0, -1));
  // The start of the drawing is seldom a corner: drop it when the path runs straight through it.
  let changed = true;
  while (changed && list.length > 3) {
    changed = false;
    for (let i = 0; i < list.length; i++) {
      const prev = list[(i - 1 + list.length) % list.length];
      const next = list[(i + 1) % list.length];
      if (toSegment(list[i], prev, next) < eps * 0.9) {
        list.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return list;
}

function angleAt(prev, at, next) {
  const ax = prev[0] - at[0];
  const ay = prev[1] - at[1];
  const bx = next[0] - at[0];
  const by = next[1] - at[1];
  return (Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1)))) * 180) / Math.PI;
}

/** Points along the corners (closing back to the first when `closed`), about `step` apart, corners kept. */
function along(vertices, p, closed, step = 30) {
  const list = closed ? vertices.concat([vertices[0]]) : vertices;
  const out = [];
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i];
    const b = list[i + 1];
    const n = Math.max(1, Math.round(dist(a, b) / step));
    for (let k = 0; k < n; k++) out.push(Math.round(a[0] + ((b[0] - a[0]) * k) / n), Math.round(a[1] + ((b[1] - a[1]) * k) / n), p);
  }
  const z = list[list.length - 1];
  out.push(Math.round(z[0]), Math.round(z[1]), p);
  return out;
}

function ellipsePoints(cx, cy, rx, ry, p, from = 0) {
  const n = Math.max(24, Math.min(96, Math.round((Math.PI * (rx + ry)) / 18)));
  const out = [];
  for (let k = 0; k <= n; k++) {
    const a = from + (k / n) * Math.PI * 2;
    out.push(Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry), p);
  }
  return out;
}

/**
 * What a hand-drawn line was meant to be, when it is clearly one of: a straight line, a circle, an
 * ellipse, a triangle or a rectangle (a four-cornered shape). { kind, pts, center } or null. A
 * scribble, a wave or an open curve stays as drawn.
 */
export function quickShape(pts) {
  const n = Math.floor(pts.length / 3);
  if (n < 4) return null;
  const path = [];
  const ps = [];
  for (let i = 0; i < n; i++) {
    path.push([pts[i * 3], pts[i * 3 + 1]]);
    ps.push(pts[i * 3 + 2]);
  }
  ps.sort((a, b) => a - b);
  const p = ps[ps.length >> 1];
  let total = 0;
  for (let i = 1; i < n; i++) total += dist(path[i - 1], path[i]);
  if (total < 160) return null;
  const a = path[0];
  const b = path[n - 1];
  const chord = dist(a, b);
  if (chord > 0.8 * total) {
    let off = 0;
    for (const q of path) off = Math.max(off, toSegment(q, a, b));
    if (off > Math.max(0.07 * chord, 14)) return null;
    // The straightest line through all of it (not through the shaky first and last points): its
    // ends are where the drawing began and ended, set onto that line.
    const even = resample(path, 48);
    let mx = 0;
    let my = 0;
    for (const [x, y] of even) {
      mx += x / even.length;
      my += y / even.length;
    }
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const [x, y] of even) {
      sxx += (x - mx) ** 2;
      sxy += (x - mx) * (y - my);
      syy += (y - my) ** 2;
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const onto = ([x, y]) => {
      const t = (x - mx) * ux + (y - my) * uy;
      return [mx + ux * t, my + uy * t];
    };
    const from = onto(a);
    const to = onto(b);
    return { kind: "line", pts: along([from, to], p, false), center: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2] };
  }
  // A closed shape comes back near where it began.
  if (chord > 0.2 * total) return null;
  const ring = resample(path, 72);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (Math.min(w, h) < 0.15 * Math.max(w, h) || Math.max(w, h) < 60) return null;
  const diag = Math.hypot(w, h);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const center = [cx, cy];
  // A polygon with few corners that the drawing keeps close to.
  const cs = corners(ring, diag * 0.06);
  let polyOff = Infinity;
  if (cs.length === 3 || cs.length === 4) {
    polyOff = 0;
    for (const q of ring) {
      let best = Infinity;
      for (let i = 0; i < cs.length; i++) best = Math.min(best, toSegment(q, cs[i], cs[(i + 1) % cs.length]));
      polyOff += best;
    }
    polyOff /= ring.length * diag;
  }
  // An ellipse standing upright through the drawing's box.
  let ellOff = 0;
  for (const [x, y] of ring) ellOff += Math.abs(Math.hypot((x - cx) / (w / 2), (y - cy) / (h / 2)) - 1);
  ellOff /= ring.length;
  if (polyOff < 0.03 && polyOff * 3.2 < ellOff) {
    if (cs.length === 3) return { kind: "triangle", pts: along(cs, p, true), center };
    const square = cs.every((c, i) => Math.abs(angleAt(cs[(i + 3) % 4], c, cs[(i + 1) % 4]) - 90) < 22);
    const level = cs.every((c, i) => {
      const d = cs[(i + 1) % 4];
      const ang = (Math.atan2(d[1] - c[1], d[0] - c[0]) * 180) / Math.PI;
      return Math.abs(((ang % 90) + 90) % 90 - 45) > 33;
    });
    if (square && level) return { kind: "rect", pts: along([[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]], p, true), center };
    return { kind: square ? "rect" : "quad", pts: along(cs, p, true), center };
  }
  if (ellOff < 0.085) {
    const from = Math.atan2(a[1] - cy, a[0] - cx);
    if (Math.abs(w - h) / Math.max(w, h) < 0.14) {
      const r = (w + h) / 4;
      return { kind: "circle", pts: ellipsePoints(cx, cy, r, r, p, from), center };
    }
    return { kind: "ellipse", pts: ellipsePoints(cx, cy, w / 2, h / 2, p, from), center };
  }
  return null;
}

/**
 * A shape just made, adjusted while the hand still holds it: a line's end follows the hand; any
 * other shape grows or shrinks around its middle as the hand moves out or in.
 */
export function adjustShape(shape, from, to) {
  if (shape.kind === "line") {
    const p = shape.pts[2];
    return { ...shape, pts: along([[shape.pts[0], shape.pts[1]], to], p, false) };
  }
  const [cx, cy] = shape.center;
  const k = Math.max(0.1, Math.hypot(to[0] - cx, to[1] - cy) / Math.max(1, Math.hypot(from[0] - cx, from[1] - cy)));
  const pts = shape.pts.slice();
  for (let i = 0; i < pts.length; i += 3) {
    pts[i] = Math.round(cx + (pts[i] - cx) * k);
    pts[i + 1] = Math.round(cy + (pts[i + 1] - cy) * k);
  }
  return { ...shape, pts };
}
