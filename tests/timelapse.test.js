import test from "node:test";
import assert from "node:assert/strict";
import { replayPlan, strokePart } from "../src/core/timelapse.js";

const stroke = (id, at, pts, extra = {}) => ({ id, at, pts, c: "red", w: 2, by: "m1", ...extra });
const line = (len, n = 5) => Array.from({ length: n }, (_, i) => [Math.round((len * i) / (n - 1)), 0, 50]).flat();

test("타임랩스: strokes from every layer in the order they were drawn, one after another, the waits between them left out", () => {
  const plan = replayPlan([
    { layer: 0, strokes: [stroke("3@a", 3000, line(500)), stroke("1@a", 1000, line(500))] },
    { layer: 1, strokes: [stroke("2@b", 2000, line(1000), { by: "m2" })] },
  ]);
  assert.deepEqual(plan.items.map((x) => [x.stroke.id, x.layer]), [["1@a", 0], ["2@b", 1], ["3@a", 0]]);
  for (let i = 1; i < plan.items.length; i++) assert.equal(plan.items[i].start, plan.items[i - 1].end, "no gaps");
  assert.equal(plan.items[0].start, 0);
  assert.equal(plan.total, plan.items.at(-1).end);
  assert.ok(plan.items[1].end - plan.items[1].start > plan.items[0].end - plan.items[0].start, "a longer line takes longer");
});

test("a line takes between a short and a long moment however short or long it is; ties keep the id order", () => {
  const plan = replayPlan([{ layer: 0, strokes: [stroke("1@a", 5, line(2)), stroke("2@a", 5, line(200000, 40))] }], { minMs: 120, maxMs: 1500 });
  assert.equal(plan.items[0].end - plan.items[0].start, 120);
  assert.equal(plan.items[1].end - plan.items[1].start, 1500);
  assert.deepEqual(plan.items.map((x) => x.stroke.id), ["1@a", "2@a"]);
  assert.deepEqual(replayPlan([]), { items: [], total: 0 });
});

test("part of a line: as far along as the fraction says, the cut point placed between two points; a fill or a shape comes whole", () => {
  const pts = [0, 0, 40, 100, 0, 60, 200, 0, 80];
  assert.deepEqual(strokePart(pts, 0.25), [0, 0, 40, 50, 0, 50]);
  assert.deepEqual(strokePart(pts, 1), pts);
  assert.deepEqual(strokePart(pts, 0), [0, 0, 40]);
  assert.deepEqual(strokePart(pts, 0.75), [0, 0, 40, 100, 0, 60, 150, 0, 70]);
  assert.equal(strokePart(pts, 0.5, { whole: true }), pts);
});
