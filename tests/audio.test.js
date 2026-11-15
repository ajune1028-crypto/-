import test from "node:test";
import assert from "node:assert/strict";
import { resample, StreamResampler, toMono } from "../src/audio/dsp.js";
import { trackPitch, ANALYSIS_RATE, HOP } from "../src/audio/pitch.js";
import { segmentNotes, solfege, noteLabel, midiToHz, hzToMidi } from "../src/audio/notes.js";
import { analyzeSamples, Analyzer } from "../src/audio/analyze.js";
import { sing, sine, score, midiHz } from "./fixtures/voice.js";
import { rng } from "./helpers.js";

const C4 = 60, D4 = 62, E4 = 64, F4 = 65, G4 = 67, A4 = 69;

function zeroCrossingHz(x, rate, from = 0.2, to = 0.8) {
  let n = 0;
  const a = Math.floor(x.length * from);
  const b = Math.floor(x.length * to);
  for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) n++;
  return n / ((b - a) / rate);
}

function rms(x, from = 0.2, to = 0.8) {
  let s = 0;
  const a = Math.floor(x.length * from);
  const b = Math.floor(x.length * to);
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
}

const analyze = (sig) => analyzeSamples(sig.samples, sig.rate);

function assertNotes(result, truth, { onset = 0.03, extra = 0 } = {}) {
  const s = score(result.notes, truth);
  const show = () => JSON.stringify({ found: result.notes.map((n) => [+n.t.toFixed(3), +n.d.toFixed(3), n.p]), truth: truth.map((n) => [+n.t.toFixed(3), +n.d.toFixed(3), n.midi]) });
  assert.ok(s.allPitches, "every pitch should match: " + show());
  for (const m of s.matches) assert.ok(m.onsetErr <= onset, `onset off by ${m.onsetErr.toFixed(3)} s: ` + show());
  assert.ok(s.extra.length <= extra, `${s.extra.length} notes nobody sang: ` + show());
  assert.equal(new Set(s.matches.map((m) => m.got)).size, truth.length, "one found note per sung note: " + show());
  return s;
}

// ---- resampling ---------------------------------------------------------------

test("resampling 48 kHz to 16 kHz keeps a 440 Hz tone's pitch and level", () => {
  const x = new Float32Array(48000);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  const y = resample(x, 48000, 16000);
  assert.ok(Math.abs(y.length - 16000) <= 1);
  assert.ok(Math.abs(zeroCrossingHz(y, 16000) - 440) < 3);
  assert.ok(Math.abs(rms(y) - 0.5 / Math.SQRT2) < 0.01);
});

test("resampling removes what the lower rate cannot hold instead of folding it back", () => {
  const x = new Float32Array(48000);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 10000 * i) / 48000);
  const y = resample(x, 48000, 16000);
  assert.ok(rms(y) < 0.02, "10 kHz must not survive at 16 kHz: " + rms(y));
});

test("resampling 44.1 kHz (an uneven ratio) keeps the pitch", () => {
  const x = new Float32Array(44100);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 330 * i) / 44100);
  const y = resample(x, 44100, 16000);
  assert.ok(Math.abs(zeroCrossingHz(y, 16000) - 330) < 3);
});

test("the streaming resampler gives the same samples whatever the chunk sizes", () => {
  const r = rng(3);
  const x = new Float32Array(30000);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(i / 7) * 0.4 + (r() - 0.5) * 0.1;
  const whole = resample(x, 44100, 16000);
  const stream = new StreamResampler(44100, 16000);
  const parts = [];
  for (let i = 0; i < x.length;) {
    const n = 1 + Math.floor(r() * 3000);
    parts.push(stream.push(x.subarray(i, i + n)));
    i += n;
  }
  parts.push(stream.flush());
  const joined = Float32Array.from(parts.flatMap((p) => Array.from(p)));
  assert.equal(joined.length, whole.length);
  for (let i = 0; i < whole.length; i++) assert.ok(Math.abs(joined[i] - whole[i]) < 1e-5, "sample " + i);
});

test("stereo becomes mono by averaging", () => {
  const m = toMono([Float32Array.of(1, 0.5), Float32Array.of(0, 0.5)]);
  assert.deepEqual(Array.from(m), [0.5, 0.5]);
});

// ---- pitch frames ---------------------------------------------------------------

test("pitch frames come every 10 ms and find a steady tone", () => {
  const sig = sine(220, 1, { rate: ANALYSIS_RATE });
  const frames = trackPitch(sig.samples);
  assert.equal(HOP, ANALYSIS_RATE / 100);
  const middle = frames.slice(30, 90);
  assert.ok(middle.length > 50);
  for (const f of middle) assert.ok(Math.abs(f.hz - 220) / 220 < 0.005, "found " + f.hz);
});

