// Scores the singing → notes path on real recordings (the owner: "사람들의 목소리로 테스트해봐").
//
//   node tools/voices.mjs [name part…] [--roll] [--poly]
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const words = args.filter((a) => !a.startsWith("--"));
  const takes = listTakes(words);
  if (!takes.length) console.log("no recordings under out/voices/ (see the research document for where they come from)");
  for (const take of takes) {
    const { samples, rate } = loadWav(take.wav);
    const t0 = performance.now();
    const result = await analyzeSamples(samples, rate, { chunkSeconds: 5 });
    const ms = performance.now() - t0;
    const est = result.notes;
    if (take.ref) {
      const ref = loadRefNotes(take.ref);
      console.log(line(take.set + "/" + take.name, score(ref, est)) + `  [${(ms / 1000).toFixed(1)} s for ${(samples.length / rate).toFixed(0)} s]`);
      if (args.includes("--roll")) console.log(roll(ref, est));
    } else {
      console.log(`${(take.set + "/" + take.name).padEnd(22)} notes ${est.length} (no reference)  [${(ms / 1000).toFixed(1)} s for ${(samples.length / rate).toFixed(0)} s]`);
      if (args.includes("--roll")) console.log(roll([], est));
    }
  }
}
