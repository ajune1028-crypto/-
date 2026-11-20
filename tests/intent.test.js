import test from "node:test";
import assert from "node:assert/strict";
import { intendedKeys, keyName } from "../src/audio/intent.js";

/** Notes from [midi sung, seconds] pairs, one after another with a short gap. */
function sung(pairs, { gap = 0.05 } = {}) {
  let t = 0;
  return pairs.map(([m, d = 0.35]) => { const n = { t, d, m, spread: 0.12 }; t += d + gap; return n; });
}

test("a tune hummed flat and unevenly (high notes flatter) comes out as the keys meant, in its key", () => {
  // 라 도 레 도 라 | 라 도 레 도 미 | 미 솔 라 라 (A minor), hummed as a person did: 레 at 49.4, 라 high at 55.7.
  const meant = [45, 48, 50, 48, 45, 45, 48, 50, 48, 52, 52, 55, 57, 57];
  const hummed = [44.6, 47.7, 49.4, 47.7, 44.7, 45.8, 47.6, 49.2, 47.3, 52.1, 51.4, 54.7, 55.7, 56.1];
  const r = intendedKeys(sung(hummed.map((m) => [m])));
  const right = (keys) => keys.filter((k, i) => k === meant[i]).length;
  assert.ok(right(r.keys) >= 11, "most notes as meant: " + r.keys.join(" "));
  assert.ok(right(r.keys) >= right(r.sung) + 2, `better than plain rounding (${right(r.keys)} against ${right(r.sung)})`);
  assert.ok((r.tonic === 9 && r.minor) || (r.tonic === 0 && !r.minor), "A minor or C major (the same notes): " + r.tonic);
  assert.deepEqual(r.keys.slice(0, 5), meant.slice(0, 5), "the opening line exactly");
});

test("a clearly sung note outside the key is kept as sung", () => {
  // 도 레 미 파 솔 — then a long, steady 파♯ — 솔: C major with one deliberate F♯.
  const notes = sung([[60], [62], [64], [65], [67], [66.02, 0.9], [67], [65], [64], [62], [60]]);
  notes[5].spread = 0.06;
  const r = intendedKeys(notes);
  assert.equal(r.keys[5], 66);
});

test("a singer who slowly drifts flat keeps the right keys all the way", () => {
  const tune = [60, 62, 64, 65, 67, 65, 64, 62, 60, 62, 64, 65, 67, 69, 67, 65, 64, 62, 60, 60];
  const drifting = tune.map((k, i) => k - (0.45 * i) / tune.length);
  const r = intendedKeys(sung(drifting.map((m) => [m])));
  assert.deepEqual(r.keys, tune);
});

test("an accurate take is left as it was sung; a short note between two keys is read in the key", () => {
  const tune = [67, 67, 69, 67, 72, 71, 67, 67, 69, 67, 74, 72];
  const r = intendedKeys(sung(tune.map((m) => [m + 0.04])));
  assert.deepEqual(r.keys, tune);
  assert.deepEqual(r.sung, tune);
  // G major run with a quick passing note sung at 70.5 (between 라♯ and 시): the key says 시 (71).
  const run = sung([[67], [69], [70.5, 0.09], [72], [74], [72], [71], [69], [67]]);
  assert.equal(intendedKeys(run).keys[2], 71);
});

test("too few notes to hear a key: kept as sung; the key has a Korean name", () => {
  const r = intendedKeys(sung([[60.4], [63.6]]));
  assert.deepEqual(r.keys, r.sung);
  assert.equal(r.tonic, null);
  assert.equal(keyName(9, true), "가단조");
  assert.equal(keyName(0, false), "다장조");
  assert.equal(keyName(6, false), "올림바장조");
});
