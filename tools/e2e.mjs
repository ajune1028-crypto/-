// Two-screen scenarios in headless Chrome.
//   node tools/e2e.mjs            run against the source files
//   node tools/e2e.mjs --dist     run against the bundled single file
//   node tools/e2e.mjs name...    run only scenarios whose name contains a word
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { serve } from "./serve.mjs";
import { launch } from "./cdp.mjs";
import { scenarios } from "./scenarios.mjs";
import { startFakeFirebase } from "../tests/mocks/fake-firebase.mjs";
import { sing } from "../tests/fixtures/voice.js";
import { encodeWav } from "../src/audio/wav.js";
import { renderPianoNote } from "../src/audio/piano.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dist = args.includes("--dist");
const only = args.filter((a) => !a.startsWith("--"));
const PORT = 8123;

// Sung melodies with known notes: one to import as a file, one that Chrome plays as its microphone.
const fixtures = { doremi: join(root, "out", "fixtures", "doremi.wav"), mic: join(root, "out", "fixtures", "mic.wav") };
mkdirSync(dirname(fixtures.doremi), { recursive: true });
{
  const melody = [60, 62, 64, 65, 67].map((midi) => ({ midi, dur: 0.45 }));
  writeFileSync(fixtures.doremi, encodeWav(sing(melody, { rate: 44100 }).samples, 44100));
  const take = [67, 64, 64, 65, 62, 62].map((midi, i) => ({ midi, dur: i === 2 || i === 5 ? 0.6 : 0.3, gap: 0.04 }));
  writeFileSync(fixtures.mic, encodeWav(sing(take, { rate: 48000, lead: 0.3, tail: 3 }).samples, 48000));
  // The formats phones save recordings in (Samsung 녹음 keeps .m4a), made with ffmpeg when it is installed.
  const codecs = { m4a: ["-c:a", "aac", "-b:a", "96k"], mp3: ["-c:a", "libmp3lame", "-b:a", "96k"], webm: ["-c:a", "libopus", "-b:a", "64k"] };
  for (const [ext, args] of Object.entries(codecs)) {
    const file = join(root, "out", "fixtures", "doremi." + ext);
    const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", fixtures.doremi, ...args, file]);
    fixtures[ext] = made.status === 0 ? file : null;
  }
  // What an iPhone or iPad camera gives for "record a sound": a .mov with a picture and AAC sound.
  {
    const file = join(root, "out", "fixtures", "doremi.mov");
    const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", fixtures.doremi, "-f", "lavfi", "-i", "testsrc=size=96x64:rate=10:duration=3", "-c:a", "aac", "-b:a", "96k", "-c:v", "mpeg4", "-shortest", file]);
    fixtures.mov = made.status === 0 ? file : null;
  }
  // The same singing recorded far from the phone: 34 dB softer.
  fixtures.quiet = join(root, "out", "fixtures", "doremi-quiet.wav");
  writeFileSync(fixtures.quiet, encodeWav(sing(melody, { rate: 44100 }).samples.map((v) => v * 0.02), 44100));
  // A voice (wavering a little, as voices do) over piano chords: 미 솔 라 솔 over 도 and 파 chords.
  {
    const rate = 32000;
    const voice = sing([64, 67, 69, 67].map((midi) => ({ midi, dur: 0.8, gap: 0.1, vibrato: { rate: 5.5, depth: 0.2 } })), { rate, seed: 4 });
    const mix = Float32Array.from(voice.samples);
    for (const { at, keys } of [{ at: 0.1, keys: [48, 55, 60] }, { at: 1.9, keys: [41, 53, 57] }]) {
      for (const key of keys) {
        const tone = renderPianoNote(key, { rate, seconds: 1.7, velocity: 0.7 });
        const s0 = Math.round(at * rate);
        for (let k = 0; k < tone.length && s0 + k < mix.length; k++) mix[s0 + k] += 0.3 * tone[k];
      }
    }
    fixtures.duet = join(root, "out", "fixtures", "voice-and-piano.wav");
    writeFileSync(fixtures.duet, encodeWav(mix, rate));
  }
}

const server = await serve(dist ? join(root, "dist") : root, PORT);
// A photo to hide in words: a small gradient PNG, written here without any tools.
{
  const { deflateSync } = await import("node:zlib");
  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (const byte of buf) {
      crc ^= byte;
      for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const w = 800, h = 600;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([Math.round((255 * x) / w), Math.round((180 * y) / h), 200], y * (w * 3 + 1) + 1 + x * 3);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 2, 0, 0, 0], 8);
  fixtures.photo = join(root, "out", "fixtures", "photo.png");
  writeFileSync(fixtures.photo, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

// A stand-in room server (the Firebase REST API) for the scenarios of the public address.
const firebase = await startFakeFirebase();
fixtures.server = firebase.url;
fixtures.firebase = firebase;

const browser = await launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-file-for-fake-audio-capture=" + fixtures.mic, "--autoplay-policy=no-user-gesture-required"] });
let seq = 0;
let failed = 0;
const started = Date.now();

for (const { name, run } of scenarios) {
  if (only.length && !only.some((word) => name.includes(word))) continue;
  const ns = "e2e" + Date.now().toString(36) + ++seq;
  const pages = [];
  const open = async ({ dev = "a", hash = "", sandbox = false, query = "", ...view } = {}) => {
    const page = await browser.page(`http://127.0.0.1:${PORT}/index.html?ns=${ns}&dev=${dev}${sandbox ? "&sandbox=1" : ""}${query ? "&" + query : ""}${hash ? "#" + hash : ""}`, view);
    pages.push(page);
    await page.waitFor("window.__app && window.__app.booted");
    return page;
  };
  const t0 = Date.now();
  try {
    await run({ open, out: (file) => join(root, "out", file), fixtures });
    const errors = pages.flatMap((p) => p.errors);
    if (errors.length) throw new Error("page errors: " + errors.slice(0, 3).join(" | "));
    console.log(`ok   ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(err.message).split("\n").join("\n     ")}`);
  }
  await Promise.all(pages.map((p) => p.close()));
}

await browser.close();
server.close();
await firebase.close();
console.log(`${failed ? "FAILED" : "PASSED"}: ${failed} failed (${Math.round((Date.now() - started) / 100) / 10} s)`);
process.exit(failed ? 1 : 0);
