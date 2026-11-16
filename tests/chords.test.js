import test from "node:test";
import assert from "node:assert/strict";
import { makeFft } from "../src/audio/fft.js";
import { resample } from "../src/audio/dsp.js";
import { ANALYSIS_RATE } from "../src/audio/pitch.js";
import { polyState, pitchesAt, polyStart, trackPitches } from "../src/audio/poly.js";
import { thin, followLines, voiceLike } from "../src/audio/lines.js";
import { chordNotes, agreement, tuneWithHarmony } from "../src/audio/chords.js";
import { analyzeSamples, chordsOf } from "../src/audio/analyze.js";
import { renderPianoNote } from "../src/audio/piano.js";
import { hzToMidi } from "../src/audio/notes.js";
import { sing, midiHz } from "./fixtures/voice.js";

const C3 = 48, G3 = 55, C4 = 60, E4 = 64, G4 = 67, A4 = 69;

/** A piano under a take: keys struck together at `at` seconds for `dur`. */
function piano(seconds, strikes, level = 0.5) {
  const out = new Float32Array(Math.round(seconds * ANALYSIS_RATE));
  for (const { at, dur, keys } of strikes) {
    for (const key of keys) {
      const buf = resample(renderPianoNote(key, { rate: 32000, seconds: dur, velocity: 0.7 }), 32000, ANALYSIS_RATE);
      const s0 = Math.round(at * ANALYSIS_RATE);
      for (let k = 0; k < buf.length && s0 + k < out.length; k++) out[s0 + k] += level * buf[k];
    }
  }
  return out;
}
const add = (a, b) => { const out = new Float32Array(Math.max(a.length, b.length)); out.set(a); for (let i = 0; i < b.length; i++) out[i] += b[i]; return out; };

test("the transform finds a sine where it is", () => {
  const n = 1024;
  const fft = makeFft(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 37 * i) / n);
  fft.forward(re, im);
  const mag = Array.from(re, (r, k) => Math.hypot(r, im[k]));
  assert.ok(Math.abs(mag[37] - n / 2) < 1e-6 && Math.abs(mag[n - 37] - n / 2) < 1e-6, "the two mirror bins hold it all");
  assert.ok(mag.every((m, k) => k === 37 || k === n - 37 || m < 1e-6), "nothing anywhere else");
  assert.throws(() => makeFft(1000), /power of two/);
});

test("two voices singing different notes at once are both found, without ghosts", () => {
  const a = sing([{ midi: C4, dur: 1.2 }], { seed: 3 });
  const b = sing([{ midi: G4, dur: 1.2 }], { seed: 9 });
  const x = add(a.samples, b.samples);
  const st = polyState();
  const mid = Math.round(0.7 * ANALYSIS_RATE / 160);
  const { found } = pitchesAt(st, x, polyStart(mid), 5, false);
  const keys = thin(found).map((c) => Math.round(c.key)).sort();
  assert.deepEqual(keys, [C4, G4], "both, and only they: " + JSON.stringify(found.map((c) => [hzToMidi(c.hz).toFixed(1), c.s.toFixed(0)])));
  // One voice alone: its octave and its twelfth above are not taken for more voices.
  const one = pitchesAt(st, a.samples, polyStart(mid), 5, false);
  assert.deepEqual(thin(one.found).map((c) => Math.round(c.key)), [C4]);
});

test("a sung line wavers and a piano's note holds still", () => {
  const voice = sing([{ midi: A4, dur: 1.5, vibrato: { rate: 5.5, depth: 0.3 } }], { seed: 5 });
  const sung = followLines(trackPitches(voice.samples, { every: 2 })).lines;
  assert.ok(sung.length >= 1 && voiceLike(sung[0]) > 0.6, "sung: " + sung.map(voiceLike));
  const keys = followLines(trackPitches(piano(1.6, [{ at: 0.1, dur: 1.4, keys: [C4] }]), { every: 2 })).lines;
  assert.ok(keys.length >= 1 && voiceLike(keys[0]) < 0.2, "struck: " + keys.map(voiceLike));
});

