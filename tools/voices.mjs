// Scores the singing → notes path on real recordings (the owner: "사람들의 목소리로 테스트해봐").
//
//   node tools/voices.mjs [name part…] [--roll] [--meant]   every take under out/voices/ (--meant: the keys
//                                                     meant, 음 다듬기; else what plays, what was sung)
//   node tools/voices.mjs --mixes [name part…]        real takes sung together and over a piano
//
// Reads out/voices/<set>/<name>_m.wav (mono 16-bit, any rate) and, when it is there, the reference
// notes beside it: <name>_notesA1.csv (start seconds, Hz, length seconds), as the Vocadito dataset
// writes them. Nothing in out/ is in git: recordings of people stay out of the public repository.
// Where the files come from is written in docs/superpowers/specs/2026-11-15-singing-to-piano-research.md.
//
// Scores, as mir_eval's transcription measures do: a note is right when it starts within 50 ms of
// a reference note and is within half a semitone of it (each reference note matched once). Beside
// that, time-based: of the time someone sings, how much lies under the right key, a wrong key, an
// octave off, or no note at all; and how much is played where nobody sings.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decodeWav } from "../src/audio/wav.js";
import { toMono } from "../src/audio/dsp.js";
import { analyzeSamples } from "../src/audio/analyze.js";
import { hzToMidi, noteLabel } from "../src/audio/notes.js";

const ROOT = new URL("../out/voices/", import.meta.url).pathname;

export function loadWav(path) {
  const wav = decodeWav(readFileSync(path));
  return { samples: toMono(wav.channels), rate: wav.rate };
}

export function loadRefNotes(path) {
  return readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [t, hz, d] = l.split(",").map(Number);
    return { t, d, m: hzToMidi(hz) };
  }).filter((n) => Number.isFinite(n.t) && Number.isFinite(n.m));
}

/** Most pairs (ref i, est j) allowed by ok(i, j), each used once: augmenting paths. */
function matchPairs(nRef, nEst, ok) {
  const estOf = new Int32Array(nRef).fill(-1);
  const refOf = new Int32Array(nEst).fill(-1);
  const tryRef = (i, seen) => {
    for (let j = 0; j < nEst; j++) {
      if (!ok(i, j) || seen[j]) continue;
      seen[j] = 1;
      if (refOf[j] < 0 || tryRef(refOf[j], seen)) {
        refOf[j] = i;
        estOf[i] = j;
        return true;
      }
    }
    return false;
  };
  let n = 0;
  for (let i = 0; i < nRef; i++) if (tryRef(i, new Uint8Array(nEst))) n++;
  return { n, estOf };
}

const prf = (hit, nRef, nEst) => {
  const p = nEst ? hit / nEst : 0;
  const r = nRef ? hit / nRef : 0;
  return { p, r, f: p + r ? (2 * p * r) / (p + r) : 0 };
};

/** ref: [{ t, d, m (float key) }], est: [{ t, d, p }] → the scores described above. */
export function score(ref, est, { onset = 0.05, cents = 50, step = 0.01 } = {}) {
  const near = (i, j) => Math.abs(ref[i].t - est[j].t) <= onset;
  const pitch = (i, j) => Math.abs(ref[i].m - est[j].p) <= cents / 100;
  const off = (i, j) => Math.abs(ref[i].t + ref[i].d - est[j].t - est[j].d) <= Math.max(0.05, 0.2 * ref[i].d);
  const on = matchPairs(ref.length, est.length, near).n;
  const onp = matchPairs(ref.length, est.length, (i, j) => near(i, j) && pitch(i, j)).n;
  const onpoff = matchPairs(ref.length, est.length, (i, j) => near(i, j) && pitch(i, j) && off(i, j)).n;
  // By time.
  const end = Math.max(0, ...ref.map((n) => n.t + n.d), ...est.map((n) => n.t + n.d));
  const at = (notes, t) => notes.filter((n) => n.t <= t && t < n.t + n.d);
  const time = { right: 0, semitone: 0, octave: 0, wrong: 0, missed: 0, extra: 0, sung: 0 };
  for (let t = step / 2; t < end; t += step) {
    const r = at(ref, t)[0];
    const e = at(est, t);
    if (!r) {
      if (e.length) time.extra++;
      continue;
    }
    time.sung++;
    if (!e.length) { time.missed++; continue; }
    const d = Math.min(...e.map((n) => Math.abs(n.p - r.m)));
    const dOct = Math.min(...e.map((n) => Math.abs(Math.abs(n.p - r.m) - 12)), ...e.map((n) => Math.abs(Math.abs(n.p - r.m) - 24)));
    if (d <= 0.5) time.right++;
    else if (d <= 1.5) time.semitone++;
    else if (dOct <= 0.5) time.octave++;
    else time.wrong++;
  }
  return { nRef: ref.length, nEst: est.length, on: prf(on, ref.length, est.length), onp: prf(onp, ref.length, est.length), onpoff: prf(onpoff, ref.length, est.length), time };
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0).padStart(3) + "%" : "  –");

