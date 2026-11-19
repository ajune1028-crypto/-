import test from "node:test";
import assert from "node:assert/strict";
import { strokePoints, outline, dabs, quickShape, adjustShape, hasPressure, brushLook } from "../src/core/brush.js";

const flat = (list) => list.flatMap(([x, y, p = 50]) => [Math.round(x), Math.round(y), p]);
const line = (from, to, n, p = () => 50) => Array.from({ length: n }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / (n - 1), from[1] + ((to[1] - from[1]) * i) / (n - 1), p(i / (n - 1))]);
const ys = (poly) => poly.filter((_, i) => i % 2 === 1);
const xs = (poly) => poly.filter((_, i) => i % 2 === 0);
/** The outline's height across the line at x (for a line along x). */
function widthAt(poly, x) {
  const near = [];
  for (let i = 0; i < poly.length; i += 2) if (Math.abs(poly[i] - x) < 12) near.push(poly[i + 1]);
  return near.length ? Math.max(...near) - Math.min(...near) : 0;
}

test("strokePoints: streamline 0 follows the hand exactly; the last point is always where the hand is", () => {
  const pts = flat([[0, 0], [30, 10], [60, 0], [90, 15]]);
  const exact = strokePoints(pts, { streamline: 0 });
  assert.deepEqual(exact.map((p) => [p.x, p.y]), [[0, 0], [30, 10], [60, 0], [90, 15]]);
  const smooth = strokePoints(pts, { streamline: 0.8 });
  assert.deepEqual([smooth.at(-1).x, smooth.at(-1).y], [90, 15]);
  assert.ok(Math.abs(smooth[1].y) < 10, "a middle point is eased toward the line");
});

test("outline: a straight line at middle pressure is as wide as its size; a dot is round", () => {
  const poly = outline(strokePoints(flat(line([0, 100], [600, 100], 25)), { streamline: 0 }), { size: 40, thinning: 0.5 });
  const h = widthAt(poly, 300);
  assert.ok(Math.abs(h - 40) < 3, "width " + h);
  assert.ok(Math.min(...xs(poly)) < 0 && Math.max(...xs(poly)) > 600, "round ends past the ends");
  const dot = outline(strokePoints(flat([[50, 50]])), { size: 20, thinning: 0 });
  assert.ok(Math.abs(Math.max(...ys(dot)) - Math.min(...ys(dot)) - 20) < 1);
});

test("outline: harder pressure, a wider line; thinning 0 ignores pressure", () => {
  const press = (p) => outline(strokePoints(flat(line([0, 0], [600, 0], 25, () => p)), { streamline: 0 }), { size: 40, thinning: 0.6 });
  assert.ok(widthAt(press(95), 300) > widthAt(press(20), 300) * 1.8);
  const even = (p) => outline(strokePoints(flat(line([0, 0], [600, 0], 25, () => p)), { streamline: 0 }), { size: 40, thinning: 0 });
  assert.ok(Math.abs(widthAt(even(95), 300) - widthAt(even(20), 300)) < 1);
});

test("outline: a tapered line comes to a point at both ends", () => {
  const poly = outline(strokePoints(flat(line([0, 0], [800, 0], 33)), { streamline: 0 }), { size: 40, thinning: 0.5, taperStart: 120, taperEnd: 160 });
  assert.ok(widthAt(poly, 400) > 30);
  assert.ok(widthAt(poly, 30) < widthAt(poly, 400) * 0.6, "thin at the start");
  assert.ok(widthAt(poly, 780) < widthAt(poly, 400) * 0.5, "thin at the end");
});

test("outline: a fountain nib is wide across it and thin along it", () => {
  const across = outline(strokePoints(flat(line([0, 0], [500, 500], 30)), { streamline: 0 }), { size: 40, thinning: 0, nib: true });
  const alongNib = outline(strokePoints(flat(line([0, 500], [500, 0], 30)), { streamline: 0 }), { size: 40, thinning: 0, nib: true });
  const span = (poly) => {
    // Distance of the outline from the line's middle, sideways.
    let worst = 0;
    for (let i = 0; i < poly.length; i += 2) {
      const [x, y] = [poly[i], poly[i + 1]];
      if (Math.abs(x - 250) > 60) continue;
      worst = Math.max(worst, Math.abs(x - y) / Math.SQRT2, Math.abs(x + y - 500) / Math.SQRT2);
    }
    return worst;
  };
  // across: line y = x (down-right); sideways is |x - y|. along: y = 500 - x; sideways |x + y - 500|.
  const wide = (() => { let w = 0; for (let i = 0; i < across.length; i += 2) if (Math.abs(across[i] - 250) < 60) w = Math.max(w, Math.abs(across[i] - across[i + 1]) / Math.SQRT2); return w; })();
  const thin = (() => { let w = 0; for (let i = 0; i < alongNib.length; i += 2) if (Math.abs(alongNib[i] - 250) < 60) w = Math.max(w, Math.abs(alongNib[i] + alongNib[i + 1] - 500) / Math.SQRT2); return w; })();
  assert.ok(span(across) > 0 && wide > thin * 2.5, `across ${wide}, along ${thin}`);
});

test("outline: without pressure, a quick hand draws thinner than a slow one", () => {
  // The same long line: a slow hand leaves points close together, a quick one far apart.
  const slow = outline(strokePoints(flat(line([0, 0], [1800, 0], 61)), { streamline: 0 }), { size: 40, thinning: 0.7, simulate: true });
  const quick = outline(strokePoints(flat(line([0, 0], [1800, 0], 13)), { streamline: 0 }), { size: 40, thinning: 0.7, simulate: true });
  assert.ok(widthAt(slow, 900) > widthAt(quick, 900) * 1.4, `slow ${widthAt(slow, 900)}, quick ${widthAt(quick, 900)}`);
});

