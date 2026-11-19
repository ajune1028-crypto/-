import test from "node:test";
import assert from "node:assert/strict";
import { liveTail, mergeLive, LIVE_TAIL } from "../src/core/live.js";

const line = (n) => Array.from({ length: n }, (_, i) => [i * 10, i * 3, 50]).flat();

test("a line sent in overlapping pieces comes back whole on the friend's screen", () => {
  const full = line(300);
  let got = null;
  for (let n = 1; n <= 300; n += 7) got = mergeLive(got, liveTail(full.slice(0, n * 3)));
  got = mergeLive(got, liveTail(full));
  assert.deepEqual(got.pts, full);
  assert.ok(liveTail(full).t.length <= LIVE_TAIL * 3, "each piece is small");
});

test("a piece that never came leaves a straight jump, and the line goes on", () => {
  const full = line(400);
  let got = mergeLive(null, liveTail(full.slice(0, 30 * 3)));
  got = mergeLive(got, liveTail(full.slice(0, 380 * 3)));
  got = mergeLive(got, liveTail(full));
  const n = got.pts.length / 3;
  assert.equal(got.pts.slice(-3).join(), full.slice(-3).join(), "it reaches where the pen is");
  assert.deepEqual(got.pts.slice(0, 90), full.slice(0, 90), "what came first stays");
  assert.ok(n < 400 && n >= 30 + LIVE_TAIL, "the missing middle is jumped over: " + n);
  // After the jump the pieces line up again: the end is exactly the sender's last points.
  assert.deepEqual(got.pts.slice(-LIVE_TAIL * 3), full.slice(-LIVE_TAIL * 3));
});

test("pieces that come late or twice change nothing", () => {
  const full = line(120);
  const a = liveTail(full.slice(0, 60 * 3));
  const b = liveTail(full);
  const once = mergeLive(mergeLive(null, a), b);
  assert.deepEqual(once.pts, full);
  assert.deepEqual(mergeLive(once, a), once, "an older piece after a newer one");
  assert.deepEqual(mergeLive(once, b), once, "the same piece twice");
});