test("a voice over piano chords: the voice is the tune, the chords' keys are the harmony", async () => {
  // (A real voice is never still: the take's voice wavers a little, as the 40 real takes do.)
  const melody = [{ midi: E4, dur: 0.8 }, { midi: G4, dur: 0.8 }, { midi: A4, dur: 0.8 }, { midi: G4, dur: 0.8 }];
  const voice = sing(melody.map((n) => ({ ...n, gap: 0.1, vibrato: { rate: 5.5, depth: 0.2 } })), { seed: 4 });
  const seconds = voice.samples.length / ANALYSIS_RATE;
  const chords = [{ at: 0.1, dur: 1.7, keys: [C3, G3, C4] }, { at: 1.9, dur: 1.7, keys: [41, 53, 57] }];
  const x = add(voice.samples, piano(seconds, chords, 0.3));
  const result = await analyzeSamples(x, ANALYSIS_RATE);
  assert.equal(result.chords, true, "read as more than one voice");
  const tune = result.notes.filter((n) => !n.h);
  const harmony = result.notes.filter((n) => n.h);
  // The tune: every sung note is there on its key.
  for (const want of voice.truth) {
    const got = tune.find((n) => n.p === want.midi && Math.min(n.t + n.d, want.t + want.d) - Math.max(n.t, want.t) > 0.5 * want.d);
    assert.ok(got, `sung ${want.midi} at ${want.t.toFixed(2)}: ` + JSON.stringify(tune.map((n) => [+n.t.toFixed(2), n.p])));
  }
  // The harmony: some of the chords' keys (or their octaves), and nothing that is not in a chord.
  assert.ok(harmony.length >= 2, "harmony found: " + JSON.stringify(harmony.map((n) => [+n.t.toFixed(2), n.p])));
  for (const n of harmony) {
    const chord = chords.find((c) => n.t + n.d / 2 >= c.at && n.t + n.d / 2 < c.at + c.dur + 0.2);
    assert.ok(chord && chord.keys.some((k) => (k - n.p) % 12 === 0), `harmony ${n.p} at ${n.t.toFixed(2)} is one of the chord's notes`);
  }
});

test("one voice alone stays one voice: no harmony, the notes as the pitch tracker gives them", async () => {
  const voice = sing([{ midi: C4, dur: 0.6 }, { midi: E4, dur: 0.6 }, { midi: G4, dur: 0.8, vibrato: { rate: 5.5, depth: 0.4 } }], { seed: 8, noise: 0.004 });
  assert.equal(await chordsOf(voice.samples), null);
  const result = await analyzeSamples(voice.samples, voice.rate);
  assert.ok(!result.chords && result.notes.every((n) => !n.h));
  assert.deepEqual(result.notes.map((n) => n.p), [C4, E4, G4]);
});

test("a long take that is one voice in its three sampled pieces is not looked through whole", async () => {
  const notes = [];
  for (let i = 0; i < 70; i++) notes.push({ midi: [C4, E4, G4, A4][i % 4], dur: 0.6, gap: 0.1 });
  const voice = sing(notes, { seed: 11 });
  let last = 0;
  assert.equal(await chordsOf(voice.samples, { onProgress: (p) => { last = p; } }), null);
  assert.ok(last > 0.8 && last < 1, "progress ran to the end of the three pieces only: " + last);
});

test("the pitch tracker's tune and the harmony found are joined when they are the same tune", () => {
  const solo = [{ t: 0, d: 1, p: 64, v: 0.8 }, { t: 1, d: 1, p: 67, v: 0.8 }];
  const found = [{ t: 0.02, d: 0.9, p: 64, v: 0.7 }, { t: 0, d: 2, p: 48, v: 0.3, h: true }, { t: 1.05, d: 0.9, p: 67, v: 0.7 }, { t: 1, d: 0.5, p: 67, v: 0.2, h: true }];
  assert.ok(agreement(found.filter((n) => !n.h), solo) > 0.95);
  assert.equal(agreement([{ t: 0, d: 1, p: 50, v: 1 }], solo), 0);
  const joined = tuneWithHarmony(solo, found);
  assert.deepEqual(joined.map((n) => [n.p, !!n.h]), [[48, true], [64, false], [67, false]], "the harmony that is the tune's own note again is left out");
});