export function line(name, s) {
  const t = s.time;
  return `${name.padEnd(22)} notes ${String(s.nEst).padStart(3)}/${String(s.nRef).padStart(3)}  start F ${s.on.f.toFixed(2)}  start+key F ${s.onp.f.toFixed(2)} (P ${s.onp.p.toFixed(2)} R ${s.onp.r.toFixed(2)})  +end F ${s.onpoff.f.toFixed(2)}` +
    `  | sung time: right ${pct(t.right, t.sung)} semitone ${pct(t.semitone, t.sung)} octave ${pct(t.octave, t.sung)} wrong ${pct(t.wrong, t.sung)} missed ${pct(t.missed, t.sung)}  extra ${pct(t.extra, t.sung)}`;
}

/** A text piano roll: one line per 100 ms, reference and estimate side by side. */
export function roll(ref, est, from = 0, to = Infinity) {
  const end = Math.min(to, Math.max(0, ...ref.map((n) => n.t + n.d), ...est.map((n) => n.t + n.d)));
  const out = [];
  for (let t = from; t < end; t += 0.1) {
    const r = ref.filter((n) => n.t < t + 0.1 && t < n.t + n.d).map((n) => `${noteLabel(Math.round(n.m))}(${n.m.toFixed(1)})`);
    const e = est.filter((n) => n.t < t + 0.1 && t < n.t + n.d).map((n) => noteLabel(n.p) + (n.h ? "'" : ""));
    out.push(`${t.toFixed(1).padStart(5)}  ${r.join(" ").padEnd(22)} | ${e.join(" ")}`);
  }
  return out.join("\n");
}

export function listTakes(words = []) {
  const takes = [];
  if (!existsSync(ROOT)) return takes;
  for (const set of readdirSync(ROOT)) {
    const dir = join(ROOT, set);
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith("_m.wav")) continue;
      const name = f.slice(0, -6);
      if (words.length && !words.some((w) => (set + "/" + name).includes(w))) continue;
      const refPath = ["_notesA1.csv", "_notes.csv"].map((s) => join(dir, name + s)).find(existsSync);
      takes.push({ set, name, wav: join(dir, f), ref: refPath || null });
    }
  }
  return takes.sort((a, b) => (a.set + a.name).localeCompare(b.set + b.name));
}

// ---- mixes: real solo takes sung together, or over a piano (the references are known) -------------

