// GIF로 저장 (the owner, 20 November: "영상·GIF로 저장"): a flipbook as an animated GIF, the one moving
// picture every chat app shows on its own and plays over and over. Written for this app without any
// library. The byte layout and the LZW packing follow the GIF89a specification and gifenc (MIT, Matt
// DesLauriers), whose writer comes from Kevin Weiner's encoder and the old `compress` program;
// writing only the part of a frame that changed is the idea of gifsicle's frame optimisation. The
// colours are brought to 256 with a median cut (Heckbert 1982) that splits the box whose colours are
// furthest apart, where they part best, written anew: gifenc's own quantiser comes from a GPL line,
// so only the idea of counting colours in coarse boxes was taken.
//
// One colour table serves every frame (a colour never flickers between frames) and there is no
// dithering (drawings are mostly flat colours, and dither dots would boil from frame to frame).

const BINS = 1 << 15; // 32 × 32 × 32 boxes of colour
const keyOf = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
/** On see-through paper a pixel at least this opaque is drawn; anything fainter stays clear. */
const SOLID = 128;

/**
 * GIF delays (hundredths of a second) for frames held `holds` ticks each at `fps`: rounded where the
 * time has got to, so the whole keeps its pace (12 a second: 8, 9, 8, … and 100 in a second). Never
 * under 2: browsers slow anything shorter down to a tenth of a second.
 */
export function gifDelays(holds, fps) {
  const out = [];
  let ticks = 0;
  let said = 0;
  for (const n of holds) {
    ticks += n;
    const d = Math.max(2, Math.round((ticks * 100) / fps) - said);
    out.push(d);
    said += d;
  }
  return out;
}

/** The colours of every frame, counted in coarse boxes (each keeps the sum of its true colours). */
export class ColourCount {
  constructor() {
    this.n = new Float64Array(BINS);
    this.r = new Float64Array(BINS);
    this.g = new Float64Array(BINS);
    this.b = new Float64Array(BINS);
  }

  /** One frame's RGBA pixels; clear: only what is drawn (see-through paper). */
  add(rgba, clear = false) {
    const { n, r, g, b } = this;
    for (let i = 0; i < rgba.length; i += 4) {
      if (clear && rgba[i + 3] < SOLID) continue;
      const k = keyOf(rgba[i], rgba[i + 1], rgba[i + 2]);
      n[k]++;
      r[k] += rgba[i];
      g[k] += rgba[i + 1];
      b[k] += rgba[i + 2];
    }
  }

  /** At most `max` colours ([r, g, b]) standing for everything counted. */
  palette(max = 256) {
    const bins = [];
    for (let k = 0; k < BINS; k++) {
      const c = this.n[k];
      if (c) bins.push({ n: c, c: [this.r[k] / c, this.g[k] / c, this.b[k] / c] });
    }
    if (!bins.length) return [];
    let boxes = [boxOf(bins)];
    while (boxes.length < max) {
      let at = -1;
      for (let i = 0; i < boxes.length; i++) if (boxes[i].bins.length > 1 && (at < 0 || boxes[i].err > boxes[at].err)) at = i;
      if (at < 0 || boxes[at].err <= 0) break;
      const [a, b] = split(boxes[at]);
      boxes.splice(at, 1, a, b);
    }
    return boxes.map((box) => box.mean.map((v) => Math.min(255, Math.max(0, Math.round(v)))));
  }
}

/** A box of bins: its pixel count, mean colour and squared error (how far apart its colours are). */
function boxOf(bins) {
  let n = 0;
  const s = [0, 0, 0];
  const q = [0, 0, 0];
  for (const bin of bins) {
    n += bin.n;
    for (let ch = 0; ch < 3; ch++) {
      s[ch] += bin.n * bin.c[ch];
      q[ch] += bin.n * bin.c[ch] * bin.c[ch];
    }
  }
  let err = 0;
  for (let ch = 0; ch < 3; ch++) err += q[ch] - (s[ch] * s[ch]) / n;
  return { bins, n, mean: s.map((v) => v / n), err };
}

