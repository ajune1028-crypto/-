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

test("올가미 moves drawings: a stroke moved is the same stroke further along (one undo step puts it back)", async () => {
  const { InkDoc, strokeOps, moveStrokesOps, invertInkOps } = await import("../src/core/ink.js");
  const { Clock } = await import("../src/core/crdt.js");
  const ink = new InkDoc();
  const clock = new Clock("a");
  const commit = (made) => { for (const op of made.ops) ink.apply(op); return made; };
  commit(strokeOps(clock, ink, { pts: [0, 0, 50, 100, 0, 50, 200, 0, 50], color: "blue", width: 2, by: "m1", brush: "marker" }));
  const [s] = ink.strokes();
  const moved = commit(moveStrokesOps(clock, ink, [s.id], 30, -20, "m1"));
  assert.equal(ink.strokes().length, 1);
  const now = ink.strokes()[0];
  assert.deepEqual([now.pts.slice(0, 2), now.c, now.w, now.b], [[30, -20], "blue", 2, "marker"], "moved, the same colour, width and brush");
  for (const op of invertInkOps(ink, clock, moved.atoms, "undo")) ink.apply(op);
  assert.deepEqual(ink.strokes().map((x) => x.id), [s.id], "undo: the stroke where it was");
});

test("strokes take another colour (the 올가미's 색 on 그림): each goes and comes back in that colour, one undo puts them back", async () => {
  const { recolorStrokesOps } = await import("../src/core/ink.js");
  const ink = new InkDoc();
  const clock = new Clock("a");
  const a = strokeOps(clock, ink, { pts: [0, 0, 50, 100, 100, 50], color: "black", width: 2, by: "m" });
  a.ops.forEach((op) => ink.apply(op));
  const made = recolorStrokesOps(clock, ink, [a.ops[0].id], "#e5484d", "m");
  made.ops.forEach((op) => ink.apply(op));
  const now = ink.strokes();
  assert.equal(now.length, 1);
  assert.equal(now[0].c, "#e5484d");
  assert.deepEqual(now[0].pts, a.ops[0].pts, "where it was");
  invertInkOps(ink, clock, made.atoms, "undo").forEach((op) => ink.apply(op));
  assert.deepEqual(ink.strokes().map((s) => s.c), ["black"]);
});

test("new brushes travel as a style beside a brush every device knows; a shape keeps its exact points; moving and recolouring keep both", async () => {
  const { moveStrokesOps, recolorStrokesOps, STYLES } = await import("../src/core/ink.js");
  assert.deepEqual(Object.keys(STYLES), ["fountain", "brushpen", "airbrush", "sketch", "crayon"]);
  // 스케치 and 크레용 (ported from Klecks and Easy-Brush) fall back to a pencil on older devices.
  assert.deepEqual([STYLES.sketch, STYLES.crayon], ["pencil", "pencil"]);
  const ink = new InkDoc();
  const clock = new Clock("a");
  const fountain = strokeOps(clock, ink, { pts: line(0, 0, 500, 0), color: "blue", width: 2, by: "m1", brush: "fountain" }).ops[0];
  assert.equal(fountain.b, undefined, "a device from before draws it as a pen");
  assert.equal(fountain.s, "fountain");
  const air = strokeOps(clock, ink, { pts: line(0, 100, 500, 100), color: "red", width: 3, by: "m1", brush: "airbrush" }).ops[0];
  assert.deepEqual([air.b, air.s], ["highlighter", "airbrush"]);
  ink.applyAll([fountain, air]);
  assert.deepEqual(ink.strokes().map((s) => [s.b, s.s]), [["pen", "fountain"], ["highlighter", "airbrush"]]);
  // A style this version does not know yet is still drawn, as its brush.
  assert.equal(ink.apply({ t: "stroke", id: "70@z", pts: [0, 0, 50, 10, 10, 50], c: "red", w: 1, s: "glitter", by: "m", at: 1 }), "applied");
  assert.equal(ink.apply({ t: "stroke", id: "71@z", pts: [0, 0, 50], c: "red", w: 1, s: 42, by: "m", at: 1 }), "unknown");
  assert.equal(ink.apply({ t: "stroke", id: "72@z", pts: [0, 0, 50], c: "red", w: 1, q: 7, by: "m", at: 1 }), "unknown");
  // A shape made straight: its points exactly (thinning would drop these, 10 apart).
  const pts = [0, 0, 50, 10, 0, 50, 20, 0, 50, 30, 0, 50, 40, 0, 50];
  const shape = strokeOps(clock, ink, { pts, color: "black", width: 2, by: "m1", brush: "marker", shape: true }).ops[0];
  assert.equal(shape.q, 1);
  assert.deepEqual(shape.pts, pts);
  ink.apply(shape);
  for (const op of moveStrokesOps(clock, ink, [fountain.id, shape.id], 5, 5, "m1").ops) ink.apply(op);
  for (const op of recolorStrokesOps(clock, ink, ink.strokes().filter((s) => s.s === "fountain").map((s) => s.id), "#2f9e5b", "m1").ops) ink.apply(op);
  const now = ink.strokes();
  const f = now.find((s) => s.s === "fountain");
  assert.deepEqual([f.pts.slice(0, 2), f.c], [[5, 5], "#2f9e5b"], "moved and recoloured, still a fountain pen");
  const q = now.find((s) => s.q === 1);
  assert.deepEqual(q.pts.slice(0, 6), [5, 5, 50, 15, 5, 50], "moved, still exact");
  // A style from a newer version stays itself when this version moves it.
  for (const op of moveStrokesOps(clock, ink, ["70@z"], 1, 1, "m1").ops) ink.apply(op);
  assert.deepEqual(ink.strokes().filter((s) => s.s === "glitter").map((s) => [s.b, s.pts[0]]), [["pen", 1]]);
});
