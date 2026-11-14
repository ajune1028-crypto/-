// Two-screen scenarios in headless Chrome.
//   node tools/e2e.mjs            run against the source files
//   node tools/e2e.mjs --dist     run against the bundled single file
//   node tools/e2e.mjs name...    run only scenarios whose name contains a word
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { serve } from "./serve.mjs";
import { launch } from "./cdp.mjs";
import { scenarios } from "./scenarios.mjs";
import { sing } from "../tests/fixtures/voice.js";
import { encodeWav } from "../src/audio/wav.js";

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
}

const server = await serve(dist ? join(root, "dist") : root, PORT);
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
console.log(`${failed ? "FAILED" : "PASSED"}: ${failed} failed (${Math.round((Date.now() - started) / 100) / 10} s)`);
process.exit(failed ? 1 : 0);
