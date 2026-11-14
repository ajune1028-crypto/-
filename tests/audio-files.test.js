import test from "node:test";
import assert from "node:assert/strict";
import { encodeWav, decodeWav } from "../src/audio/wav.js";
import { peaksOf, PeakCollector, toBase64, fromBase64, PEAKS_PER_SECOND } from "../src/audio/peaks.js";
import { rng } from "./helpers.js";

test("a recording survives a trip through a 16-bit WAV file", () => {
  const x = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.8);
  const wav = encodeWav(x, 24000);
  assert.equal(wav.length, 44 + 2000);
  const back = decodeWav(wav);
  assert.equal(back.rate, 24000);
  assert.equal(back.channels.length, 1);
  for (let i = 0; i < x.length; i++) assert.ok(Math.abs(back.channels[0][i] - x[i]) < 1 / 16000);
});

test("loud samples are clipped, not wrapped around", () => {
  const back = decodeWav(encodeWav(Float32Array.of(1.5, -1.5, 1, -1), 8000)).channels[0];
  assert.ok(back[0] > 0.99 && back[1] < -0.99 && back[2] > 0.99 && back[3] < -0.99);
});

test("stereo, 8-bit, 24-bit and float WAV files are read", () => {
  const make = (format, bits, channels, write) => {
    const frames = 4;
    const width = bits / 8;
    const bytes = new Uint8Array(44 + frames * channels * width);
    const v = new DataView(bytes.buffer);
    const s = (at, t) => { for (let i = 0; i < 4; i++) bytes[at + i] = t.charCodeAt(i); };
    s(0, "RIFF"); v.setUint32(4, bytes.length - 8, true); s(8, "WAVE"); s(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, format, true); v.setUint16(22, channels, true); v.setUint32(24, 8000, true);
    v.setUint32(28, 8000 * channels * width, true); v.setUint16(32, channels * width, true); v.setUint16(34, bits, true);
    s(36, "data"); v.setUint32(40, frames * channels * width, true);
    for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) write(v, bytes, 44 + (f * channels + c) * width, c === 0 ? 0.5 : -0.25);
    return bytes;
  };
  const stereo = decodeWav(make(1, 16, 2, (v, b, p, x) => v.setInt16(p, Math.round(x * 32767), true)));
  assert.equal(stereo.channels.length, 2);
  assert.ok(Math.abs(stereo.channels[0][2] - 0.5) < 0.001 && Math.abs(stereo.channels[1][2] + 0.25) < 0.001);
  const eight = decodeWav(make(1, 8, 1, (v, b, p, x) => { b[p] = Math.round(x * 127 + 128); }));
  assert.ok(Math.abs(eight.channels[0][0] - 0.5) < 0.01);
  const deep = decodeWav(make(1, 24, 1, (v, b, p, x) => { const n = Math.round(x * 8388607); b[p] = n & 255; b[p + 1] = (n >> 8) & 255; b[p + 2] = (n >> 16) & 255; }));
  assert.ok(Math.abs(deep.channels[0][3] - 0.5) < 1e-5);
  const float = decodeWav(make(3, 32, 1, (v, b, p, x) => v.setFloat32(p, x, true)));
  assert.equal(float.channels[0][1], 0.5);
});

test("anything that is not a WAV file is refused with null", () => {
  assert.equal(decodeWav(new Uint8Array(10)), null);
  assert.equal(decodeWav(new TextEncoder().encode("ID3 this is an mp3, honestly")), null);
});

test("peaks summarise loudness 25 times a second as 0..255", () => {
  const rate = 8000;
  const x = new Float32Array(rate * 2);
  for (let i = rate; i < x.length; i++) x[i] = Math.sin(i) * 0.25;
  const p = peaksOf(x, rate);
  assert.equal(p.length, PEAKS_PER_SECOND * 2);
  assert.equal(p[0], 0);
  assert.ok(p[30] > 100 && p[30] < 140, "quiet singing still shows: " + p[30]);
});

test("peaks collected live in pieces equal peaks of the whole", () => {
  const r = rng(5);
  const x = Float32Array.from({ length: 44100 }, () => r() * 2 - 1);
  const whole = peaksOf(x, 44100);
  const live = new PeakCollector(44100);
  for (let i = 0; i < x.length; i += 999) live.push(x.subarray(i, i + 999));
  assert.deepEqual(Array.from(live.finish()), Array.from(whole));
});

test("base64 round-trips bytes of every length", () => {
  for (let n = 0; n < 8; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 255);
    const text = toBase64(bytes);
    assert.equal(text, Buffer.from(bytes).toString("base64"));
    assert.deepEqual(Array.from(fromBase64(text)), Array.from(bytes));
  }
});
