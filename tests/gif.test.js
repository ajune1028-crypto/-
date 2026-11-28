// GIF로 저장 (the owner, 20 November: "영상·GIF로 저장"): a flipbook as an animated GIF, written without any
// library (core/gif.js). Read back here with a small GIF reader, as a browser or a chat app would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gifBytes, gifDelays } from "../src/core/gif.js";

/** A minimal GIF reader: the screen size, loop block, and each frame's delay and pixels (as palette colours). */
function readGif(bytes) {
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => { const v = bytes[p] | (bytes[p + 1] << 8); p += 2; return v; };
  const head = String.fromCharCode(...bytes.slice(0, 6));
  p = 6;
  const width = u16();
  const height = u16();
  const flags = u8();
  u8(); // background
  u8(); // aspect
  let global = null;
  if (flags & 0x80) {
    const n = 2 << (flags & 7);
    global = [];
    for (let i = 0; i < n; i++) global.push([u8(), u8(), u8()]);
  }
  const frames = [];
  let loops = null;
  let gce = null;
  for (;;) {
    const b = u8();
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        u8();
        const f = u8();
        const delay = u16();
        const tIndex = u8();
        u8();
        gce = { delay, transparent: f & 1 ? tIndex : null, dispose: (f >> 2) & 7 };
      } else if (label === 0xff) {
        const len = u8();
        const id = String.fromCharCode(...bytes.slice(p, p + len));
        p += len;
        for (let n = u8(); n; n = u8()) {
          if (id.startsWith("NETSCAPE") && n === 3) { u8(); loops = u16(); } else p += n;
        }
      } else {
        for (let n = u8(); n; n = u8()) p += n;
      }
    } else if (b === 0x2c) {
      const x = u16(), y = u16(), w = u16(), hgt = u16();
      const f = u8();
      let table = global;
      if (f & 0x80) {
        const n = 2 << (f & 7);
        table = [];
        for (let i = 0; i < n; i++) table.push([u8(), u8(), u8()]);
      }
      const min = u8();
      const data = [];
      for (let n = u8(); n; n = u8()) { data.push(...bytes.slice(p, p + n)); p += n; }
      const indices = lzwDecode(data, min, w * hgt);
      frames.push({ x, y, w, h: hgt, delay: gce?.delay ?? 0, transparent: gce?.transparent ?? null, dispose: gce?.dispose ?? 0, indices, table });
      gce = null;
    } else throw new Error("bad block " + b + " at " + (p - 1));
  }
  return { head, width, height, loops, frames };
}

/** Each frame as a viewer shows it: drawn over what the one before left (by its disposal); null = see-through. */
function shown(gif) {
  let screen = new Array(gif.width * gif.height).fill(null);
  return gif.frames.map((f) => {
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const i = f.indices[y * f.w + x];
        if (i !== f.transparent) screen[(f.y + y) * gif.width + f.x + x] = f.table[i];
      }
    }
    const seen = screen.slice();
    if (f.dispose === 2) for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) screen[(f.y + y) * gif.width + f.x + x] = null;
    return seen;
  });
}

function lzwDecode(data, min, count) {
  const clear = 1 << min;
  const eoi = clear + 1;
  let size = min + 1;
  let dict = [];
  const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = null; size = min + 1; };
  reset();
  const out = [];
  let bit = 0;
  let prev = null;
  const read = () => {
    let v = 0;
    for (let i = 0; i < size; i++, bit++) if (data[bit >> 3] & (1 << (bit & 7))) v |= 1 << i;
    return v;
  };
  while (out.length < count && bit < data.length * 8) {
    const code = read();
    if (code === clear) { reset(); prev = null; continue; }
    if (code === eoi) break;
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error("bad code");
    out.push(...entry);
    if (prev) dict.push([...prev, entry[0]]);
    prev = entry;
    if (dict.length === 1 << size && size < 12) size++;
  }
  return out;
}

const W = 6;
const H = 4;
/** A frame of one colour with a dot of another at (x, y). */
function frame(bg, dot, x, y) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) rgba.set([...bg, 255], i * 4);
  rgba.set([...dot, 255], (y * W + x) * 4);
  return rgba;
}

test("frames come back as they were drawn, with their delays, looping for ever", () => {
  const white = [255, 255, 255];
  const red = [220, 40, 40];
  const blue = [30, 80, 220];
  const bytes = gifBytes({ width: W, height: H, frames: [{ rgba: frame(white, red, 1, 1), delay: 8 }, { rgba: frame(white, blue, 4, 2), delay: 17 }], loop: true });
  const gif = readGif(bytes);
  assert.equal(gif.head, "GIF89a");
  assert.deepEqual([gif.width, gif.height], [W, H]);
  assert.equal(gif.loops, 0, "for ever");
  assert.equal(gif.frames.length, 2);
  assert.deepEqual(gif.frames.map((f) => f.delay), [8, 17]);
  const [one, two] = shown(gif);
  assert.deepEqual(one[1 * W + 1], red);
  assert.deepEqual(one[0], white);
  assert.deepEqual(two[2 * W + 4], blue);
  assert.deepEqual(two[1 * W + 1], white, "the red dot is gone");
  assert.equal(bytes[bytes.length - 1], 0x3b, "ends as a GIF ends");
});

