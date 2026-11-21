// The owner's own takes, end to end as the app does it (the owner: "내가 준 녹음으로 테스트 해보고 있는거지?"):
// the notes found after recording, the piano that plays them (부른 그대로, the default) and both
// compared with the voice itself, by SwiftF0 and by YIN (a different method), and the piano rendered
// and listened to again. The takes live in out/voices/owner/ only (never in the repository): each
// <name>.f32 there is 16 kHz mono float32, made from the phone's file with
//   ffmpeg -i take.m4a -ac 1 -ar 16000 -f f32le take.f32
// Run: node tools/owner-take.mjs [file.f32 …]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { voiceNotes } from "../src/audio/analyze.js";
import { swiftF0 } from "../src/audio/swiftf0.js";
import { trackPitch, HOP_SECONDS } from "../src/audio/pitch.js";
import { renderPianoNote } from "../src/audio/piano.js";
import { hzToMidi, noteLabel } from "../src/audio/notes.js";

const RATE = 16000;
const DIR = "out/voices/owner";
const files = process.argv.slice(2).length ? process.argv.slice(2) : existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".f32")).map((f) => join(DIR, f)) : [];
if (!files.length) {
  console.log(`${DIR}/ 에 녹음이 없어요. ffmpeg -i take.m4a -ac 1 -ar 16000 -f f32le ${DIR}/take.f32 로 만들어 넣으세요.`);
  process.exit(0);
}
for (const file of files) await check(file);

async function check(file) {
const buf = readFileSync(file);
const x = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
console.log(file + ":", (x.length / RATE).toFixed(1), "s");
const { notes } = await voiceNotes(x, RATE);
const played = notes.map((n) => ({ t: n.t, d: n.d, key: n.s ?? n.p, meant: n.p, v: n.v }));
console.log("notes:", played.length);

// Two references of the voice's own pitch: SwiftF0 (16 ms) and YIN (10 ms, a different method).
const sw = swiftF0(x, RATE);
const yin = trackPitch(x);
const median = (a) => { const s = [...a].sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const swiftIn = (t0, t1) => { const out = []; for (let i = Math.floor(t0 / sw.frame); i < Math.min(sw.hz.length, Math.ceil(t1 / sw.frame)); i++) if (sw.conf[i] >= 0.5 && sw.hz[i] > 0) out.push(hzToMidi(sw.hz[i])); return out; };
const yinIn = (t0, t1) => { const out = []; for (let i = Math.floor(t0 / HOP_SECONDS); i < Math.min(yin.length, Math.ceil(t1 / HOP_SECONDS)); i++) if (yin[i].hz > 0 && yin[i].conf >= 0.6) out.push(hzToMidi(yin[i].hz)); return out; };
const score = (ref, keyOf) => {
  let near = 0, far = 0, n = 0;
  for (const p of played) {
    const m = median(ref(p.t, p.t + p.d));
    if (!Number.isFinite(m)) continue;
    n++;
    const c = Math.abs(keyOf(p) - m) * 100;
    if (c <= 50) near++;
    if (c > 100) far++;
  }
  return { n, near, far };
};
for (const [name, ref] of [["SwiftF0", swiftIn], ["YIN", yinIn]]) {
  const sung = score(ref, (p) => p.key);
  const meant = score(ref, (p) => p.meant);
  console.log(`${name}: 피아노(부른 그대로) ±50센트 ${sung.near}/${sung.n}, 반음 넘게 틀림 ${sung.far} | 음 다듬기 쪽 ±50센트 ${meant.near}/${meant.n}, 반음 넘게 ${meant.far}`);
}

// The piano itself, rendered and listened to again: does what it plays follow the voice?
const out = new Float32Array(x.length + RATE);
for (const p of played) {
  const tone = renderPianoNote(p.key, { rate: RATE, velocity: p.v, seconds: p.d + 0.25 });
  const at = Math.round(p.t * RATE);
  const cut = Math.round(p.d * RATE);
  const fade = Math.round(0.08 * RATE);
  for (let i = 0; i < tone.length && at + i < out.length; i++) {
    const g = i < cut ? 1 : Math.max(0, 1 - (i - cut) / fade);
    if (g <= 0) break;
    out[at + i] += tone[i] * g * 0.6;
  }
}
const pf = swiftF0(out, RATE);
let voiced = 0, covered = 0, same = 0, octave = 0, key = 0;
const diffs = [];
const signed = [];
for (let i = 0; i < sw.hz.length; i++) {
  if (!(sw.conf[i] >= 0.5 && sw.hz[i] > 0)) continue;
  voiced++;
  if (!(pf.conf[i] >= 0.5 && pf.hz[i] > 0)) continue;
  covered++;
  const c = Math.abs(hzToMidi(pf.hz[i]) - hzToMidi(sw.hz[i])) * 100;
  if (c < 600) { diffs.push(c); signed.push((hzToMidi(sw.hz[i]) - hzToMidi(pf.hz[i])) * 100); }
  if (c <= 100) key++;
  if (c <= 50) same++;
  else if (Math.abs(c - 1200) <= 50) octave++;
}
console.log(`피아노를 다시 들어 본 것: 목소리가 나는 ${voiced}칸 중 피아노도 ${covered}칸(${(100 * covered / voiced).toFixed(1)}%), 그중 같은 음(±50센트) ${same}칸(${(100 * same / covered).toFixed(1)}%), 옥타브만 다름 ${octave}`);
diffs.sort((a, b) => a - b);
signed.sort((a, b) => a - b);
console.log(`칸마다 차이: 가운데 ${diffs[diffs.length >> 1].toFixed(0)}센트, 90%가 ${diffs[Math.floor(diffs.length * 0.9)].toFixed(0)}센트 안, ±100센트 안 ${(100 * key / covered).toFixed(1)}%; 목소리 - 피아노 가운데 ${signed[signed.length >> 1].toFixed(0)}센트`);
console.log("첫 음 다섯:", played.slice(0, 5).map((p) => `${p.t.toFixed(2)}s ${noteLabel(p.key)} ${(p.d * 1000) | 0}ms`).join(", "));
}
