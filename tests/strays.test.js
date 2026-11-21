import test from "node:test";
import assert from "node:assert/strict";
import { withoutStrays } from "../src/audio/analyze.js";

// The owner's own take (21 November) had four notes like these: 50-110 ms, about an octave under the
// tune around them (a breath or the voice creaking at a phrase's start). As piano they jump out low.
test("a very short note far under the tune around it is a breath, not a note; real low notes and quick notes stay", () => {
  const n = (t, d, p, s) => (s === undefined ? { t, d, p, v: 0.6 } : { t, d, p, v: 0.6, s });
  const notes = [
    n(2.13, 0.176, 46), n(2.4, 0.288, 46),
    n(4.56, 0.112, 38, 37), // a breath before a phrase: 13 under the next, the one before is far
    n(4.72, 0.24, 50), n(5.04, 0.048, 49), n(5.33, 0.176, 46),
    n(16.21, 0.096, 41, 39), // between two sung notes, 8 and 15 under them
    n(16.32, 0.048, 48, 47), n(16.37, 0.24, 49, 48),
    n(20.0, 0.3, 46), n(20.32, 0.09, 40), // a quick low note, 6 under: a real one (a fourth/fifth down is sung)
    n(20.45, 0.3, 46),
    n(30.0, 0.4, 46), n(30.5, 0.4, 34), n(31.0, 0.4, 46), // a long low note is sung
  ];
  const kept = withoutStrays(notes);
  assert.deepEqual(kept.map((x) => x.t), [2.13, 2.4, 4.72, 5.04, 5.33, 16.32, 16.37, 20.0, 20.32, 20.45, 30.0, 30.5, 31.0]);
  assert.equal(withoutStrays([n(0, 0.08, 30)]).length, 1, "a note alone is kept");
});
