import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fromBase64 } from "../src/core/b64.js";
import { swiftF0, swiftPitch, SWIFT_RATE, SWIFT_FRAME } from "../src/audio/swiftf0.js";

const ref = JSON.parse(readFileSync(new URL("./fixtures/swiftf0-ref.json", import.meta.url), "utf8"));
const pcm = new Int16Array(fromBase64(ref.pcm).buffer);
const audio = Float32Array.from(pcm, (v) => v / 32768);

test("SwiftF0 in plain JS gives what the original model gives: pitch within a cent where voiced, confidence within 0.01", () => {
  const r = swiftPitch(audio);
  assert.equal(r.hz.length, ref.pitch.length, "one frame per 256 samples");
  for (let i = 0; i < ref.pitch.length; i++) {
    assert.ok(Math.abs(r.conf[i] - ref.confidence[i]) < 0.01, `confidence at frame ${i}: ${r.conf[i]} vs ${ref.confidence[i]}`);
    if (ref.confidence[i] > 0.3) {
      const cents = 1200 * Math.abs(Math.log2(r.hz[i] / ref.pitch[i]));
      assert.ok(cents < 1, `pitch at frame ${i}: ${r.hz[i]} vs ${ref.pitch[i]} (${cents.toFixed(2)} cents)`);
    }
  }
});

test("swiftF0 takes any rate, gives time, pitch, confidence and loudness per 16 ms, and silence is never voiced", () => {
  // The same sound at 48 kHz (each sample three times) and a second of silence after it.
  const up = new Float32Array(audio.length * 3 + 48000);
  for (let i = 0; i < audio.length; i++) up[3 * i] = up[3 * i + 1] = up[3 * i + 2] = audio[i];
  const r = swiftF0(up, 48000);
  assert.equal(SWIFT_RATE, 16000);
  assert.equal(SWIFT_FRAME, 0.016);
  assert.ok(Math.abs(r.hz.length - Math.floor(up.length / 3 / 256)) <= 1);
  const voiced = [...r.conf].map((c, i) => (c >= 0.5 ? i : -1)).filter((i) => i >= 0);
  assert.ok(voiced.length > 10, "the tone is voiced");
  const mid = voiced[Math.floor(voiced.length / 2)];
  assert.ok(r.hz[mid] > 170 && r.hz[mid] < 270, "a pitch in the glide: " + r.hz[mid]);
  const silentFrom = Math.ceil((audio.length / 16000 + 0.1) / SWIFT_FRAME);
  for (let i = silentFrom; i < r.conf.length; i++) assert.equal(r.conf[i], 0, "silence at frame " + i);
  assert.ok(r.db[silentFrom + 5] < -100 && r.db[mid] > -30, "loudness in dB");
});

test("a long take is worked through in windows and gives the same frames as one pass would", () => {
  // 40 s of a slow glide: longer than one window (30 s), so the joins between windows are crossed.
  const n = 40 * 16000;
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = 150 + 100 * Math.sin((2 * Math.PI * i) / (n / 3));
    ph += (2 * Math.PI * f) / 16000;
    x[i] = 0.2 * Math.sin(ph) + 0.1 * Math.sin(2 * ph);
  }
  const r = swiftF0(x, 16000);
  assert.equal(r.hz.length, Math.floor(n / 256));
  let off = 0;
  for (let i = 10; i < r.hz.length - 10; i++) {
    const t = i * 256;
    const want = 150 + 100 * Math.sin((2 * Math.PI * t) / (n / 3));
    if (r.conf[i] >= 0.5 && Math.abs(1200 * Math.log2(r.hz[i] / want)) > 30) off++;
  }
  assert.ok(off < r.hz.length * 0.01, "follows the glide everywhere, also across the window joins: " + off);
});

test("worked through a few seconds at a time, a take gives the very same frames", async () => {
  const { swiftF0Async } = await import("../src/audio/swiftf0.js");
  const n = 9 * 16000;
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) { ph += (2 * Math.PI * (180 + 60 * Math.sin(i / 9000))) / 16000; x[i] = 0.2 * Math.sin(ph) + 0.08 * Math.sin(2 * ph); }
  const whole = swiftF0(x, 16000);
  let pauses = 0;
  const parts = await swiftF0Async(x, 16000, { seconds: 2, pause: async () => { pauses++; } });
  assert.ok(pauses >= 4, "it paused between pieces");
  for (let i = 0; i < whole.hz.length; i++) {
    assert.ok(Math.abs(whole.conf[i] - parts.conf[i]) < 1e-5, "confidence " + i);
    if (whole.conf[i] > 0.3) assert.ok(Math.abs(whole.hz[i] - parts.hz[i]) < 1e-3, "pitch " + i);
  }
});
