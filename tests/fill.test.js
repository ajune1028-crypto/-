import test from "node:test";
import assert from "node:assert/strict";
import { fillMask, maskRings, simplifyRing, ringsToPoints, pointsToRings } from "../src/core/fill.js";

/** A w × h RGBA picture, transparent, with opaque black pixels where `ink(x, y)` says. */
function picture(w, h, ink) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink(x, y)) data.set([20, 20, 30, 255], (y * w + x) * 4);
  return data;
}
const count = (mask) => mask.reduce((a, v) => a + v, 0);

test("채우기: a tap inside a drawn square fills its inside and stops at the line (grown a pixel under its edge)", () => {
  const w = 40, h = 40;
  // A square ring two pixels thick from 10 to 29.
  const data = picture(w, h, (x, y) => x >= 10 && x <= 29 && y >= 10 && y <= 29 && !(x >= 12 && x <= 27 && y >= 12 && y <= 27));
  const plain = fillMask(data, w, h, 20, 20, { grow: 0 });
  assert.equal(count(plain), 16 * 16, "the inside only");
  const grown = fillMask(data, w, h, 20, 20, { grow: 1 });
  assert.equal(count(grown), 18 * 18, "a pixel into the line all round");
  const outside = fillMask(data, w, h, 2, 2, { grow: 0 });
  assert.equal(count(outside), w * h - 20 * 20, "outside, round the square");
});

test("채우기: soft (half see-through) edges count as the line; a tolerance decides how near a colour is the same", () => {
  const w = 30, h = 10;
  const data = new Uint8ClampedArray(w * h * 4);
  // A soft wall at x = 15: alpha 120.
  for (let y = 0; y < h; y++) data.set([0, 0, 0, 120], (y * w + 15) * 4);
  assert.equal(count(fillMask(data, w, h, 2, 2, { grow: 0 })), 15 * h, "the wall stops it");
  assert.equal(count(fillMask(data, w, h, 2, 2, { grow: 0, tolerance: 200 })), w * h, "with a wide tolerance it is the same");
});

test("채우기: the region's edges as rings - one outer ring for a plain region, a second for a hole - simplified, kept in stroke points and back", () => {
  const w = 30, h = 30;
  const mask = new Uint8Array(w * h);
  for (let y = 5; y < 25; y++) for (let x = 5; x < 25; x++) mask[y * w + x] = 1;
  for (let y = 12; y < 18; y++) for (let x = 12; x < 18; x++) mask[y * w + x] = 0; // a hole
  const rings = maskRings(mask, w, h).map((r) => simplifyRing(r, 0.5));
  assert.equal(rings.length, 2, "outer edge and the hole");
  const sizes = rings.map((r) => r.length).sort((a, b) => a - b);
  assert.deepEqual(sizes, [4, 4], "squares simplify to their four corners");
  const xs = rings.flat().map(([x]) => x);
  assert.equal(Math.min(...xs), 5);
  assert.equal(Math.max(...xs), 25);
  // Into stroke points (a ring starts where the third value is 100) and back.
  const pts = ringsToPoints(rings, ([x, y]) => [x * 10, y * 10]);
  assert.equal(pts.length, 8 * 3);
  assert.deepEqual(pts.filter((_, i) => i % 3 === 2).filter((p) => p === 100).length, 2);
  const back = pointsToRings(pts);
  assert.equal(back.length, 2);
  assert.deepEqual(back.map((r) => r.length), [4, 4]);
});
