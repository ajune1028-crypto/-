// How a written word (어절) is coloured.
//
// One writer: their colour. Two writers: top and bottom. Three or more: a
// pinwheel. A double tap lets the neighbours' colours seep in, then mixes
// everything into one colour like paint.

import { cmpId } from "./crdt.js";

/** Eight member colours as hue and chroma; lightness comes from the theme. */
export const PALETTE = [
  // Ordered so that the first people to join get colours far apart.
  { key: "coral", h: 25, c: 0.17 },
  { key: "blue", h: 255, c: 0.16 },
  { key: "green", h: 150, c: 0.14 },
  { key: "violet", h: 300, c: 0.17 },
  { key: "orange", h: 55, c: 0.15 },
  { key: "teal", h: 200, c: 0.12 },
  { key: "pink", h: 345, c: 0.17 },
  { key: "olive", h: 100, c: 0.13 },
];

// Must equal --ink and --paper in the stylesheet; a browser scenario checks that they agree.
export const INK = { light: "#1b2030", dark: "#f4f4f7" };
export const PAPER = { light: "#f8fafd", dark: "#0b0b0e" };

// Text lightness per theme, and the range a mixed colour may land in.
const TONE = { light: { l: 0.5, min: 0.4, max: 0.52 }, dark: { l: 0.8, min: 0.76, max: 0.88 } };
// Measured on plain paper. The writing sheet is frosted and lets a little of the
// colour field behind it through, so 4.5:1 on the sheet needs this margin here.
const MIN_CONTRAST = 4.75;

const cache = new Map();

/**
 * The people colour (an index into PALETTE) nearest in hue to a glass colour, among those not
 * taken (else the nearest of all): so my words and recordings come in "my colour". A grey
 * glass, or none, has no preference (null).
 */
export function nearestPeopleColor(hex, taken = new Set()) {
  if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const { c, h } = hexToOklch(hex.toLowerCase());
  if (c < 0.05) return null;
  const apart = (a) => { const d = Math.abs(a - h) % 360; return Math.min(d, 360 - d); };
  const order = PALETTE.map((p, i) => [i, apart(p.h)]).sort((p, q) => p[1] - q[1]).map(([i]) => i);
  return order.find((i) => !taken.has(i)) ?? order[0];
}

export function memberColor(index, theme) {
  const i = ((index % PALETTE.length) + PALETTE.length) % PALETTE.length;
  const key = theme + i;
  if (!cache.has(key)) cache.set(key, legible(TONE[theme].l, PALETTE[i].c, PALETTE[i].h, theme));
  return cache.get(key);
}

// ---- colour space ----------------------------------------------------------

const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

function rgbToHex(rgb) {
  return "#" + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
}