const loudOf = (x) => {
  const w = 1600;
  const r = [];
  for (let i = 0; i + w <= x.length; i += w) { let e = 0; for (let k = i; k < i + w; k++) e += x[k] * x[k]; r.push(Math.sqrt(e / w)); }
  r.sort((a, b) => a - b);
  return r[Math.floor(r.length * 0.8)] || 1e-9;
};
/** a + b, b's loud parts `db` below (above, when positive) a's. */
export function mixOf(a, b, db = 0) {
  const n = Math.min(a.length, b.length);
  const g = (loudOf(a) / loudOf(b)) * 10 ** (db / 20);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] + g * b[i];
  return out;
}
/** A piano under a take: four chords in turn, held or broken. Returns { x (at `rate`), notes: [{ t, d, m }] }. */
export async function pianoUnder(seconds, rate, { beat = 1.6, broken = false, chords = [[48, 55, 60, 64], [43, 55, 59, 62], [45, 57, 60, 64], [41, 53, 57, 60]] } = {}) {
  const { renderPianoNote } = await import("../src/audio/piano.js");
  const { resample } = await import("../src/audio/dsp.js");
  const out = new Float32Array(Math.round(seconds * rate));
  const notes = [];
  const cache = new Map();
  for (let t = 0, c = 0; t < seconds; t += beat, c++) {
    chords[c % chords.length].forEach((key, i, chord) => {
      const at = t + (broken ? (i * beat) / chord.length : 0);
      const dur = broken ? beat / chord.length : beat;
      const id = key + ":" + dur.toFixed(2);
      if (!cache.has(id)) cache.set(id, resample(renderPianoNote(key, { rate: 32000, seconds: dur, velocity: 0.7 }), 32000, rate));
      const buf = cache.get(id);
      const s0 = Math.round(at * rate);
      for (let k = 0; k < buf.length && s0 + k < out.length; k++) out[s0 + k] += buf[k];
      notes.push({ t: at, d: dur, m: key });
    });
  }
  return { x: out, notes };
}

/** A piano that plays under every sung note, `below` semitones under it (12: an octave, 19: a twelfth): the hardest harmony to tell from the voice's own harmonics. */
export async function pianoFollowing(refNotes, seconds, rate, below) {
  const { renderPianoNote } = await import("../src/audio/piano.js");
  const { resample } = await import("../src/audio/dsp.js");
  const out = new Float32Array(Math.round(seconds * rate));
  const notes = [];
  for (const n of refNotes) {
    const key = Math.round(n.m) - below;
    const buf = resample(renderPianoNote(key, { rate: 32000, seconds: Math.max(0.2, n.d), velocity: 0.7 }), 32000, rate);
    const s0 = Math.round(n.t * rate);
    for (let k = 0; k < buf.length && s0 + k < out.length; k++) out[s0 + k] += buf[k];
    notes.push({ t: n.t, d: Math.max(0.2, n.d), m: key });
  }
  return { x: out, notes };
}

/** The harmony found, by time: how much of it lies on a key really sounding (or its octave), and how much of the real harmony was found. */
export function harmonyScore(est, refs, other = []) {
  const harm = est.filter((n) => n.h);
  let on = 0, total = 0, refOn = 0, refTotal = 0;
  const end = Math.max(0, ...refs.map((n) => n.t + n.d), ...harm.map((n) => n.t + n.d));
  for (let t = 0.005; t < end; t += 0.01) {
    const r = refs.filter((n) => n.t <= t && t < n.t + n.d);
    const any = [...r, ...other.filter((n) => n.t <= t && t < n.t + n.d)];
    const e = harm.filter((n) => n.t <= t && t < n.t + n.d);
    for (const x of e) { total++; if (any.some((y) => Math.abs(y.m - x.p) <= 0.5 || Math.abs(Math.abs(y.m - x.p) - 12) <= 0.5)) on++; }
    for (const y of r) { refTotal++; if (e.some((x) => Math.abs(y.m - x.p) <= 0.5)) refOn++; }
  }
  return { notes: harm.length, right: total ? on / total : 0, found: refTotal ? refOn / refTotal : 0 };
}