test("the lowest and highest voices in range are found: 70 Hz and 1000 Hz", () => {
  for (const hz of [70, 1000]) {
    const frames = trackPitch(sine(hz, 0.8, { rate: ANALYSIS_RATE }).samples);
    const mid = frames.slice(30, 70);
    const ok = mid.filter((f) => Math.abs(f.hz - hz) / hz < 0.01).length;
    assert.ok(ok >= mid.length * 0.9, hz + " Hz found in " + ok + "/" + mid.length);
  }
});

test("silence has no pitch", () => {
  const frames = trackPitch(new Float32Array(ANALYSIS_RATE));
  assert.ok(frames.every((f) => f.hz === 0));
});

// ---- notes from singing ----------------------------------------------------------

test("one held 라 becomes one note of the right pitch and length", async () => {
  const sig = sing([{ midi: A4, dur: 1 }]);
  const res = await analyze(sig);
  const s = assertNotes(res, sig.truth);
  assert.ok(s.matches[0].durErr < 0.04, "length off by " + s.matches[0].durErr);
});

test("도레미파솔 sung legato: five notes, every pitch, onsets within 30 ms", async () => {
  const sig = sing([C4, D4, E4, F4, G4].map((midi) => ({ midi, dur: 0.4 })));
  assertNotes(await analyze(sig), sig.truth);
});

test("a 도 held 0.5 s and one held 0.4 s come out 0.5 s and 0.4 s", async () => {
  const sig = sing([{ midi: C4, dur: 0.5, gap: 0.15 }, { midi: C4, dur: 0.4 }]);
  const s = assertNotes(await analyze(sig), sig.truth);
  for (const m of s.matches) assert.ok(m.durErr <= 0.03, `length ${m.got.d.toFixed(3)} for ${m.want.d}`);
});

test("the same pitch sung twice with a dip in between is two notes (라-라)", async () => {
  const sig = sing([{ midi: G4, dur: 0.35 }, { midi: G4, dur: 0.35, dip: 0.15 }, { midi: G4, dur: 0.35, dip: 0.15 }]);
  assertNotes(await analyze(sig), sig.truth);
});

test("라라라 sung without stopping: the dips of the l split it into notes", async () => {
  const sig = sing([{ midi: A4, dur: 0.35 }, { midi: A4, dur: 0.35, syllable: 0.3 }, { midi: A4, dur: 0.35, syllable: 0.3 }, { midi: G4, dur: 0.4, syllable: 0.3 }]);
  assertNotes(await analyze(sig), sig.truth);
});

test("notes with silence between them stay apart", async () => {
  const sig = sing([{ midi: E4, dur: 0.3, gap: 0.12 }, { midi: E4, dur: 0.3, gap: 0.2 }, { midi: C4, dur: 0.5 }]);
  assertNotes(await analyze(sig), sig.truth);
});

test("vibrato is one note, not a trill", async () => {
  const sig = sing([{ midi: A4, dur: 1.5, vibrato: { rate: 5.5, depth: 0.8 } }]);
  assertNotes(await analyze(sig), sig.truth);
});

test("slower, wider vibrato is still one note", async () => {
  const sig = sing([{ midi: E4, dur: 1.6, vibrato: { rate: 4.5, depth: 1.0 } }, { midi: C4, dur: 0.8, vibrato: { rate: 6.5, depth: 0.5 } }]);
  assertNotes(await analyze(sig), sig.truth);
});

test("a quick melody that goes back and forth is not mistaken for vibrato", async () => {
  const sig = sing([G4, E4, G4, E4, G4].map((midi) => ({ midi, dur: 0.25 })));
  assertNotes(await analyze(sig), sig.truth);
});

test("sliding from one note to the next keeps both pitches and adds nothing", async () => {
  const sig = sing([{ midi: C4, dur: 0.55, slide: 0.15 }, { midi: E4, dur: 0.5 }]);
  assertNotes(await analyze(sig), sig.truth, { onset: 0.06 });
});

test("a low voice with a weak fundamental is not put an octave too high", async () => {
  const sig = sing([{ midi: 43, dur: 0.6 }, { midi: 47, dur: 0.6 }, { midi: 50, dur: 0.6 }]); // G2 B2 D3
  assertNotes(await analyze(sig), sig.truth);
});

