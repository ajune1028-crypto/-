import test from "node:test";
import assert from "node:assert/strict";
import { segmentPitch, onsetStrength } from "../src/audio/segment.js";

const F = 0.016;
const hzOf = (m) => 440 * 2 ** ((m - 69) / 12);
/** Frames from pieces: [seconds, midi (or null for no voice), loudness dB (default -20), confidence (default 0.95)]. */
function frames(pieces) {
  const hz = [], conf = [], db = [];
  for (const [sec, m, level = -20, c = 0.95] of pieces) {
    const n = Math.round(sec / F);
    for (let i = 0; i < n; i++) {
      const v = typeof m === "function" ? m(i / n) : m;
      hz.push(v == null ? 0 : hzOf(v));
      conf.push(v == null ? 0.02 : c);
      db.push(v == null ? -70 : level);
    }
  }
  return { hz: Float32Array.from(hz), conf: Float32Array.from(conf), db: Float32Array.from(db), frame: F };
}
const keys = (notes) => notes.map((n) => Math.round(n.m));

test("two held pitches are two notes, at their pitches and times; a rest between is no note", () => {
  const notes = segmentPitch(frames([[0.4, 60], [0.3, null], [0.5, 64]]));
  assert.deepEqual(keys(notes), [60, 64]);
  assert.ok(Math.abs(notes[0].t) < 0.02 && Math.abs(notes[0].d - 0.4) < 0.04);
  assert.ok(Math.abs(notes[1].t - 0.7) < 0.03 && Math.abs(notes[1].d - 0.5) < 0.04);
});

test("vibrato and a slow scoop stay one note; a pitch held at the old note after a slide is still one note", () => {
  const vib = segmentPitch(frames([[1.0, (u) => 62 + 0.5 * Math.sin(2 * Math.PI * 5.5 * u)]]));
  assert.deepEqual(keys(vib), [62]);
  const scoop = segmentPitch(frames([[0.08, (u) => 58.5 + 1.5 * u], [0.5, 60]]));
  assert.deepEqual(keys(scoop), [60], "the scoop is part of the note it rises into");
});

test("the same pitch sung twice ('다-다') is two notes when the sound dips between them", () => {
  const notes = segmentPitch(frames([[0.3, 62, -18], [0.05, 62, -40, 0.4], [0.3, 62, -18]]));
  assert.deepEqual(keys(notes), [62, 62]);
});

test("short notes: a real quick note two semitones away is kept, a 40 ms blip at a semitone is not, nothing under 40 ms is a note", () => {
  const quick = segmentPitch(frames([[0.4, 60], [0.1, 63], [0.4, 60]]));
  assert.deepEqual(keys(quick), [60, 63, 60], "a 100 ms note three semitones up");
  const blip = segmentPitch(frames([[0.4, 60], [0.04, 61], [0.4, 60]]));
  assert.deepEqual(keys(blip), [60], "a 40 ms wobble is part of the note");
  const tiny = segmentPitch(frames([[0.3, null], [0.032, 67], [0.3, null]]));
  assert.deepEqual(keys(tiny), [], "a 32 ms sound alone is not a note");
});

test("each syllable is a note: a quick syllable between two dips is kept, the same bend inside one breath is not; 라-라-라 on one pitch is three notes", () => {
  const syllable = frames([[0.4, 60, -18], [0.032, 60, -36, 0.5], [0.08, 61, -16], [0.032, 61, -36, 0.5], [0.4, 60, -18]]);
  const onsets = onsetStrength(syllable);
  assert.equal(onsets.length, syllable.hz.length);
  assert.deepEqual(keys(segmentPitch(syllable)), [60, 61, 60]);
  const glide = frames([[0.4, 60], [0.08, 61], [0.4, 60]]);
  assert.deepEqual(keys(segmentPitch(glide)), [60], "an 80 ms bend of a semitone inside one breath is not a note");
  // "라" three times: the l makes a shallow dip (8 dB) and the voice wavers a little, no silence.
  const la = frames([[0.25, 64, -18], [0.048, 64, -26, 0.7], [0.25, 64, -18], [0.048, 64, -26, 0.7], [0.25, 64, -18]]);
  assert.deepEqual(keys(segmentPitch(la)), [64, 64, 64]);
});

test("a note's pitch is where the voice settles, not its first or last moments", () => {
  // Starts 0.8 below for 60 ms, holds 64.1, falls away at the end.
  const notes = segmentPitch(frames([[0.06, 63.3], [0.45, 64.1], [0.05, (u) => 64.1 - 1.2 * u]]));
  assert.equal(notes.length, 1);
  assert.ok(Math.abs(notes[0].m - 64.1) < 0.1, "pitch " + notes[0].m);
});