async function runMixes(words) {
  const dir = join(ROOT, "vocadito");
  const take = (id) => ({ ...loadWav(join(dir, `vocadito_${id}_m.wav`)), notes: loadRefNotes(join(dir, `vocadito_${id}_notesA1.csv`)) });
  if (!existsSync(join(dir, "vocadito_1_m.wav"))) return void console.log("the mixes need out/voices/vocadito (see the research document)");
  const a = take(1), b = take(2), c = take(21);
  const cases = [
    ["duo: 1 leads, 2 at -6 dB", () => ({ x: mixOf(a.samples, b.samples, -6), tune: a.notes, harmony: b.notes })],
    ["duo: 2 leads, 1 at -6 dB", () => ({ x: mixOf(b.samples, a.samples, -6), tune: b.notes, harmony: a.notes })],
    ["duo: 21 leads, 2 at -6 dB", () => ({ x: mixOf(c.samples, b.samples, -6), tune: c.notes, harmony: b.notes })],
    ["1 over piano chords -12 dB", async () => { const p = await pianoUnder(a.samples.length / a.rate, a.rate); return { x: mixOf(a.samples, p.x, -12), tune: a.notes, harmony: p.notes }; }],
    ["1 over piano chords -6 dB", async () => { const p = await pianoUnder(a.samples.length / a.rate, a.rate); return { x: mixOf(a.samples, p.x, -6), tune: a.notes, harmony: p.notes }; }],
    ["1 over piano chords 0 dB", async () => { const p = await pianoUnder(a.samples.length / a.rate, a.rate); return { x: mixOf(a.samples, p.x, 0), tune: a.notes, harmony: p.notes }; }],
    ["1 over a piano an octave below -6 dB", async () => { const p = await pianoFollowing(a.notes, a.samples.length / a.rate, a.rate, 12); return { x: mixOf(a.samples, p.x, -6), tune: a.notes, harmony: p.notes }; }],
    ["2 over a piano a twelfth below -6 dB", async () => { const p = await pianoFollowing(b.notes, b.samples.length / b.rate, b.rate, 19); return { x: mixOf(b.samples, p.x, -6), tune: b.notes, harmony: p.notes }; }],
    ["2 over broken chords -6 dB", async () => { const p = await pianoUnder(b.samples.length / b.rate, b.rate, { broken: true }); return { x: mixOf(b.samples, p.x, -6), tune: b.notes, harmony: p.notes }; }],
    ["21 over broken chords -6 dB", async () => { const p = await pianoUnder(c.samples.length / c.rate, c.rate, { broken: true }); return { x: mixOf(c.samples, p.x, -6), tune: c.notes, harmony: p.notes }; }],
  ];
  for (const [name, make] of cases) {
    if (words.length && !words.some((w) => name.includes(w))) continue;
    const { x, tune, harmony } = await make();
    const t0 = performance.now();
    const result = await analyzeSamples(x, 44100, { chunkSeconds: 30 });
    const ms = performance.now() - t0;
    const h = harmonyScore(result.notes, harmony, tune);
    console.log(line(name, score(tune, result.notes.filter((n) => !n.h))) + `  [${(ms / 1000).toFixed(1)} s]`);
    console.log(`    ${result.chords ? `several pitches (the pitch tracker agrees on ${(100 * result.agree).toFixed(0)}% of the tune)` : "ONE VOICE (no harmony looked for)"}: harmony notes ${h.notes}, on a sounding key (or its octave) ${(100 * h.right).toFixed(0)}% of their time; of the real harmony ${(100 * h.found).toFixed(0)}% found`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const words = args.filter((a) => !a.startsWith("--"));
  if (args.includes("--mixes")) {
    await runMixes(words);
    process.exit(0);
  }
  const takes = listTakes(words);
  if (!takes.length) console.log("no recordings under out/voices/ (see the research document for where they come from)");
  for (const take of takes) {
    const { samples, rate } = loadWav(take.wav);
    const t0 = performance.now();
    const result = await analyzeSamples(samples, rate, { chunkSeconds: 5 });
    const ms = performance.now() - t0;
    // --meant scores the keys meant in the take's key (음 다듬기); by default what plays: what was sung.
    const est = args.includes("--meant") ? result.notes : result.notes.map((n) => (n.s === undefined ? n : { ...n, p: n.s }));
    const kind = result.chords ? `  several pitches (${est.filter((n) => n.h).length} harmony notes; agrees ${(100 * result.agree).toFixed(0)}%)` : "";
    if (take.ref) {
      const ref = loadRefNotes(take.ref);
      console.log(line(take.set + "/" + take.name, score(ref, est.filter((n) => !n.h))) + `  [${(ms / 1000).toFixed(1)} s for ${(samples.length / rate).toFixed(0)} s]` + kind);
      if (args.includes("--roll")) console.log(roll(ref, est));
    } else {
      console.log(`${(take.set + "/" + take.name).padEnd(22)} notes ${est.length} (no reference)  [${(ms / 1000).toFixed(1)} s for ${(samples.length / rate).toFixed(0)} s]` + kind);
      if (args.includes("--roll")) console.log(roll([], est));
    }
  }
}