test("a high voice is found too", async () => {
  const sig = sing([{ midi: 76, dur: 0.4 }, { midi: 79, dur: 0.4 }, { midi: 81, dur: 0.4 }]); // E5 G5 A5
  assertNotes(await analyze(sig), sig.truth);
});

test("singing over steady background noise still gives the right notes", async () => {
  const sig = sing([C4, E4, G4, C4 + 12].map((midi) => ({ midi, dur: 0.4 })), { noise: 0.02 });
  assertNotes(await analyze(sig), sig.truth);
});

test("noise alone makes no notes", async () => {
  const r = rng(11);
  const x = new Float32Array(ANALYSIS_RATE * 2);
  for (let i = 0; i < x.length; i++) x[i] = (r() * 2 - 1) * 0.1;
  assert.equal((await analyzeSamples(x, ANALYSIS_RATE)).notes.length, 0);
});

test("a blip shorter than 80 ms is not a note", async () => {
  const sig = sing([{ midi: A4, dur: 0.05, gap: 0.3 }, { midi: C4, dur: 0.5 }]);
  const res = await analyze(sig);
  assert.equal(res.notes.length, 1);
  assert.equal(res.notes[0].p, C4);
});

test("a 44.1 kHz recording gives the same notes as the analysis rate", async () => {
  const notes = [C4, G4, E4].map((midi) => ({ midi, dur: 0.4 }));
  const low = sing(notes, { rate: ANALYSIS_RATE });
  const high = sing(notes, { rate: 44100 });
  const a = await analyze(low);
  const b = await analyze(high);
  assert.deepEqual(b.notes.map((n) => n.p), a.notes.map((n) => n.p));
  b.notes.forEach((n, i) => assert.ok(Math.abs(n.t - a.notes[i].t) < 0.015));
});

test("loudness becomes velocity between 0 and 1", async () => {
  const sig = sing([{ midi: C4, dur: 0.4, amp: 0.15, gap: 0.2 }, { midi: C4, dur: 0.4, amp: 0.6 }]);
  const { notes } = await analyze(sig);
  assert.equal(notes.length, 2);
  assert.ok(notes[0].v < notes[1].v);
  for (const n of notes) assert.ok(n.v > 0 && n.v <= 1);
});

test("analysis can be fed live in small pieces and ends with the same notes", async () => {
  const sig = sing([C4, D4, E4].map((midi) => ({ midi, dur: 0.35 })), { rate: 48000 });
  const live = new Analyzer(48000);
  let seenLive = 0;
  for (let i = 0; i < sig.samples.length; i += 2048) {
    live.push(sig.samples.subarray(i, i + 2048));
    seenLive = Math.max(seenLive, live.notes().length);
  }
  const done = live.finish();
  const whole = await analyzeSamples(sig.samples, 48000);
  assert.deepEqual(done.notes.map((n) => n.p), whole.notes.map((n) => n.p));
  assert.ok(seenLive >= 2, "notes appear while singing, not only at the end");
});

test("progress is reported and the work yields while analysing a long take", async () => {
  const sig = sing(Array.from({ length: 12 }, (_, i) => ({ midi: 60 + (i % 5), dur: 0.5 })));
  const seen = [];
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  await analyzeSamples(sig.samples, sig.rate, { onProgress: (p) => seen.push(p), chunkSeconds: 0.5 });
  clearInterval(timer);
  assert.ok(seen.length >= 5);
  assert.equal(seen[seen.length - 1], 1);
  assert.ok(ticks > 0, "other work ran while analysing");
});

// ---- names --------------------------------------------------------------------------

test("notes are named 도레미 with ♯ and the octave", () => {
  assert.deepEqual([60, 61, 62, 64, 65, 67, 69, 71, 72].map(solfege), ["도", "도♯", "레", "미", "파", "솔", "라", "시", "도"]);
  assert.equal(noteLabel(60), "도4");
  assert.equal(noteLabel(57), "라3");
  assert.equal(noteLabel(73), "도♯5");
});

test("hz and midi convert both ways", () => {
  assert.equal(Math.round(hzToMidi(440)), 69);
  assert.ok(Math.abs(midiToHz(60) - midiHz(60)) < 1e-9);
  assert.ok(Math.abs(hzToMidi(midiToHz(53.5)) - 53.5) < 1e-9);
});