test("the same points draw the same shape every time (a friend sees exactly the same line)", () => {
  const pts = flat(line([0, 0], [700, 230], 40, (t) => 30 + 60 * Math.sin(t * 3)));
  const a = outline(strokePoints(pts, { streamline: 0.5 }), { size: 33, thinning: 0.7, taperEnd: 90 });
  const b = outline(strokePoints(pts.slice(), { streamline: 0.5 }), { size: 33, thinning: 0.7, taperEnd: 90 });
  assert.deepEqual(a, b);
});

test("dabs: one mark every step along the line", () => {
  const marks = dabs(strokePoints(flat(line([0, 0], [1000, 0], 11)), { streamline: 0 }), { step: 10 });
  assert.equal(marks.length, 101);
  assert.ok(marks.every((m, i) => Math.abs(m.x - i * 10) < 1e-6));
});

test("hasPressure: a pen's varying pressure, not a finger's steady 50", () => {
  assert.equal(hasPressure(flat(line([0, 0], [100, 0], 5))), false);
  assert.equal(hasPressure(flat(line([0, 0], [100, 0], 5, (t) => 30 + t * 40))), true);
  assert.equal(brushLook("nonsense"), brushLook("pen"));
});

// Hand-drawn shapes: a little shake on every point.
const shake = (list, amount = 6) => list.map(([x, y], i) => [x + Math.sin(i * 1.7) * amount, y + Math.cos(i * 2.3) * amount]);
const circle = (cx, cy, r, n = 40, from = 0, to = Math.PI * 2) => Array.from({ length: n }, (_, i) => [cx + Math.cos(from + ((to - from) * i) / (n - 1)) * r, cy + Math.sin(from + ((to - from) * i) / (n - 1)) * r]);
const poly = (corners, per = 10) => {
  const out = [];
  for (let i = 0; i < corners.length; i++) out.push(...line(corners[i], corners[(i + 1) % corners.length], per).slice(0, -1).map(([x, y]) => [x, y]));
  out.push(corners[0]);
  return out;
};

test("quickShape: a shaky straight line becomes a straight line from its start to its end", () => {
  const s = quickShape(flat(shake(line([100, 100], [700, 300], 30).map(([x, y]) => [x, y]), 5)));
  assert.equal(s?.kind, "line");
  assert.ok(Math.abs(s.pts[0] - 100) < 8 && Math.abs(s.pts.at(-3) - 700) < 8);
  // Every point lies on the straight line.
  for (let i = 0; i < s.pts.length; i += 3) assert.ok(Math.abs((s.pts[i + 1] - 100) - (s.pts[i] - 100) / 3) < 3);
});

test("quickShape: a shaky circle becomes a circle; a wide one an ellipse", () => {
  const c = quickShape(flat(shake(circle(400, 400, 200, 48), 7)));
  assert.equal(c?.kind, "circle");
  for (let i = 0; i < c.pts.length; i += 3) assert.ok(Math.abs(Math.hypot(c.pts[i] - 400, c.pts[i + 1] - 400) - 200) < 14);
  const e = quickShape(flat(shake(circle(400, 400, 1, 48).map(([x, y]) => [400 + (x - 400) * 300, 400 + (y - 400) * 140]), 5)));
  assert.equal(e?.kind, "ellipse");
});

test("quickShape: a shaky rectangle becomes an upright rectangle; three corners a triangle", () => {
  const r = quickShape(flat(shake(poly([[100, 100], [600, 100], [600, 400], [100, 400]], 12), 6)));
  assert.equal(r?.kind, "rect");
  const xsOf = new Set();
  for (let i = 0; i < r.pts.length; i += 3) xsOf.add(Math.round(r.pts[i] / 20));
  assert.ok(r.pts.every((v, i) => i % 3 !== 0 || Math.abs(v - 100) < 12 || Math.abs(v - 600) < 12 || (v > 100 && v < 600)));
  const t = quickShape(flat(shake(poly([[300, 100], [600, 500], [100, 500]], 14), 5)));
  assert.equal(t?.kind, "triangle");
});

test("quickShape: a wave, a scribble, an open curve and a tiny line stay as drawn", () => {
  const wave = Array.from({ length: 40 }, (_, i) => [i * 20, 300 + Math.sin(i / 3) * 80]);
  assert.equal(quickShape(flat(wave)), null);
  const scribble = Array.from({ length: 50 }, (_, i) => [300 + Math.sin(i * 1.3) * 150, 300 + Math.cos(i * 0.7) * 150 + i * 3]);
  assert.equal(quickShape(flat(scribble)), null);
  assert.equal(quickShape(flat(circle(400, 400, 200, 30, 0, Math.PI))), null, "half a circle is open");
  assert.equal(quickShape(flat(circle(400, 400, 200, 40, 0, Math.PI * 1.55))), null, "a C is open too");
  assert.equal(quickShape(flat(line([0, 0], [80, 10], 6))), null, "too short to mean a shape");
});

test("adjustShape: a line's end follows the hand; a circle grows as the hand moves out", () => {
  const l = quickShape(flat(line([100, 100], [500, 100], 20)));
  const moved = adjustShape(l, [500, 100], [500, 400]);
  assert.deepEqual(moved.pts.slice(-3, -1), [500, 400]);
  assert.deepEqual(moved.pts.slice(0, 2), [100, 100]);
  const c = quickShape(flat(shake(circle(400, 400, 200, 48), 4)));
  const big = adjustShape(c, [600, 400], [800, 400]);
  assert.ok(Math.abs(Math.hypot(big.pts[0] - 400, big.pts[1] - 400) - 400) < 30);
});