export function hexToOklch(hex) {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

function oklchToRgb(L, c, h) {
  const A = c * Math.cos((h * Math.PI) / 180);
  const B = c * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/** Hex for an OKLCH colour; chroma is reduced until it fits sRGB so the hue holds. */
export function oklchToHex(l, c, h) {
  let rgb = oklchToRgb(l, c, h);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToRgb(l, mid, h))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToRgb(l, lo, h);
  }
  return rgbToHex(rgb.map(toGamma));
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours. */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The colour at this hue and chroma, nudged in lightness until it reads on the theme's paper. */
function legible(l, c, h, theme) {
  const step = theme === "light" ? -0.01 : 0.01;
  let hex = oklchToHex(l, c, h);
  for (let i = 0; i < 40 && contrast(hex, PAPER[theme]) < MIN_CONTRAST; i++) {
    l += step;
    hex = oklchToHex(l, c, h);
  }
  return hex;
}

/**
 * Mixes colours the way paint does: the hue travels the shorter way round the
 * wheel (red + blue → purple, blue + yellow → green) and loses some strength
 * when the colours were far apart.
 */
export function mixColors(hexes, theme) {
  const tone = TONE[theme];
  let acc = hexToOklch(hexes[0]);
  for (let i = 1; i < hexes.length; i++) {
    const next = hexToOklch(hexes[i]);
    const w = 1 / (i + 1);
    const grey = (x) => x.c < 0.02;
    let h;
    let arc = 0;
    if (grey(acc)) h = next.h;
    else if (grey(next)) h = acc.h;
    else {
      let d = next.h - acc.h;
      if (d > 180) d -= 360;
      if (d <= -180) d += 360;
      arc = Math.abs(d);
      h = (acc.h + d * w + 360) % 360;
    }
    const fade = 1 - 0.35 * (arc / 180) ** 2 * 4 * w * (1 - w);
    acc = { l: acc.l + (next.l - acc.l) * w, c: (acc.c + (next.c - acc.c) * w) * fade, h };
  }
  return legible(Math.min(tone.max, Math.max(tone.min, acc.l)), acc.c, acc.h, theme);
}

// ---- words -----------------------------------------------------------------

/**
 * Splits visible chars into words. A word knows who wrote it: `authors` in the
 * order they first wrote (by char id), `top` the one who wrote the most.
 */
export function splitWords(chars) {
  const words = [];
  let line = 0;
  let start = -1;
  const close = (end) => {
    if (start < 0) return;
    const first = new Map();
    const count = new Map();
    for (let i = start; i < end; i++) {
      const { by, id } = chars[i];
      if (!first.has(by) || cmpId(id, first.get(by)) < 0) first.set(by, id);
      count.set(by, (count.get(by) || 0) + 1);
    }
    const authors = [...first.keys()].sort((a, b) => cmpId(first.get(a), first.get(b)));
    let top = authors[0];
    for (const by of authors) if (count.get(by) > count.get(top)) top = by;
    words.push({ start, end, line, anchor: chars[start].id, authors, top });
    start = -1;
  };
  for (let i = 0; i < chars.length; i++) {
    const v = chars[i].v;
    if (/\s/.test(v)) {
      close(i);
      if (v === "\n") line++;
    } else if (start < 0) start = i;
  }
  close(chars.length);
  return words;
}

/**
 * The paint for one word. `left` and `right` are its neighbours on the same
 * line (or null). `o.level` is the word's mix level.
 */
export function paintFor(word, left, right, o) {
  if (!o.colors) return { k: "ink" };
  if (!o.mixing) return { k: "solid", c: o.color(word.top) };
  const cs = word.authors.map(o.color);
  let base;
  if (cs.length === 1) base = { k: "solid", c: cs[0] };
  else if (cs.length === 2) base = { k: "split", top: cs[0], bottom: cs[1] };
  else base = { k: "wheel", cs };
  if (!o.level) return base;

  const l = left ? o.color(left.authors[0]) : null;
  const r = right ? o.color(right.authors[0]) : null;
  if (o.level === 1) return l || r ? { k: "seep", base, l, r } : base;
  const all = [...new Set([...cs, l, r].filter(Boolean))];
  return { k: "solid", c: all.length > 1 ? mixColors(all, o.theme) : all[0] };
}

const SPLIT_SOFT = 8; // percent of the height over which top blends into bottom
const SEEP_REACH = 46; // percent of the width a neighbour's colour reaches

function background(paint, aspect) {
  if (paint.k === "solid") return `linear-gradient(${paint.c}, ${paint.c})`;
  if (paint.k === "split") {
    const a = 50 - SPLIT_SOFT;
    const b = 50 + SPLIT_SOFT;
    return `linear-gradient(to bottom, ${paint.top} 0%, ${paint.top} ${a}%, ${paint.bottom} ${b}%, ${paint.bottom} 100%)`;
  }
  // Wheel: equal sectors, the first writer centred at 12 o'clock, clockwise.
  // Each colour holds for half its sector and blends into the next.
  // A word is wider than it is tall, and equal angles would leave the top and
  // bottom colours a sliver. The angles are stretched by the word's shape, so
  // that the areas stay as fair as they are on a square.
  const sector = 360 / paint.cs.length;
  const hold = sector / 4;
  const at = (angle) => round(stretch(angle, aspect));
  const stops = [`${paint.cs[0]} 0deg`, `${paint.cs[0]} ${at(hold)}deg`];
  for (let i = 1; i < paint.cs.length; i++) stops.push(`${paint.cs[i]} ${at(i * sector - hold)}deg`, `${paint.cs[i]} ${at(i * sector + hold)}deg`);
  stops.push(`${paint.cs[0]} ${at(360 - hold)}deg`, `${paint.cs[0]} 360deg`);
  return `conic-gradient(from var(--spin, 0deg) at 50% 50%, ${stops.join(", ")})`;
}

/** The angle (clockwise from 12 o'clock) that a square's angle becomes on a box `aspect` times as wide as tall. */
function stretch(angle, aspect) {
  if (aspect === 1 || angle % 90 === 0) return angle;
  const rad = (angle * Math.PI) / 180;
  const out = (Math.atan2(aspect * Math.sin(rad), Math.cos(rad)) * 180) / Math.PI;
  return out < 0 ? out + 360 : out;
}

const round = (n) => Math.round(n * 100) / 100;

/**
 * CSS for a paint: `color` for flat colours, `background` (clipped to the text)
 * for the rest. `aspect` is the word's width divided by its height.
 */
export function paintCss(paint, aspect = 1) {
  if (paint.k === "ink") return {};
  if (paint.k === "solid") return { color: paint.c };
  if (paint.k !== "seep") return { background: background(paint, aspect) };
  const layers = [];
  if (paint.l) layers.push(`linear-gradient(to right, ${paint.l} 0%, ${paint.l}00 ${SEEP_REACH}%)`);
  if (paint.r) layers.push(`linear-gradient(to left, ${paint.r} 0%, ${paint.r}00 ${SEEP_REACH}%)`);
  layers.push(background(paint.base, aspect));
  return { background: layers.join(", ") };
}

/**
 * The colours one chosen accent brings: lighter and darker ends for gradients,
 * a second hue to blend into, a version for icons and small text that shows
 * on both papers (nudged only when it would not), and the text colour that
 * reads on the accent itself. The same in light and dark.
 */
export function accentColors(hex) {
  const { l, c, h } = hexToOklch(hex);
  const top = oklchToHex(Math.min(0.92, l + 0.05), c, h);
  const bottom = oklchToHex(Math.max(0.2, l - 0.04), c, h);
  const second = oklchToHex(l, c, (h + 38) % 360);
  let ink = hex;
  for (let i = 0, L = l; i < 40 && (contrast(ink, PAPER.light) < 3 || contrast(ink, PAPER.dark) < 3); i++) {
    L += L > 0.6 ? -0.015 : 0.015;
    ink = oklchToHex(L, c, h);
  }
  const white = contrast("#ffffff", hex);
  const onAccent = white >= 4.5 || white >= contrast("#111216", hex) ? "#ffffff" : "#111216";
  return { "--accent": hex, "--accent-top": top, "--accent-bottom": bottom, "--accent-2": second, "--accent-ink": ink, "--ring": ink, "--on-accent": onAccent };
}

/**
 * 모래 필름 (the owner, 17 November: "색 모래 노이즈 필름으로 바꿔줘. 모든 UI. 아날로그 느낌 나면서 …
 * 일기장 그런 느낌"): a small tile of sand over the glass — grains in my colour, fewer in its
 * neighbour, and pale sand (bright sand on dark). Three noises, each kept only where it is strong,
 * so the grains are sparse and fine, as on film.
 */
export function filmImage(tint, second, dark = false, strength = 1) {
  const ok = (hex) => /^#[0-9a-f]{6}$/i.test(hex || "");
  const rgb = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3));
  const [r1, g1, b1] = rgb(ok(tint) ? tint : "#8c919c");
  const [r2, g2, b2] = rgb(ok(second) ? second : ok(tint) ? tint : "#8c919c");
  const sand = dark ? ["1", "1", "1"] : ["0.106", "0.125", "0.188"];
  // Soft grains (a gentle slope above the cut), drawn at twice the detail and shown at half size,
  // so on a phone they are as fine as film grain, not specks.
  const layer = (seed, freq, [r, g, b], cut, opacity) =>
    `<filter id='f${seed}' x='0' y='0' width='100%' height='100%' color-interpolation-filters='sRGB'>` +
    `<feTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='2' seed='${seed}' stitchTiles='stitch'/>` +
    `<feColorMatrix values='0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} 4 0 0 0 ${(-4 * cut).toFixed(2)}'/></filter>` +
    `<rect width='100%' height='100%' filter='url(%23f${seed})' opacity='${opacity}'/>`;
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 160 160'>" +
    layer(3, 0.85, [r1, g1, b1], 0.52, ((dark ? 0.3 : 0.22) * strength).toFixed(3)) +
    layer(11, 0.95, [r2, g2, b2], 0.56, ((dark ? 0.2 : 0.14) * strength).toFixed(3)) +
    layer(7, 0.75, sand, 0.55, ((dark ? 0.12 : 0.1) * strength).toFixed(3)) +
    "</svg>";
  return `url("data:image/svg+xml;utf8,${svg}")`;
}
