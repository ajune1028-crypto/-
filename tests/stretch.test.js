import test from "node:test";
import assert from "node:assert/strict";
import { timeStretch } from "../src/audio/stretch.js";
import { trackPitch, ANALYSIS_RATE } from "../src/audio/pitch.js";
import { analyzeSamples } from "../src/audio/analyze.js";
import { sing, sine } from "./fixtures/voice.js";

const rms = (x, a = 0.2, b = 0.8) => {
  let s = 0;
  const i0 = Math.floor(x.length * a);
  const i1 = Math.floor(x.length * b);
  for (let i = i0; i < i1; i++) s += x[i] * x[i];
  return Math.sqrt(s / (i1 - i0));
};
const medianHz = (x) => {
  const hz = trackPitch(x).filter((f) => f.hz > 0).map((f) => f.hz).sort((a, b) => a - b);
  return hz[hz.length >> 1];
};

for (const speed of [0.5, 1.5, 2, 3]) {
  test(`at ${speed}× a recording lasts 1/${speed} as long and keeps its pitch`, () => {
    const { samples } = sine(220, 2, { rate: ANALYSIS_RATE, lead: 0 });
    const out = timeStretch(samples, ANALYSIS_RATE, speed);
    assert.ok(Math.abs(out.length - samples.length / speed) <= 2, `length ${out.length}`);
    const hz = medianHz(out);
    assert.ok(Math.abs(hz - 220) / 220 < 0.01, `pitch ${hz}`);
    assert.ok(Math.abs(rms(out) - rms(samples)) / rms(samples) < 0.15, "loudness kept");
  });
}

test("1× gives the recording back unchanged", () => {
  const x = Float32Array.from({ length: 500 }, (_, i) => Math.sin(i / 3));
  assert.deepEqual(Array.from(timeStretch(x, 16000, 1)), Array.from(x));
});

test("a sung melody at 2× keeps its notes, twice as fast", async () => {
  const sig = sing([60, 64, 67, 72].map((midi) => ({ midi, dur: 0.5 })), { rate: ANALYSIS_RATE });
  const fast = timeStretch(sig.samples, ANALYSIS_RATE, 2);
  const { notes } = await analyzeSamples(fast, ANALYSIS_RATE);
  assert.deepEqual(notes.map((n) => n.p), [60, 64, 67, 72]);
  notes.forEach((n, i) => assert.ok(Math.abs(n.t - sig.truth[i].t / 2) < 0.03, `note ${i} at ${n.t.toFixed(3)}`));
});
