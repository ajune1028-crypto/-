import test from "node:test";
import assert from "node:assert/strict";
import { beatMs, stepMs, barMs, barBeat, clicksIn, snapMs, quantizeNotes, estimateTempo, tapTempo } from "../src/core/beat.js";

const T = (bpm, beats = 4, unit = 4) => ({ bpm, beats, unit });

test("a beat, a grid step and a bar in ms; 6/8 counts eighths", () => {
  assert.equal(beatMs(T(100)), 600);
  assert.equal(stepMs(T(100), 8), 300);
  assert.equal(stepMs(T(100), 16), 150);
  assert.equal(barMs(T(100, 3)), 1800);
  assert.equal(stepMs(T(120, 6, 8), 8), 500, "in 6/8 the beat is an eighth");
  assert.equal(stepMs(T(120, 6, 8), 16), 250);
});

test("bar and beat at a time, counted from 1", () => {
  assert.deepEqual(barBeat(0, T(100)), { bar: 1, beat: 1 });
  assert.deepEqual(barBeat(599, T(100)), { bar: 1, beat: 1 });
  assert.deepEqual(barBeat(600, T(100)), { bar: 1, beat: 2 });
  assert.deepEqual(barBeat(2400, T(100)), { bar: 2, beat: 1 });
  assert.deepEqual(barBeat(1800 * 2 + 600, T(100, 3)), { bar: 3, beat: 2 });
});

test("metronome clicks fall on beats, the first of each bar accented", () => {
  assert.deepEqual(clicksIn(0, 1900, T(100)), [{ at: 0, accent: true }, { at: 600, accent: false }, { at: 1200, accent: false }, { at: 1800, accent: false }]);
  assert.deepEqual(clicksIn(2000, 2500, T(100)).map((c) => [c.at, c.accent]), [[2400, true]]);
  assert.deepEqual(clicksIn(600, 600, T(100)), [], "an empty window books nothing");
});

test("snapping goes to the nearest step", () => {
  assert.equal(snapMs(140, 300), 0);
  assert.equal(snapMs(160, 300), 300);
  assert.equal(snapMs(749, 300), 600);
});

test("박자 맞추기 puts starts and ends on the grid, keeps every note at least a step long and never on top of another", () => {
  const notes = [{ t: 20, d: 270, p: 60, key: "a" }, { t: 330, d: 230, p: 62, key: "b" }, { t: 640, d: 40, p: 64, key: "c" }, { t: 700, d: 500, p: 65, key: "d" }];
  const q = quantizeNotes(notes, 300);
  assert.deepEqual(q.map((n) => [n.key, n.t, n.d]), [["a", 0, 300], ["b", 300, 300], ["c", 600, 300], ["d", 900, 300]]);
  assert.deepEqual(q.map((n) => n.p), [60, 62, 64, 65], "pitches stay");
});

test("the tempo of sung notes is found from their starts, even with some eighths and a little wobble", () => {
  const beat = 600; // 100 BPM
  const starts = [];
  let wobble = 1;
  for (let i = 0; i < 24; i++) {
    starts.push(i * beat + ((wobble = (wobble * 7919) % 31) - 15));
    if (i % 3 === 1) starts.push(i * beat + beat / 2 + ((wobble = (wobble * 7919) % 31) - 15));
  }
  const bpm = estimateTempo(starts);
  assert.ok(Math.abs(bpm - 100) <= 2, "found " + bpm);
  assert.equal(estimateTempo([0, 500]), null, "two notes are too few");
});

test("tap tempo is the average gap between taps, a pause left out", () => {
  assert.equal(tapTempo([0, 600, 1210, 1790, 2400]), 100);
  assert.equal(tapTempo([0, 600, 1200, 3800, 4400]), 100, "the pause in the middle does not count");
  assert.equal(tapTempo([0]), null);
});

test("카운트인 (GarageBand's count-in): one bar of clicks at the song's tempo before the take; without a tempo, 3·2·1", async () => {
  const { countIn } = await import("../src/core/beat.js");
  const bar = countIn({ bpm: 120, beats: 4, unit: 4 });
  assert.deepEqual(bar.clicks.map((c) => [c.at, c.accent, c.label]), [[0, true, "1"], [500, false, "2"], [1000, false, "3"], [1500, false, "4"]]);
  assert.equal(bar.total, 2000, "the take begins where the next bar would");
  const waltz = countIn({ bpm: 90, beats: 3, unit: 4 });
  assert.deepEqual(waltz.clicks.map((c) => c.label), ["1", "2", "3"]);
  assert.equal(waltz.total, 2000);
  const plain = countIn(null);
  assert.deepEqual(plain.clicks.map((c) => [c.at, c.label]), [[0, "3"], [750, "2"], [1500, "1"]]);
  assert.equal(plain.total, 2250);
});