/** The box cut in two along the channel and at the place that leaves the least error on both sides. */
function split(box) {
  let best = null;
  for (let ch = 0; ch < 3; ch++) {
    const sorted = box.bins.slice().sort((x, y) => x.c[ch] - y.c[ch]);
    // Running totals from the left, so each place's two errors come in one step.
    const total = boxSums(sorted);
    const left = { n: 0, s: [0, 0, 0], q: [0, 0, 0] };
    for (let i = 0; i < sorted.length - 1; i++) {
      const bin = sorted[i];
      left.n += bin.n;
      for (let c = 0; c < 3; c++) {
        left.s[c] += bin.n * bin.c[c];
        left.q[c] += bin.n * bin.c[c] * bin.c[c];
      }
      if (sorted[i + 1].c[ch] === bin.c[ch]) continue; // cut only between different colours
      const rn = total.n - left.n;
      let err = 0;
      for (let c = 0; c < 3; c++) {
        err += left.q[c] - (left.s[c] * left.s[c]) / left.n;
        const rs = total.s[c] - left.s[c];
        err += total.q[c] - left.q[c] - (rs * rs) / rn;
      }
      if (!best || err < best.err) best = { err, sorted, at: i + 1 };
    }
  }
  if (!best) {
    // Every bin the same along all three channels cannot happen (bins differ), but stay safe.
    const half = box.bins.length >> 1;
    return [boxOf(box.bins.slice(0, half)), boxOf(box.bins.slice(half))];
  }
  return [boxOf(best.sorted.slice(0, best.at)), boxOf(best.sorted.slice(best.at))];
}

function boxSums(bins) {
  const t = { n: 0, s: [0, 0, 0], q: [0, 0, 0] };
  for (const bin of bins) {
    t.n += bin.n;
    for (let c = 0; c < 3; c++) {
      t.s[c] += bin.n * bin.c[c];
      t.q[c] += bin.n * bin.c[c] * bin.c[c];
    }
  }
  return t;
}

/** A byte buffer that grows as it is written. */
class Bytes {
  constructor(size = 1 << 16) {
    this.buf = new Uint8Array(size);
    this.length = 0;
  }
  room(n) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  byte(v) {
    this.room(1);
    this.buf[this.length++] = v & 255;
  }
  u16(v) {
    this.byte(v);
    this.byte(v >> 8);
  }
  text(s) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  bytes(arr, n = arr.length) {
    this.room(n);
    this.buf.set(arr.subarray(0, n), this.length);
    this.length += n;
  }
  done() {
    return this.buf.slice(0, this.length);
  }
}

/**
 * Writes an animated GIF frame by frame (so a long flipbook never sits in memory whole): the colour
 * table first (from a ColourCount of every frame), then each frame as it is painted.
 */
export class GifWriter {
  /** palette: up to 256 colours (255 on see-through paper); loop: play for ever, else once. */
  constructor({ width, height, palette, loop = true, clear = false }) {
    this.w = width;
    this.h = height;
    this.clear = clear;
    const colours = palette.slice(0, clear ? 255 : 256);
    if (!colours.length && !clear) colours.push([255, 255, 255]);
    this.colours = colours;
    this.see = clear ? colours.length : -1; // the see-through index
    const count = colours.length + (clear ? 1 : 0);
    this.bits = Math.max(1, Math.ceil(Math.log2(count)));
    this.lookup = new Int16Array(BINS).fill(-1);
    this.table = new Int32Array(1 << 20); // (prefix << 8 | index) → code, for the current generation
    this.gen = 0;
    this.screen = null; // what a viewer shows now (palette indices), on solid paper
    this.pending = null; // the last frame, kept until the next one differs (then its time is known)
    const out = (this.out = new Bytes());
    out.text("GIF89a");
    out.u16(width);
    out.u16(height);
    out.byte(0x80 | ((this.bits - 1) << 4) | (this.bits - 1)); // a global table of 2^bits colours
    out.byte(0); // background
    out.byte(0); // square pixels
    for (let i = 0; i < 1 << this.bits; i++) {
      const c = colours[i] || [0, 0, 0];
      out.byte(c[0]);
      out.byte(c[1]);
      out.byte(c[2]);
    }
    if (loop) {
      out.byte(0x21);
      out.byte(0xff);
      out.byte(11);
      out.text("NETSCAPE2.0");
      out.byte(3);
      out.byte(1);
      out.u16(0); // for ever
      out.byte(0);
    }
  }

