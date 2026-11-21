import test from "node:test";
import assert from "node:assert/strict";
import { arcGeometry } from "../src/ui/house-arc-geometry.js";

// The owner (21 November): the houses a held room can go into stand on the top third of a big circle
// fitted to the screen, + in the middle, spreading evenly to both sides as there are more.
test("the house arc: the top third of a circle fitted to the screen, + at the top, houses evenly on both sides", () => {
  const g = arcGeometry(390, 844, 4);
  assert.ok(Math.abs(g.cap - (2 * g.r) / 3) < 1e-6, "a third of the circle shows");
  assert.ok(Math.abs(2 * Math.sqrt(g.r ** 2 - (g.r - g.cap) ** 2) - 390) < 1, "its rim meets the screen's bottom corners");
  const [plus, ...houses] = g.spots;
  assert.equal(plus.angle, 0, "+ at the top");
  assert.ok(Math.abs(plus.x - 195) < 1e-6);
  assert.equal(houses.length, 4);
  // Alternating right, left, right, left, the same steps on both sides.
  assert.ok(houses[0].angle > 0 && houses[1].angle < 0 && Math.abs(houses[0].angle + houses[1].angle) < 1e-9);
  assert.ok(Math.abs(houses[2].angle - 2 * houses[0].angle) < 1e-9);
  for (const s of g.spots) {
    assert.ok(s.x >= 0 && s.x <= 390, "inside the screen: " + s.x);
    assert.ok(s.y <= 844 - 40, "above the bottom: " + s.y);
    assert.ok(Math.abs(Math.hypot(s.x - g.cx, s.y - g.cy) - g.r) < 1e-6, "on the rim");
  }
});

test("the house arc: many houses come closer and smaller but stay on the screen; a wide screen keeps the arc low", () => {
  const few = arcGeometry(390, 844, 2);
  const many = arcGeometry(390, 844, 14);
  assert.ok(many.scale < few.scale && many.scale >= 0.55, "smaller: " + many.scale);
  for (const s of many.spots) assert.ok(s.x >= 0 && s.x <= 390 && s.y <= 844 - 30, JSON.stringify(s));
  const wide = arcGeometry(1180, 820, 3);
  assert.ok(wide.cap <= 820 * 0.42 + 1e-6, "not taller than about two fifths of the screen: " + wide.cap);
});