test("segmentNotes works on frames alone, without audio", () => {
  // 50 frames of 도, 50 frames of 미, then silence.
  const frames = [];
  for (let i = 0; i < 50; i++) frames.push({ hz: midiHz(60), conf: 0.95, rms: 0.2 });
  for (let i = 0; i < 50; i++) frames.push({ hz: midiHz(64), conf: 0.95, rms: 0.2 });
  for (let i = 0; i < 20; i++) frames.push({ hz: 0, conf: 0, rms: 0 });
  const notes = segmentNotes(frames);
  assert.deepEqual(notes.map((n) => n.p), [60, 64]);
  assert.ok(Math.abs(notes[1].t - 0.5) < 0.02);
});

// ---- real recordings: far away, noisy (the owner's iPad file found almost nothing) ----

const MELODY = [60, 62, 64, 65, 67, 64, 60].map((midi, i) => ({ midi, dur: 0.45, gap: i === 3 ? 0.2 : 0, syllable: i && i !== 4 ? 0.35 : undefined, vibrato: i === 4 ? { rate: 5.5, depth: 0.35 } : undefined }));
const scaled = (sig, g) => ({ ...sig, samples: sig.samples.map((v) => v * g) });
function noisy(sig, level, seed = 3) {
  const r = rng(seed);
  return { ...sig, samples: sig.samples.map((v) => v + (r() * 2 - 1) * level) };
}

test("a quiet take (the phone far away: 30 and 40 dB down) gives every note", async () => {
  const sig = sing(MELODY, { rate: 48000 });
  for (const g of [0.03, 0.01]) assertNotes(await analyze(scaled(sig, g)), sig.truth);
});

test("loud noise (10 dB under the voice) does not put notes an octave down", async () => {
  const sig = sing(MELODY, { rate: 48000 });
  assertNotes(await analyze(noisy(sig, 0.1)), sig.truth);
});

test("a take with no singing louder than -60 dB has no notes (a pocket recording)", async () => {
  const sig = sing(MELODY, { rate: 48000 });
  assert.equal((await analyze(scaled(sig, 0.002))).notes.length, 0);
});

test("a quiet take is made louder to be heard (up to 24 dB, never past the top); a loud one stays", async () => {
  const { louder } = await import("../src/audio/dsp.js");
  const quiet = Float32Array.from({ length: 16000 }, (_, i) => 0.01 * Math.sin(i / 5));
  const up = louder(quiet);
  assert.ok(Math.abs(up.gain - 16) < 1e-9, "at most 16 times (24 dB): " + up.gain);
  assert.ok(Math.abs(Math.max(...up.samples) - 0.16) < 0.001);
  const half = Float32Array.from({ length: 16000 }, (_, i) => 0.2 * Math.sin(i / 5));
  const lifted = louder(half);
  assert.ok(Math.abs(Math.max(...lifted.samples.map(Math.abs)) - 0.89) < 0.002, "to just under the top");
  const loud = Float32Array.from({ length: 16000 }, (_, i) => 0.7 * Math.sin(i / 5));
  assert.equal(louder(loud).gain, 1, "loud enough already: untouched");
  assert.equal(louder(loud).samples, loud);
  assert.equal(louder(new Float32Array(100)).gain, 1, "silence stays silence");
});

test("the waveform summary follows a gain without measuring again", async () => {
  const { louder } = await import("../src/audio/dsp.js");
  const { peaksOf, scalePeaks } = await import("../src/audio/peaks.js");
  const quiet = Float32Array.from({ length: 16000 }, (_, i) => 0.02 * Math.sin(i / 3) * (i / 16000));
  const up = louder(quiet);
  const want = peaksOf(up.samples, 16000);
  const got = scalePeaks(peaksOf(quiet, 16000), up.gain);
  assert.equal(got.length, want.length);
  for (let i = 0; i < got.length; i++) assert.ok(Math.abs(got[i] - want[i]) <= 2, `peak ${i}: ${got[i]} vs ${want[i]}`);
});

test("a singer who is a little flat all through (45 cents) still gets the notes meant: the take's own tuning is found first", async () => {
  // Every note 0.45 semitones low, give or take a little: rounded one by one, some would fall a key down.
  const wobble = [0.08, -0.06, 0.05, -0.04, 0.07, -0.05, 0.03];
  const sig = sing(MELODY.map((n, i) => ({ ...n, midi: n.midi - 0.45 + wobble[i] })), { rate: 48000 });
  sig.truth = sig.truth.map((t) => ({ ...t, midi: Math.round(t.midi + 0.45) }));
  assertNotes(await analyze(sig), sig.truth);
});

test("in tune, the tuning step changes nothing", async () => {
  const sig = sing(MELODY, { rate: 48000 });
  assertNotes(await analyze(sig), sig.truth);
});