  /** Palette indices for a frame's RGBA pixels: the nearest colour, looked up once per box of colour. */
  indicesOf(rgba) {
    const n = this.w * this.h;
    const out = new Uint8Array(n);
    const { lookup, colours, see } = this;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      if (see >= 0 && rgba[p + 3] < SOLID) {
        out[i] = see;
        continue;
      }
      const k = keyOf(rgba[p], rgba[p + 1], rgba[p + 2]);
      let at = lookup[k];
      if (at < 0) at = lookup[k] = nearest(colours, rgba[p], rgba[p + 1], rgba[p + 2]);
      out[i] = at;
    }
    return out;
  }

  /** The next frame (RGBA, width × height) shown for `delay` hundredths of a second. */
  frame(rgba, delay) {
    const idx = this.indicesOf(rgba);
    if (this.pending && same(idx, this.pending.idx)) {
      this.pending.delay += delay;
      return;
    }
    this.flush();
    this.pending = { idx, delay };
  }

  flush() {
    if (!this.pending) return;
    const { idx, delay } = this.pending;
    this.pending = null;
    const { w, h, out } = this;
    // The part to write: on solid paper what differs from the screen (the rest stays, disposal 1);
    // on see-through paper what is drawn (the frame is cleared after it is shown, disposal 2).
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const v = idx[row + x];
        const keep = this.clear ? v === this.see : this.screen !== null && this.screen[row + x] === v;
        if (keep) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
    if (x1 < 0) {
      x0 = y0 = x1 = y1 = 0; // nothing drawn at all: one clear pixel
    }
    const rw = x1 - x0 + 1;
    const rh = y1 - y0 + 1;
    out.byte(0x21);
    out.byte(0xf9);
    out.byte(4);
    out.byte(((this.clear ? 2 : 1) << 2) | (this.clear ? 1 : 0));
    out.u16(delay);
    out.byte(this.clear ? this.see : 0);
    out.byte(0);
    out.byte(0x2c);
    out.u16(x0);
    out.u16(y0);
    out.u16(rw);
    out.u16(rh);
    out.byte(0); // the global table, not interlaced
    const part = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) part.set(idx.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + rw), y * rw);
    this.lzw(part);
    if (!this.clear) this.screen = idx;
  }

  /**
   * The indices as GIF LZW codes in sub-blocks of at most 255 bytes: codes grow from one bit more than
   * the colours need to 12 bits, and when 4096 codes are used the table starts again with a clear code.
   */
  lzw(indices) {
    const out = this.out;
    const min = Math.max(2, this.bits);
    const clear = 1 << min;
    const end = clear + 1;
    const table = this.table;
    let size = min + 1;
    let next = end + 1;
    let base = ++this.gen << 12; // entries of an older generation read as empty
    let acc = 0;
    let have = 0;
    const block = new Uint8Array(255);
    let fill = 0;
    const put = (code) => {
      acc |= code << have;
      have += size;
      while (have >= 8) {
        block[fill++] = acc & 255;
        acc >>>= 8;
        have -= 8;
        if (fill === 255) {
          out.byte(255);
          out.bytes(block, 255);
          fill = 0;
        }
      }
    };
    out.byte(min);
    put(clear);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const c = indices[i];
      const key = (prefix << 8) | c;
      const v = table[key];
      if (v >= base) {
        prefix = v - base;
        continue;
      }
      put(prefix);
      if (next >= 1 << size && size < 12) size++;
      if (next < 4096) {
        table[key] = base + next++;
      } else {
        put(clear);
        base = ++this.gen << 12;
        next = end + 1;
        size = min + 1;
      }
      prefix = c;
    }
    put(prefix);
    if (next >= 1 << size && size < 12) size++;
    put(end);
    if (have > 0) {
      block[fill++] = acc & 255;
      if (fill === 255) {
        out.byte(255);
        out.bytes(block, 255);
        fill = 0;
      }
    }
    if (fill) {
      out.byte(fill);
      out.bytes(block, fill);
    }
    out.byte(0);
  }

  /** The whole file. */
  finish() {
    this.flush();
    this.out.byte(0x3b);
    return this.out.done();
  }
}

/** The palette colour nearest a pixel's own colour (the first one met in its box stands for the box). */
function nearest(colours, r, g, b) {
  let at = 0;
  let best = Infinity;
  for (let i = 0; i < colours.length; i++) {
    const c = colours[i];
    const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
    if (d < best) {
      best = d;
      at = i;
    }
  }
  return at;
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A whole GIF from frames in memory ({ rgba, delay }): for short ones and for tests. */
export function gifBytes({ width, height, frames, loop = true, clear = false }) {
  const count = new ColourCount();
  for (const f of frames) count.add(f.rgba, clear);
  const writer = new GifWriter({ width, height, palette: count.palette(clear ? 255 : 256), loop, clear });
  for (const f of frames) writer.frame(f.rgba, f.delay);
  return writer.finish();
}
