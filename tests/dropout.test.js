import test from "node:test";
import assert from "node:assert/strict";
import { sing } from "./fixtures/voice.js";
import { concealDropouts } from "../src/audio/dsp.js";
import { voiceNotes } from "../src/audio/analyze.js";

// The take Chrome plays as its microphone in the browser scenarios: 솔 미 미 파 레 레, with short
// stops between the notes (the sound fades out and comes back, as a voice does).
const take = () => sing([67, 64, 64, 65, 62, 62].map((midi, i) => ({ midi, dur: i === 2 || i === 5 ? 0.6 : 0.3, gap: 0.04 })), { rate: 48000, lead: 0.3, tail: 0.4 });

const rms = (x, a, b) => {
  let e = 0;
  for (let i = a; i < b; i++) e += x[i] * x[i];
  return Math.sqrt(e / Math.max(1, b - a));
};

test("a moment the sound drops out while recording (a busy phone hands over zeros) does not cut a held note in two; the real stops between notes stay", async () => {
  const { samples, rate } = take();
  // The long 미 runs from 0.99 s to 1.59 s.
  for (const ms of [10, 25, 50]) {
    for (const at of [1.15, 1.3, 1.45]) {
      const y = Float32Array.from(samples);
      const a = Math.floor(at * rate);
      y.fill(0, a, a + Math.floor((ms / 1000) * rate));
      const r = await voiceNotes(y, rate);
      assert.deepEqual(r.notes.map((n) => n.p), [67, 64, 64, 65, 62, 62], `${ms} ms of zeros at ${at} s`);
    }
  }
});

test("concealDropouts fills an abrupt silence inside sound with the sound just before it, a period at a time, as loud as around it", () => {
  const rate = 16000;
  const f = 196;
  const x = new Float32Array(rate);
  for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * f * i) / rate) + 0.1 * Math.sin((4 * Math.PI * f * i) / rate);
  const a = 8000, b = a + 160; // 10 ms
  x.fill(0, a, b);
  const { samples: y, filled } = concealDropouts(x, rate);
  assert.equal(filled.length, 1, "one gap found");
  assert.ok(filled[0][0] <= a && filled[0][1] >= b, "it covers the gap: " + filled);
  const around = rms(x, a - 800, a);
  const inGap = rms(y, a, b);
  assert.ok(Math.abs(inGap / around - 1) < 0.15, `as loud as around it: ${inGap} vs ${around}`);
  // It goes on as the tone went on: one period on, the same wave.
  const L = rate / f;
  let num = 0, den = 0;
  for (let i = a; i < b; i++) {
    const want = 0.3 * Math.sin((2 * Math.PI * f * i) / rate) + 0.1 * Math.sin((4 * Math.PI * f * i) / rate);
    num += (y[i] - want) ** 2;
    den += want * want;
  }
  assert.ok(num / den < 0.05, "the tone carried on through the gap: " + (num / den).toFixed(3) + ", period " + L.toFixed(1));
  assert.notEqual(y, x, "a copy: the take itself is kept as it was");
  assert.equal(x[a + 5], 0);
});

test("concealDropouts leaves alone a stop that fades out and in, the silence before the first sound, and a long silence", () => {
  const { samples, rate } = take();
  const quiet = concealDropouts(samples, rate);
  assert.equal(quiet.filled.length, 0, "the stops between the notes fade: they are the song's own");
  assert.equal(quiet.samples, samples, "nothing filled: the same array back");
  const y = Float32Array.from(samples);
  const a = Math.floor(1.2 * rate);
  y.fill(0, a, a + Math.floor(0.15 * rate)); // 150 ms: longer than a dropout
  assert.equal(concealDropouts(y, rate).filled.length, 0, "a long silence is a real one");
});
