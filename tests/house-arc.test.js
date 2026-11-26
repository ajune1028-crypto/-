import test from "node:test";
import assert from "node:assert/strict";
import { planet, slotAngle, snapTurn, spotAt, seen } from "../src/ui/house-arc-geometry.js";

// The owner (21 November, again): the houses stand on a small planet rising from the bottom of the
// screen, a third of a big circle; house 1 in the middle first, the next ones to its right, + right
// beside house 1; the planet turns left and right; from five houses on they are a little smaller so
// more are seen, and a little smaller again as they grow; on a big screen still a third of a circle,
// not stretched to the screen's sides.

const REM = 16;
const opts = { house: 2.7 * REM, gap: 0.7 * REM, low: 2.6 * REM };

test("planet: a third of a circle; on a phone its rim meets the bottom corners", () => {
  const g = planet(390, 844, 4, opts);
  assert.ok(Math.abs(g.cap - (2 * g.r) / 3) < 1e-6, "a third shows");
  assert.ok(Math.abs(2 * Math.sqrt(g.r ** 2 - (g.r - g.cap) ** 2) - 390) < 1, "its rim meets the bottom corners");
  assert.equal(g.cx, 195);
  assert.ok(Math.abs(g.cy - (844 + g.r / 3)) < 1e-6);
});

test("planet: house 1 in the middle first, the next ones to its right, + right beside house 1 on its left", () => {
  const g = planet(390, 844, 4, opts);
  assert.equal(slotAngle(g, 1, g.start), 0, "house 1 at the top");
  assert.ok(Math.abs(slotAngle(g, 0, g.start) + g.step) < 1e-9, "+ one step to the left of house 1");
  for (let k = 2; k <= 4; k++) assert.ok(Math.abs(slotAngle(g, k, g.start) - (k - 1) * g.step) < 1e-9, "house " + k + " to the right");
  const top = spotAt(g, 0);
  assert.ok(Math.abs(top.x - 195) < 1e-6 && Math.abs(top.y - (844 - g.cap)) < 1e-6, "the top of the planet");
  // On a phone +, house 1 and the two after it are seen at the start; the rest come as it turns.
  for (let k = 0; k <= 3; k++) assert.ok(Math.abs(slotAngle(g, k, g.start)) <= g.reach + 1e-9, "slot " + k + " is seen");
  // No house yet: + in the middle.
  const none = planet(390, 844, 0, opts);
  assert.equal(slotAngle(none, 0, none.start), 0);
});

test("planet: it turns from + in the middle to the last house in the middle, and settles on a house", () => {
  const g = planet(390, 844, 9, opts);
  assert.equal(slotAngle(g, 0, g.min), 0, "turned all the way right, + is in the middle");
  assert.ok(Math.abs(slotAngle(g, 9, g.max)) < 1e-9, "turned all the way left, the last house is in the middle");
  assert.equal(snapTurn(g, g.max + 5), g.max, "never past the last house");
  assert.equal(snapTurn(g, g.min - 5), g.min, "never past +");
  const near = snapTurn(g, 2.4 * g.step);
  assert.ok(Math.abs(near - 2 * g.step) < 1e-9, "settles where a house is in the middle: " + near);
});

test("planet: from five houses a little smaller so more are seen, smaller again as they grow, never tiny", () => {
  const four = planet(390, 844, 4, opts);
  const five = planet(390, 844, 5, opts);
  const many = planet(390, 844, 24, opts);
  assert.equal(four.scale, 1);
  assert.ok(five.scale < 1 && five.scale >= 0.8, "smaller at five: " + five.scale);
  assert.ok(many.scale < five.scale && many.scale >= 0.62, "smaller again with many: " + many.scale);
  assert.ok(seen(five) > seen(four), "more houses are seen: " + [seen(four), seen(five)]);
});

test("planet: a house seen stands whole on the screen, leaning out with the ground, its foot above the bottom", () => {
  for (const [w, h] of [[390, 844], [360, 640], [844, 390], [1180, 820], [820, 1180]]) {
    for (const n of [3, 6, 14]) {
      const g = planet(w, h, n, opts);
      const size = opts.house * g.scale;
      for (const a of [-g.reach, 0, g.reach]) {
        const p = spotAt(g, a);
        // The house's far top corner, leaning out at angle a.
        const far = p.x + Math.sign(a || 1) * (size * Math.sin(Math.abs(a)) + (size / 2) * Math.cos(a));
        assert.ok(far >= 0 && far <= w, `${w}×${h}, ${n}: whole on the screen at ${a}: ${far}`);
        assert.ok(p.y <= h - opts.low + 1e-6, `${w}×${h}: its foot above the bottom at ${a}: ${p.y}`);
      }
    }
  }
});

test("planet: on a big screen still a third of a circle, not stretched to the sides, and more houses are seen", () => {
  const pad = planet(1180, 820, 6, opts);
  const phone = planet(390, 844, 6, opts);
  assert.ok(Math.abs(pad.cap - (2 * pad.r) / 3) < 1e-6);
  assert.ok(2 * Math.sqrt(pad.r ** 2 - (pad.r - pad.cap) ** 2) < 1180 - 100, "not edge to edge");
  assert.ok(pad.cap <= 0.36 * 820 + 1e-6, "low enough to leave the rooms in view: " + pad.cap);
  assert.ok(seen(pad) > seen(phone), "a wider planet shows more houses: " + [seen(phone), seen(pad)]);
});
