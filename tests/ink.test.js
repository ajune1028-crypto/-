import test from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/core/crdt.js";
import { InkDoc, strokeOps, eraseOps, invertInkOps, thinPoints } from "../src/core/ink.js";
import { rng, shuffle } from "./helpers.js";

const line = (x0, y0, x1, y1, n = 10) => Array.from({ length: n + 1 }, (_, i) => [Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), 50]).flat();

test("a stroke is kept as drawn and painted in id order", () => {
  const ink = new InkDoc();
  const clock = new Clock("a");
  const a = strokeOps(clock, ink, { pts: line(0, 0, 1000, 0), color: "red", width: 2, by: "m1" });
  const b = strokeOps(clock, ink, { pts: line(0, 100, 1000, 100), color: "black", width: 1, by: "m1" });
  ink.applyAll([...b.ops, ...a.ops]);
  assert.deepEqual(ink.strokes().map((s) => s.c), ["red", "black"]);
});

test("the eraser hides the topmost stroke under it; undo brings it back", () => {
  const ink = new InkDoc();
  const clock = new Clock("a");
  const a = strokeOps(clock, ink, { pts: line(0, 0, 1000, 0), color: "red", width: 2, by: "m1" });
  ink.applyAll(a.ops);
  const b = strokeOps(clock, ink, { pts: line(500, -200, 500, 200), color: "blue", width: 2, by: "m1" });
  ink.applyAll(b.ops);
  assert.equal(ink.strokeAt(500, 0, 20), b.ops[0].id, "where they cross, the later one is on top");
  assert.equal(ink.strokeAt(100, 5, 20), a.ops[0].id);
  assert.equal(ink.strokeAt(100, 900, 20), null);
  const erase = eraseOps(clock, ink, b.ops[0].id);
  ink.applyAll(erase.ops);
  assert.equal(ink.strokes().length, 1);
  ink.applyAll(invertInkOps(ink, clock, erase.atoms, "undo"));
  assert.equal(ink.strokes().length, 2);
  ink.applyAll(invertInkOps(ink, clock, b.atoms, "undo"));
  assert.deepEqual(ink.strokes().map((s) => s.c), ["red"]);
});

test("erasing that arrives before its stroke waits for it", () => {
  const ink = new InkDoc();
  assert.equal(ink.apply({ t: "srm", id: "5@b", s: "1@a", n: 1 }), "pending");
  assert.equal(ink.apply({ t: "stroke", id: "1@a", pts: [0, 0, 50, 10, 10, 50], c: "green", w: 1, by: "m", at: 1 }), "applied");
  assert.equal(ink.strokes().length, 0);
});

test("devices that get the same ops in any order see the same drawing", () => {
  const r = rng(9);
  const ops = [];
  const clocks = ["a", "b", "c"].map((x) => new Clock(x));
  const ink = new InkDoc();
  for (let i = 0; i < 40; i++) {
    const clock = clocks[i % 3];
    const strokes = ink.strokes();
    const made = r() < 0.7 || !strokes.length
      ? strokeOps(clock, ink, { pts: line(r() * 1000 | 0, r() * 1000 | 0, r() * 1000 | 0, r() * 1000 | 0), color: "blue", width: 2, by: "m" })
      : eraseOps(clock, ink, strokes[Math.floor(r() * strokes.length)].id);
    ink.applyAll(made.ops);
    ops.push(...made.ops);
  }
  const want = JSON.stringify(ink.strokes().map((s) => s.id));
  for (let k = 0; k < 20; k++) {
    const other = new InkDoc();
    other.applyAll(shuffle(r, [...ops, ...ops.slice(0, 5)]));
    assert.equal(JSON.stringify(other.strokes().map((s) => s.id)), want);
  }
});

test("strokes that make no sense are set aside", () => {
  const ink = new InkDoc();
  for (const bad of [
    { t: "stroke", id: "1@a", pts: [0, 0], c: "red", w: 1, by: "m", at: 1 },
    { t: "stroke", id: "2@a", pts: [0, 0, 500], c: "red", w: 1, by: "m", at: 1 },
    { t: "stroke", id: "3@a", pts: [0, 0, 50], c: "rainbow", w: 1, by: "m", at: 1 },
    { t: "stroke", id: "4@a", pts: [0, 0, 50], c: "red", w: 9, by: "m", at: 1 },
    { t: "srm", id: "5@a", s: "x", n: 1 },
  ]) assert.equal(ink.apply(bad), "unknown");
});

test("thinning keeps the ends and drops points that crowd together", () => {
  const pts = line(0, 0, 100, 0, 50);
  const thin = thinPoints(pts, 25);
  assert.ok(thin.length < pts.length);
  assert.deepEqual(thin.slice(0, 3), pts.slice(0, 3));
  assert.deepEqual(thin.slice(-3), pts.slice(-3));
});

test("brushes are kept per stroke; a stroke without one is a pen", async () => {
  const { BRUSHES } = await import("../src/core/ink.js");
  assert.deepEqual(BRUSHES, ["pen", "pencil", "marker", "highlighter", "erase"]);
  const ink = new InkDoc();
  const clock = new Clock("a");
  ink.applyAll(strokeOps(clock, ink, { pts: line(0, 0, 500, 0), color: "green", width: 2, by: "m1", brush: "pencil" }).ops);
  ink.apply({ t: "stroke", id: "50@old", pts: [0, 0, 50, 10, 10, 50], c: "red", w: 1, by: "m", at: 1 });
  assert.deepEqual(ink.strokes().map((s) => s.b), ["pencil", "pen"]);
  assert.equal(ink.apply({ t: "stroke", id: "60@a", pts: [0, 0, 50], c: "red", w: 1, b: "crayon", by: "m", at: 1 }), "unknown");
});

test("the area eraser is a stroke of its own: it rubs out what lies under it, and the stroke eraser passes over it", () => {
  const ink = new InkDoc();
  const clock = new Clock("a");
  const drawn = strokeOps(clock, ink, { pts: line(0, 0, 1000, 0), color: "blue", width: 2, by: "m1" });
  ink.applyAll(drawn.ops);
  const rub = strokeOps(clock, ink, { pts: line(400, -100, 400, 100), color: "black", width: 3, by: "m1", brush: "erase" });
  ink.applyAll(rub.ops);
  assert.deepEqual(ink.strokes().map((s) => s.b), ["pen", "erase"]);
  assert.equal(ink.strokeAt(400, 0, 20), drawn.ops[0].id, "the stroke eraser does not pick the rubbing");
  ink.applyAll(invertInkOps(ink, clock, rub.atoms, "undo"));
  assert.deepEqual(ink.strokes().map((s) => s.b), ["pen"]);
});