test("a frame writes only the part that changed; one just like the last adds its time to it", () => {
  const white = [255, 255, 255];
  const red = [220, 40, 40];
  const a = frame(white, red, 1, 1);
  const b = frame(white, red, 1, 1);
  b.set([30, 80, 220, 255], (3 * W + 5) * 4); // one more dot
  const gif = readGif(gifBytes({ width: W, height: H, frames: [{ rgba: a, delay: 10 }, { rgba: a.slice(), delay: 5 }, { rgba: b, delay: 7 }], loop: true }));
  assert.equal(gif.frames.length, 2, "the same picture again is one frame held longer");
  assert.deepEqual(gif.frames.map((f) => f.delay), [15, 7]);
  const second = gif.frames[1];
  assert.deepEqual([second.x, second.y, second.w, second.h], [5, 3, 1, 1], "only the new dot");
  const last = shown(gif)[1];
  assert.deepEqual(last[1 * W + 1], red, "what did not change stays");
  assert.deepEqual(last[3 * W + 5], [30, 80, 220]);
});

test("played once, there is no loop block; on clear paper what is not drawn stays see-through, frame after frame", () => {
  const one = new Uint8ClampedArray(W * H * 4); // all clear
  one.set([10, 20, 30, 255], (1 * W + 1) * 4);
  const two = new Uint8ClampedArray(W * H * 4);
  two.set([10, 20, 30, 200], (2 * W + 4) * 4); // mostly opaque counts as drawn
  two.set([90, 90, 90, 40], (0 * W + 0) * 4); // a faint edge stays clear
  const gif = readGif(gifBytes({ width: W, height: H, frames: [{ rgba: one, delay: 10 }, { rgba: two, delay: 10 }], loop: false, clear: true }));
  assert.equal(gif.loops, null, "once");
  assert.ok(gif.frames.every((f) => f.transparent !== null));
  const [first, second] = shown(gif);
  assert.deepEqual(first[1 * W + 1], [10, 20, 30]);
  assert.equal(first[0], null);
  assert.equal(second[1 * W + 1], null, "the line of the frame before does not stay");
  assert.deepEqual(second[2 * W + 4], [10, 20, 30]);
  assert.equal(second[0], null);
});

test("an empty clear page is still a picture (one see-through pixel)", () => {
  const gif = readGif(gifBytes({ width: W, height: H, frames: [{ rgba: new Uint8ClampedArray(W * H * 4), delay: 10 }], loop: true, clear: true }));
  assert.equal(gif.frames.length, 1);
  assert.ok(shown(gif)[0].every((c) => c === null));
});

test("many colours (an airbrush's soft edge) are brought to at most 256, each close to what was drawn", () => {
  const big = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) big.set([(i * 7) & 255, (i * 13) & 255, (i * 29) & 255, 255], i * 4);
  const gif = readGif(gifBytes({ width: 64, height: 64, frames: [{ rgba: big, delay: 5 }], loop: true }));
  const f = gif.frames[0];
  assert.ok(f.table.length <= 256);
  const seen = shown(gif)[0];
  let worst = 0;
  for (let i = 0; i < 64 * 64; i++) {
    const c = seen[i];
    worst = Math.max(worst, Math.hypot(c[0] - big[i * 4], c[1] - big[i * 4 + 1], c[2] - big[i * 4 + 2]));
  }
  assert.ok(worst < 90, "close enough: " + worst);
});

test("up to 256 colours come back exactly, however mixed (the codes pass 4096 and start again)", () => {
  const w = 220;
  const hgt = 160;
  const noisy = new Uint8ClampedArray(w * hgt * 4);
  const colour = (k) => [k, (k * 89) & 255, 255 - k];
  let seed = 7;
  for (let i = 0; i < w * hgt; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noisy.set([...colour(seed % 256), 255], i * 4);
  }
  const gif = readGif(gifBytes({ width: w, height: hgt, frames: [{ rgba: noisy, delay: 10 }], loop: true }));
  const seen = shown(gif)[0];
  for (let i = 0; i < w * hgt; i++) assert.deepEqual(seen[i], [noisy[i * 4], noisy[i * 4 + 1], noisy[i * 4 + 2]], "pixel " + i);
});

test("a page of mostly one colour stays small", () => {
  const plain = new Uint8ClampedArray(300 * 200 * 4).fill(255);
  for (let i = 0; i < 300 * 200; i += 997) plain.set([0, 0, 0, 255], i * 4);
  const bytes = gifBytes({ width: 300, height: 200, frames: [{ rgba: plain, delay: 10 }], loop: true });
  assert.equal(readGif(bytes).frames[0].indices.length, 300 * 200);
  assert.ok(bytes.length < (300 * 200) / 8, "compressed: " + bytes.length);
});

test("frames a second become delays in hundredths that keep the right pace overall", () => {
  const d = gifDelays([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 12); // twelve frames at 12 a second
  assert.equal(d.reduce((a, b) => a + b, 0), 100, "one second in all");
  assert.ok(d.every((v) => v === 8 || v === 9));
  assert.deepEqual(gifDelays([3], 12), [25], "a frame held three times");
  assert.ok(gifDelays([1, 1, 1, 1], 24).every((v) => v >= 2), "never so short that a browser slows it down");
});
