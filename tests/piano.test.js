import test from "node:test";
import assert from "node:assert/strict";
import { renderPianoNote, reverbImpulse, PIANO_RATE, noteSeconds, brightnessOf, reverbMix } from "../src/audio/piano.js";
import { resample } from "../src/audio/dsp.js";
import { trackPitch, ANALYSIS_RATE } from "../src/audio/pitch.js";
import { hzToMidi } from "../src/audio/notes.js";

/** Energy that a one-pole high-pass above roughly `hz` lets through, per sample. */
function highEnergy(x, rate, hz) {
  const a = Math.exp((-2 * Math.PI * hz) / rate);
  let lp = 0;
  let e = 0;
  for (let i = 0; i < x.length; i++) {
    lp = a * lp + (1 - a) * x[i];
    const hp = x[i] - lp;
    e += hp * hp;
  }
  return e / x.length;
}

const energy = (x, from, to) => {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i] * x[i];
  return e / (to - from);
};

test("a rendered key sounds at its own pitch", () => {
  for (const midi of [48, 60, 67, 76]) {
    const x = resample(renderPianoNote(midi), PIANO_RATE, ANALYSIS_RATE);
    const frames = trackPitch(x.subarray(0, ANALYSIS_RATE)).filter((f) => f.hz > 0).slice(5, 60);
    assert.ok(frames.length > 40, "pitch found for " + midi);
    const found = frames.map((f) => Math.round(hzToMidi(f.hz)));
    const right = found.filter((m) => m === midi).length;
    assert.ok(right >= frames.length * 0.9, `${midi}: ${right}/${frames.length} frames right`);
  }
});

test("밝게 carries more high sound than 어둡게", () => {
  const bright = renderPianoNote(60, { tone: "bright" });
  const dark = renderPianoNote(60, { tone: "dark" });
  const ratio = (x) => highEnergy(x.subarray(0, PIANO_RATE / 2), PIANO_RATE, 2000) / energy(x, 0, PIANO_RATE / 2);
  assert.ok(ratio(bright) > ratio(dark) * 2, `bright ${ratio(bright).toFixed(4)} vs dark ${ratio(dark).toFixed(4)}`);
  assert.ok(brightnessOf("bright") > brightnessOf("dark"));
  assert.ok(reverbMix("dark") > reverbMix("bright"), "the dark tone sits further back in the room");
});

test("a key dies away like a piano and fades out before it is cut", () => {
  const x = renderPianoNote(64);
  assert.equal(x.length, Math.round(noteSeconds(64) * PIANO_RATE));
  const early = energy(x, 0, PIANO_RATE / 4);
  const late = energy(x, x.length - PIANO_RATE / 2, x.length - PIANO_RATE / 4);
  assert.ok(late < early / 30, "much quieter at the end");
  assert.ok(Math.abs(x[x.length - 1]) < 1e-3);
  assert.ok(Math.abs(x[0]) < 1e-3, "no click at the start");
  assert.ok(x.every((s) => Number.isFinite(s)));
});

test("low keys ring longer than high keys", () => {
  assert.ok(noteSeconds(40) > noteSeconds(84));
  assert.ok(noteSeconds(30) <= 4 && noteSeconds(100) >= 1.6);
});

test("harder notes are louder, and the same note always renders the same", () => {
  const peak = (x) => x.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
  assert.ok(peak(renderPianoNote(60, { velocity: 1 })) > peak(renderPianoNote(60, { velocity: 0.2 })));
  assert.ok(peak(renderPianoNote(60, { velocity: 1 })) <= 0.83);
  const a = renderPianoNote(62, { tone: "dark", velocity: 0.6 });
  const b = renderPianoNote(62, { tone: "dark", velocity: 0.6 });
  assert.deepEqual(Array.from(a.subarray(0, 500)), Array.from(b.subarray(0, 500)));
});

test("rendering a key is quick enough to do on demand", () => {
  const t0 = performance.now();
  for (const m of [48, 55, 60, 64, 67, 72]) renderPianoNote(m, { tone: "bright" });
  const each = (performance.now() - t0) / 6;
  assert.ok(each < 80, "ms per key: " + each.toFixed(1));
});

test("the room's echo has two channels of equal energy and decays", () => {
  const [l, r] = reverbImpulse(24000, "dark");
  assert.equal(l.length, r.length);
  const e = (x) => x.reduce((s, v) => s + v * v, 0);
  assert.ok(Math.abs(e(l) - 1) < 1e-6 && Math.abs(e(r) - 1) < 1e-6);
  assert.ok(energy(l, 0, 4800) > energy(l, l.length - 4800, l.length) * 100);
  assert.ok(reverbImpulse(24000, "dark")[0].length > reverbImpulse(24000, "bright")[0].length);
});
