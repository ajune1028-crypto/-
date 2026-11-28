// A drawing layer over any surface: a canvas that shows an InkDoc's strokes
// and, while a tool is on, turns the finger or pen into strokes.
//
// Off, it lets every touch through to what is underneath (the text).
// Brushes (the shapes they paint come from core/brush.js, the same on every screen): 펜 (swells
// and thins with the pen's pressure, or a finger's speed), 만년필 (a slanted nib: wide across it,
// a hairline along it), 붓펜 (pointed ends, very soft), 연필 (grain), 마커 (even and bold),
// 에어브러시 (soft mist), 형광펜 (wide and see-through). Two erasers: 부분 지우개 rubs out only
// where it passes (it is a stroke of its own that clears what lies under it), 획 지우개 removes
// whole strokes. 모양 잡기: a line held still a moment becomes the shape it was meant to be.
// 채우기 fills the region a tap lands in; 문지르기 pulls the paint along under the finger.
// Used by the text room, the whiteboard, 그림 방 and 애니메이션 방.

import { h, icon, iconButton, closeOnOutside, mount, flashHint } from "./dom.js";
import { getSettings, setSetting } from "../identity.js";
import { placePieces, railParts, railBand, RAIL_TOP, RAIL_FOOT } from "./ink-pieces.js";
import { INK_COLORS, thinPoints, brushOf, widthOf, opacityOf, WIDTH_PX, SIZE_MIN, SIZE_MAX, nearestWidth, strokesWithinLoop, copyStrokesOps, recolorStrokesOps, eraseOps, carryStrokes, landStrokesOps, BOARD_INK_UNIT } from "../core/ink.js";
import { closeLoop, insideLoop as loopHas } from "../core/board.js";
import { brushLook, strokePoints, outline, dabs, hasPressure, wobble, quickShape, adjustShape, LazyBrush, sketchLines, crayonMarks, chalkAlpha, chalkTurn, fingerFeel, fingerStep } from "../core/brush.js";
import { LIGHT_MS } from "./live-ink.js";
import { fillMask, maskRings, simplifyRing, ringsToPoints, pointsToRings } from "../core/fill.js";
import { currentTheme } from "./theme.js";
import { INK } from "../core/paint.js";
import { openColorWheel, closeColorWheel, colorWheelOpen } from "./color-wheel.js";

const COLORS = {
  red: "#e5484d", orange: "#f2802a", yellow: "#e8b422", green: "#2f9e5b", blue: "#2f7bf0", indigo: "#4b4fd8", violet: "#9a4fd8",
};
/** The brushes in the tools, in this order. */
export const BRUSH_NAMES = [["pen", "펜"], ["fountain", "만년필"], ["brushpen", "붓펜"], ["pencil", "연필"], ["sketch", "스케치"], ["crayon", "크레용"], ["marker", "마커"], ["airbrush", "에어브러시"], ["highlighter", "형광펜"], ["fill", "채우기"], ["smudge", "문지르기"]];
/** 손떨림 보정's string, in screen pixels, for 끔 · 약 · 중 · 강. */
const STEADY_PX = [0, 6, 14, 26];
export const STEADY_NAMES = ["끔", "약", "중", "강"];
/** How long a line is held still before it becomes a shape. */
const SHAPE_HOLD_MS = 600;
/** 채우는 정도: how long a fill is held still before its amount shows, and how much a pixel slid changes it. */
const FILL_HOLD_MS = 450;
const TOL_PER_PX = 0.85; // 255 × 1% / 3 px
/** How alike a colour must be (0..255 a channel) to be filled: kept on this device (drawInkTools reads it). */
let fillTol = 48;
let keepTol = null;
const clampTol = (v) => Math.max(0, Math.min(255, Math.round(Number(v)))) || 0;
function setFillTol(v) {
  fillTol = clampTol(v);
  keepTol?.(fillTol);
}

export function inkColor(c, fixed = false) {
  if (c === "black") return fixed ? INK.light : INK[currentTheme()];
  return COLORS[c] || c;
}

/**
 * 그림 방 and 애니메이션 방 draw on a paper of their own colour, not the app's: their black is always
 * the same black (the owner, 21 November: "밝기 모드를 다르게 해도 펜의 색깔 안 바뀌게"). A stroke drawn
 * there keeps that very colour, so it stays so wherever it is taken.
 */
export function fixedInk(c) {
  return c === "black" ? INK.light : c;
}

const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

/** The colour of a canvas at a point of the screen as "#rrggbb", or null where it is see-through. */
export function pixelAt(canvas, x, y) {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height || x < r.left || y < r.top || x >= r.right || y >= r.bottom) return null;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  const px = Math.floor(((x - r.left) / r.width) * canvas.width);
  const py = Math.floor(((y - r.top) / r.height) * canvas.height);
  const [red, green, blue, alpha] = g.getImageData(px, py, 1, 1).data;
  if (alpha < 40) return null;
  // What shows is the colour over the paper: half see-through ink reads lighter, as it looks.
  const k = alpha / 255;
  const paper = currentTheme() === "dark" ? [24, 26, 30] : [255, 253, 248];
  const mixed = [red, green, blue].map((v, i) => Math.round(v * k + paper[i] * (1 - k)));
  return "#" + mixed.map((v) => v.toString(16).padStart(2, "0")).join("");
}

// A colored pencil's grain: the color in specks of uneven strength, tiled.
const grains = new Map();
function grainFor(g, color) {
  if (grains.has(color)) return g.createPattern(grains.get(color), "repeat");
  const tile = document.createElement("canvas");
  tile.width = tile.height = 48;
  const t = tile.getContext("2d");
  if (!t) return color;
  const img = t.createImageData(48, 48);
  t.fillStyle = color;
  t.fillRect(0, 0, 1, 1);
  const [r, gg, b] = t.getImageData(0, 0, 1, 1).data;
  let seed = 9;
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    img.data[i] = r;
    img.data[i + 1] = gg;
    img.data[i + 2] = b;
    img.data[i + 3] = 90 + ((seed >>> 24) % 166);
  }
  t.putImageData(img, 0, 0);
  grains.set(color, tile);
  return g.createPattern(tile, "repeat");
}

// 연필's tip: Klecks' chalk in the colour (core/brush.js chalkAlpha), made once per colour.
const tips = new Map();
let chalkMask = null;
function chalkFor(color) {
  if (tips.has(color)) return tips.get(color);
  const w = 128;
  const tip = document.createElement("canvas");
  tip.width = tip.height = w;
  const t = tip.getContext("2d");
  if (t) {
    if (!chalkMask) {
      chalkMask = document.createElement("canvas");
      chalkMask.width = chalkMask.height = w;
      const m = chalkMask.getContext("2d");
      const img = m.createImageData(w, w);
      const alpha = chalkAlpha(w);
      for (let i = 0; i < alpha.length; i++) img.data[i * 4 + 3] = alpha[i];
      m.putImageData(img, 0, 0);
    }
    t.fillStyle = color;
    t.fillRect(0, 0, w, w);
    t.globalCompositeOperation = "destination-in";
    t.drawImage(chalkMask, 0, 0);
  }
  tips.set(color, tip);
  return tip;
}

// An airbrush's mist: one soft round of the colour, drawn many times along the line.
const mists = new Map();
function mistFor(color) {
  if (mists.has(color)) return mists.get(color);
  const tile = document.createElement("canvas");
  tile.width = tile.height = 64;
  const t = tile.getContext("2d");
  if (t) {
    const grad = t.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, color);
    grad.addColorStop(0.35, color);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    t.globalAlpha = 1;
    t.fillStyle = grad;
    t.fillRect(0, 0, 64, 64);
    // The middle softer than solid: the colour fades out from a gentle core.
    t.globalCompositeOperation = "destination-in";
    const fade = t.createRadialGradient(32, 32, 0, 32, 32, 32);
    fade.addColorStop(0, "rgba(0,0,0,0.85)");
    fade.addColorStop(0.5, "rgba(0,0,0,0.45)");
    fade.addColorStop(1, "rgba(0,0,0,0)");
    t.fillStyle = fade;
    t.fillRect(0, 0, 64, 64);
  }
  mists.set(color, tile);
  return tile;
}

/** The outline as a smooth filled shape (curves through the middles of its edges). */
function fillOutline(g, poly) {
  const n = poly.length / 2;
  if (n < 3) return;
  g.beginPath();
  g.moveTo((poly[0] + poly[2]) / 2, (poly[1] + poly[3]) / 2);
  for (let i = 1; i <= n; i++) {
    const x = poly[(i % n) * 2];
    const y = poly[(i % n) * 2 + 1];
    const nx = poly[((i + 1) % n) * 2];
    const ny = poly[((i + 1) % n) * 2 + 1];
    g.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  g.closePath();
  g.fill();
}

/**
 * Paints one stroke: points [x, y, p, …] in stroke units on a context already set to them.
 * shaped: a shape made straight (followed exactly, no pressure).
 */
/** px: the line's width in px at 1 rem = 16 px (a stroke's widthOf). */
/** alpha: the stroke's own 불투명 (0.05 to 1), on top of what the brush itself lays down. */
/** inside: 알파 잠금 - only over what is already drawn there (source-atop). */
/**
 * Layers of lines (bottom first: { strokes, visible, opacity, mode, clip }) painted onto g the way
 * 그림 방 shows them: each layer on its own (알파 잠금's lines inside what is there), a 클리핑 layer only
 * where the layer under it has ink, then its 불투명 and 섞기. `at`: from page units to g's pixels
 * [a, b, c, d, e, f]; `colour`: how a stroke's colour is shown (fixed in 그림·애니메이션 방).
 */
export function paintLayers(g, layers, w, hgt, at, colour = fixedInk) {
  let below = null;
  for (const layer of layers) {
    const one = document.createElement("canvas");
    one.width = w;
    one.height = hgt;
    const lg = one.getContext("2d");
    if (!lg) continue;
    lg.setTransform(...at);
    for (const s of layer.strokes || []) paintStroke(lg, s.pts, colour(s.c), widthOf(s), brushOf(s), !!s.q, opacityOf(s), !!s.a);
    const base = below;
    below = layer.clip ? below : { canvas: one, visible: layer.visible !== false };
    if (layer.clip && base) {
      if (!base.visible) continue;
      lg.setTransform(1, 0, 0, 1, 0, 0);
      lg.globalCompositeOperation = "destination-in";
      lg.drawImage(base.canvas, 0, 0);
    }
    if (layer.visible === false) continue;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = layer.opacity ?? 1;
    g.globalCompositeOperation = layer.mode || "source-over";
    g.drawImage(one, 0, 0);
    g.restore();
  }
}

export function paintStroke(g, pts, color, px, brush, shaped = false, alpha = 1, inside = false) {
  if (!pts || pts.length < 3) return;
  const base = brushLook(brush);
  const look = alpha < 1 ? { ...base, alpha: base.alpha * alpha } : base;
  const size = (px || 4) * (100 / 16) * look.scale;
  const erase = brush === "erase";
  const ink = erase ? "#000" : inkColor(color);
  const real = hasPressure(pts);
  // A shape made exact keeps its corners; a fill is its region's rings.
  const points = strokePoints(pts, { streamline: shaped ? 0 : look.streamline, exact: shaped || look.kind === "fill" });
  g.save();
  g.globalCompositeOperation = erase ? "destination-out" : inside ? "source-atop" : "source-over";
  if (look.kind === "smudge") {
    smudgeAlong(g, points, size, look, real);
    g.restore();
    return;
  }
  if (look.kind === "fill") {
    // 채우기: the region's rings, filled even-odd (its holes stay open).
    g.globalAlpha = look.alpha;
    g.fillStyle = ink;
    g.beginPath();
    for (const ring of pointsToRings(pts)) {
      ring.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
    }
    g.fill("evenodd");
    g.restore();
    return;
  }
  if (look.kind === "sketch") {
    // 스케치: the line itself, fine and pencil-dark, then faint strokes joining its near points.
    const poly = outline(points, { size: size * 0.55, thinning: real ? 0.5 : 0, taperStart: 0, taperEnd: size * 1.5 });
    g.globalAlpha = look.alpha;
    g.fillStyle = ink;
    fillOutline(g, poly);
    const seg = sketchLines(points, { reach: size * 9, seed: (pts[0] * 31 + pts[1]) | 0 });
    if (seg.length) {
      g.globalAlpha = 0.22 * alpha;
      g.strokeStyle = ink;
      g.lineWidth = Math.max(size * 0.25, 2);
      g.lineCap = "round";
      g.beginPath();
      for (let i = 0; i < seg.length; i += 4) {
        g.moveTo(seg[i], seg[i + 1]);
        g.lineTo(seg[i + 2], seg[i + 3]);
      }
      g.stroke();
    }
    g.restore();
    return;
  }
  if (look.kind === "dabs") {
    const marks = dabs(points, { step: size * look.spacing });
    const seed = (pts[0] * 31 + pts[1]) | 0;
    if (look.chalk) {
      // 연필: Klecks' chalk tip stamped along the line, each turned by where it lies (so the grain
      // never repeats), harder pressure a bigger and stronger mark.
      const tip = chalkFor(ink);
      const base = g.getTransform();
      for (const m of marks) {
        const p = real ? m.p : 0.62;
        const r = (size / 2) * (0.5 + 0.5 * p);
        const turn = chalkTurn(m.x, m.y);
        const cos = Math.cos(turn);
        const sin = Math.sin(turn);
        g.setTransform(base.a * cos + base.c * sin, base.b * cos + base.d * sin, -base.a * sin + base.c * cos, -base.b * sin + base.d * cos, base.a * m.x + base.c * m.y + base.e, base.b * m.x + base.d * m.y + base.f);
        g.globalAlpha = look.alpha * (0.25 + 0.5 * p);
        g.drawImage(tip, -r, -r, r * 2, r * 2);
      }
      g.setTransform(base);
    } else if (look.crayon) {
      // 크레용: Easy-Brush's uneven marks pressed flat along the way the line goes, each one the
      // chalk tip (the paper's tooth shows through the wax).
      const tip = chalkFor(ink);
      const base = g.getTransform();
      for (const m of crayonMarks(marks, { size, seed, pressure: real })) {
        const cos = Math.cos(m.angle);
        const sin = Math.sin(m.angle);
        g.setTransform((base.a * cos + base.c * sin) * m.rx, (base.b * cos + base.d * sin) * m.rx, (-base.a * sin + base.c * cos) * m.ry, (-base.b * sin + base.d * cos) * m.ry, base.a * m.x + base.c * m.y + base.e, base.b * m.x + base.d * m.y + base.f);
        g.globalAlpha = look.alpha * m.alpha;
        g.drawImage(tip, -1, -1, 2, 2);
      }
      g.setTransform(base);
    } else if (look.soft) {
      const mist = mistFor(ink);
      for (const m of marks) {
        const p = real ? m.p : 0.6;
        const r = (size / 2) * (0.75 + 0.35 * p);
        g.globalAlpha = look.alpha * (0.45 + 0.55 * p);
        g.drawImage(mist, m.x - r, m.y - r, r * 2, r * 2);
      }
    } else {
      g.fillStyle = look.grain ? grainFor(g, ink) : ink;
      for (const m of marks) {
        const p = real ? m.p : 0.62;
        const r = (size / 2) * (0.55 + 0.45 * p);
        g.globalAlpha = look.alpha * (0.3 + 0.5 * p);
        g.beginPath();
        g.arc(m.x + wobble(m.i, seed) * r * 0.18, m.y + wobble(m.i + 7919, seed) * r * 0.18, r, 0, Math.PI * 2);
        g.fill();
      }
    }
  } else {
    const thinning = shaped ? 0 : real ? look.thinning : look.fingerThinning || 0;
    const poly = outline(points, {
      size,
      thinning,
      simulate: !real && !shaped && !!look.fingerThinning,
      taperStart: shaped ? 0 : (look.taperStart || 0) * size,
      taperEnd: shaped ? 0 : (look.taperEnd || 0) * size,
      nib: !!look.nib,
      flat: !!look.flat,
    });
    g.globalAlpha = look.alpha;
    g.fillStyle = ink;
    fillOutline(g, poly);
  }
  g.restore();
}

// The glass that floats over a drawing in every room: bars, tools, the frames' strip.
// 애니메이션 방's foot is one glass (#anim-dock) holding the frames and their buttons: it is the glass
// that opens, not the clear strip and bar inside it.
const XRAY_PARTS = ".bar, .toolbar:not(.anim-dock > *), .board-top, .board-modes, .board-rail, .ink-tools, .anim-dock, .anim-strip:not(.anim-dock > *)";
const XRAY_NEAR = 40; // px: how near the pen comes before the glass opens around it

export class InkLayer {
  /**
   * host     the element to draw over (gets position: relative)
   * ink      () => InkDoc
   * onStroke ({ pts, color, width, brush }) when a stroke is finished
   * onErase  (strokeId) when the stroke eraser touches a stroke
   */
  /** blocked(): true while two fingers zoom, so no new line starts then. */
  /**
   * room(): px of extra drawing room wanted below the paper's content (while the pen is on).
   * Drawings may go past the paper's sides (to the screen's edges) and below it: the paper
   * grows to hold them.
   */
  /**
   * view: a board's own frame instead of the host's (the whiteboard pans and zooms under a
   * screen-sized canvas): point(clientX, clientY) → [x, y] in stroke units, matrix() → the
   * canvas transform [a, b, c, d, e, f] from stroke units to CSS pixels of the host.
   */
  /** shapes(): whether a line held still becomes a shape (모양 잡기); onShape() when one does. */
  /**
   * grow: false keeps the host's size (a page of fixed size, as in 그림 방); maxPixels caps the
   * canvas (many layers zoomed in must not take all the memory).
   */
  /**
   * share: what friends draw and point at on this document, and where mine goes (ui/live-ink.js,
   * LiveInk.on); steady(): 손떨림 보정, 0 (끔) to 3 (강). onStroke returns the stroke op's id.
   */
  /**
   * onPick(color): the colour two fingers held still picked here (스포이트, watched by the room with
   * watchPick); pick(clientX, clientY) reads that colour ("#rrggbb" or null for bare paper), by
   * default from this layer's own picture.
   */
  /**
   * onLasso(info | null): what the 올가미 holds now ({ ids, loop, rect } in screen terms, or { moving }),
   * or nothing; onLassoMove(ids, dx, dy) → the moved strokes' new ids (the room keeps the move).
   */
  constructor({ host, ink, onStroke, onErase, blocked = () => false, room = () => 0, view = null, shapes = () => true, onShape = () => {}, grow = true, maxPixels = Infinity, share = null, steady = () => 0, onPick = null, pick = null, onLasso = null, onLassoMove = null, fixedInk = false, inside = () => false, clipTo = () => null, afterRender = null }) {
    this.fixedInk = fixedInk; // 그림 방, 애니메이션 방: black stays black in 어둡게
    // 그림 방's layers: 알파 잠금 (new strokes only over what the layer has), 클리핑 (shown only where
    // the canvas clipTo() gives has ink), and a word after each drawing (a clipping layer above redraws).
    this.inside = inside;
    this.clipTo = clipTo;
    this.afterRender = afterRender;
    this.host = host;
    this.onLasso = onLasso;
    this.onLassoMove = onLassoMove;
    this.selection = null; // the 올가미's: { ids: Set, loop: [x, y, …] } in stroke units
    this.onPick = onPick;
    this.pickAt = pick;
    this.share = share;
    this.steady = steady;
    this.light = null; // my pointer's light (가리키기)
    this.shapes = shapes;
    this.onShape = onShape;
    this.growing = grow;
    this.maxPixels = maxPixels;
    this.view = view;
    this.blocked = blocked;
    this.room = room;
    this.ink = ink;
    this.onStroke = onStroke;
    this.onErase = onErase;
    this.tool = null; // null, "pen", "eraser" (부분) or "eraser-stroke" (획)
    this.color = "black";
    this.width = 2;
    this.size = null;
    this.brush = "pen";
    this.opacity = 1; // 불투명, Procreate's second slider
    this.live = null;
    this.canvas = h("canvas", { class: "ink", "aria-hidden": "true" });
    host.append(this.canvas);
    this.resize = new ResizeObserver(() => this.render());
    this.resize.observe(host);
    this.wire();
    share?.attach(this);
  }

  /** Drawing units in one screen pixel here (zoom included). */
  unitsPerPx() {
    if (this.view) {
      const m = this.view.matrix();
      return m[3] ? 1 / Math.abs(m[3]) : 1;
    }
    const r = this.live?.frame?.r || this.host.getBoundingClientRect();
    const w = this.live?.frame?.w ?? this.host.offsetWidth;
    const zoom = w ? r.width / w : 1;
    return 100 / (remPx() * zoom);
  }

  setTool(tool) {
    if (tool !== "lasso" && this.selection) this.clearSelection();
    this.tool = tool;
    this.canvas.classList.toggle("on", !!tool);
    this.host.classList.toggle("inking", !!tool);
    this.canvas.dataset.tool = tool || "";
  }

  /** size: a width of my own in px (그림 방's slider), null for the width's; opacity: 0.05 to 1. */
  setStyle({ color, width, brush, size, opacity }) {
    if (color) this.color = color;
    if (width) this.width = width;
    if (brush) this.brush = brush;
    if (size !== undefined) this.size = size;
    if (opacity !== undefined) this.opacity = Math.max(0.05, Math.min(1, Number(opacity) || 1));
    if (this.live?.style) this.splitLive();
  }

  /** The pen's look now: what a line begun now keeps as its own while it is drawn. */
  styleNow() {
    return { color: this.color, width: this.width, size: this.size, opacity: this.opacity };
  }

  /** A look's width in px. */
  pxOf(style) {
    return style.size || WIDTH_PX[style.width] || 4;
  }

  /**
   * The pen's size, colour or 불투명 changed while a line is being drawn (the other hand on the size
   * bar; the owner, 27 November: "브러쉬 긋고 있는 것도 실시간으로 그 부분에서 올리거나 크기를 낮춘 대로"):
   * what was drawn stays as it was, kept as one stroke in its own look, and the line goes on from the
   * very same point in the new look. Friends see the same.
   */
  splitLive() {
    const live = this.live;
    if (!live?.style || !live.pts || live.brush === "erase" || live.brush === "smudge" || live.shape || live.shapeNow) return;
    const was = live.style;
    const now = this.styleNow();
    if (now.color === was.color && now.size === was.size && now.width === was.width && now.opacity === was.opacity) return;
    // A part shorter than a few px just takes the new look (no stroke of a dot).
    const unit = this.unitsPerPx() || 1;
    let length = 0;
    for (let i = 3; i < live.pts.length; i += 3) length += Math.hypot(live.pts[i] - live.pts[i - 3], live.pts[i + 1] - live.pts[i - 2]) / unit;
    if (length >= 10) {
      clearTimeout(live.timer);
      // The parts of one line are one step back (cont: the room keeps them as one undo).
      live.split ||= "line" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const opId = this.onStroke({ pts: live.pts.slice(), color: was.color, width: was.width, size: was.size || undefined, brush: live.brush, opacity: was.opacity < 1 ? was.opacity : undefined, inside: !!this.inside(), cont: live.split });
      this.share?.end("ink", typeof opId === "string" ? opId : null);
      live.pts = live.pts.slice(-3);
      live.style = now;
      if (this.share) {
        this.share.begin("ink", { c: now.color, w: now.width, b: live.brush, ...(now.size ? { z: Math.round(now.size * 10) } : {}), ...(now.opacity < 1 ? { o: Math.round(now.opacity * 100) } : {}) });
        this.share.grow("ink", live.pts);
      }
    } else live.style = now;
    this.renderSoon();
  }

  // ---- 올가미 on drawings ------------------------------------------------------------------

  /** A point in stroke units on the screen. */
  toClient(x, y) {
    const r = this.host.getBoundingClientRect();
    if (this.view) {
      const [a, b, c, d, e, f] = this.view.matrix();
      return [r.left + a * x + c * y + e, r.top + b * x + d * y + f];
    }
    const zoom = this.host.offsetWidth ? r.width / this.host.offsetWidth : 1;
    const rem = remPx() * zoom;
    return [r.left + (x / 100) * rem, r.top + (y / 100) * rem];
  }

  /** What the 올가미 holds, with where it lies on the screen. */
  selectionInfo() {
    const sel = this.selection;
    if (!sel) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < sel.loop.length; i += 2) {
      const [x, y] = this.toClient(sel.loop[i], sel.loop[i + 1]);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return { ids: sel.ids, loop: sel.loop, rect: { left: x0, top: y0, right: x1, bottom: y1 } };
  }

  /** Holds these strokes (after a change made new ones of them), keeping the loop. */
  setSelection(ids, loop = this.selection?.loop) {
    this.selection = ids.length && loop ? { ids: new Set(ids), loop } : null;
    this.onLasso?.(this.selectionInfo());
    this.render();
  }

  clearSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.onLasso?.(null);
    this.render();
  }

  /** The loop being drawn or held: dashed in my accent, a faint fill when closed. */
  paintLoop(g, loop, closed) {
    if (!loop || loop.length < 4) return;
    const unit = this.unitsPerPx();
    const shift = closed && this.shift ? this.shift : { dx: 0, dy: 0 };
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#2f7bf0";
    g.save();
    g.beginPath();
    for (let i = 0; i < loop.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, loop[i] + shift.dx, loop[i + 1] + shift.dy);
    if (closed) {
      g.closePath();
      g.globalAlpha = 0.07;
      g.fillStyle = accent;
      g.fill();
    }
    g.globalAlpha = 0.95;
    g.strokeStyle = accent;
    g.lineWidth = 1.8 * unit;
    g.setLineDash([7 * unit, 5 * unit]);
    g.stroke();
    g.restore();
  }

  /** The pen's width in px now. */
  px() {
    return this.size || WIDTH_PX[this.width] || 4;
  }

  /** Points in hundredths of a rem from the host's top left. */
  point(e) {
    // While a line is drawn the page does not move under it: its place is read once.
    const frame = this.live?.frame || { r: this.host.getBoundingClientRect(), w: this.host.offsetWidth };
    if (this.live && !this.live.frame) this.live.frame = frame;
    const r = frame.r;
    // The page may be zoomed (text room pinch): on-screen size over laid-out size is the zoom.
    const zoom = frame.w ? r.width / frame.w : 1;
    const rem = remPx() * zoom;
    const pressure = e.pointerType === "pen" || (e.pressure > 0 && e.pressure !== 0.5) ? e.pressure : 0.5;
    if (this.view) {
      const [x, y] = this.view.point(e.clientX, e.clientY);
      return [Math.round(x), Math.round(y), Math.round(pressure * 100)];
    }
    return [Math.round(((e.clientX - r.left) / rem) * 100), Math.round(((e.clientY - r.top) / rem) * 100), Math.round(pressure * 100)];
  }

  /**
   * Two fingers began a zoom: a line a finger was drawing is dropped. A stylus's
   * line goes on (the second touch is a resting palm).
   */
  cancelTouch() {
    if (!this.live || this.live.kind === "pen") return;
    clearTimeout(this.live.timer);
    this.live.hold?.end(false);
    if (this.live.pts && this.live.brush !== "erase") this.share?.end("ink", null);
    if (this.live.light && this.light) {
      this.light.ended = performance.now();
      this.share?.end("laser");
    }
    this.live = null;
    this.render();
  }

  wire() {
    const c = this.canvas;
    // A line belongs to the finger (or pen) that began it. Another touch while it is
    // being drawn, such as a resting palm or a second finger, is left out of it.
    c.addEventListener("pointerdown", (e) => {
      if (!this.tool || this.live || this.blocked()) return;
      e.preventDefault();
      c.setPointerCapture?.(e.pointerId);
      this.xrayStart(e.clientX, e.clientY);
      if (this.tool === "lasso") {
        // 올가미: inside what it holds, the finger takes it anywhere; elsewhere a new loop is drawn.
        const [x, y] = this.point(e);
        const sel = this.selection;
        if (sel && loopHas(sel.loop, x, y)) {
          this.live = { pointer: e.pointerId, kind: e.pointerType, moving: true, x0: x, y0: y };
          this.shift = { dx: 0, dy: 0, ids: sel.ids };
          this.onLasso?.({ moving: true });
        } else {
          if (sel) this.clearSelection();
          this.live = { pointer: e.pointerId, kind: e.pointerType, loop: [x, y] };
        }
        return void this.renderSoon();
      }
      if (this.tool === "eraser-stroke") {
        this.live = { pointer: e.pointerId, kind: e.pointerType, erase: new Set() };
        this.eraseAt(e);
      } else if (this.tool === "laser") {
        // 가리키기: a light that follows the finger on every screen and fades; nothing is kept.
        const [x, y] = this.point(e);
        this.live = { pointer: e.pointerId, kind: e.pointerType, light: true };
        this.light = { pts: [x, y, 0], times: [performance.now()], ended: 0 };
        this.share?.begin("laser", {});
        this.share?.grow("laser", this.light.pts);
        this.renderSoon();
      } else if (this.tool === "pen" && this.brush === "fill") {
        // 채우기: a tap fills where it is let go; held still, 채우는 정도 first (slide right for more,
        // left for less), as the colour dropped from the bar does.
        const live = (this.live = { pointer: e.pointerId, kind: e.pointerType, fill: [e.clientX, e.clientY], hold: null });
        live.timer = setTimeout(() => {
          if (this.live === live && !live.moved) live.hold = holdFill(this, live.fill[0], live.fill[1]);
        }, FILL_HOLD_MS);
      } else {
        const first = this.point(e);
        const brush = this.tool === "eraser" ? "erase" : this.brush;
        // A finger presses as a pen would: from the hand's speed, kept in the line (a pen gives its own).
        const feel = e.pointerType === "touch" && brush !== "erase" ? fingerFeel(e.clientX, e.clientY, e.timeStamp) : null;
        if (feel) first[2] = Math.round(feel.p * 100);
        const level = Math.max(0, Math.min(3, this.steady() | 0));
        const string = STEADY_PX[level] * this.unitsPerPx();
        this.live = { pointer: e.pointerId, kind: e.pointerType, pts: first, brush, feel, lazy: string > 0 ? new LazyBrush(string, first[0], first[1]) : null, hand: first.slice(0, 2), rope: level >= 2, down: [e.clientX, e.clientY], style: this.styleNow() };
        // Friends see the line from its first point (the eraser's rubbing shows when it is done).
        if (this.share && brush !== "erase") {
          const st = this.live.style;
          this.share.begin("ink", { c: st.color, w: st.width, b: brush, ...(st.size ? { z: Math.round(st.size * 10) } : {}), ...(st.opacity < 1 ? { o: Math.round(st.opacity * 100) } : {}) });
          this.share.grow("ink", this.live.pts);
        }
        this.render();
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.live || e.pointerId !== this.live.pointer) return;
      this.xrayAt(e.clientX, e.clientY);
      if (this.live.erase) return void this.eraseAt(e);
      const live = this.live;
      if (live.fill) {
        if (live.hold) live.hold.move(e.clientX);
        else if (Math.hypot(e.clientX - live.fill[0], e.clientY - live.fill[1]) > 10) live.moved = true;
        return;
      }
      if (live.moving) {
        const [x, y] = this.point(e);
        this.shift = { dx: x - live.x0, dy: y - live.y0, ids: this.selection.ids };
        return void this.renderSoon();
      }
      if (live.loop) {
        for (const ev of e.getCoalescedEvents?.() || [e]) {
          const [x, y] = this.point(ev);
          const n = live.loop.length;
          if (Math.hypot(x - live.loop[n - 2], y - live.loop[n - 1]) >= 6) live.loop.push(x, y);
        }
        return void this.renderSoon();
      }
      if (live.shape) {
        // Still held after it became a shape: a line's end follows, any other shape grows or shrinks.
        const [x, y] = this.point(e);
        live.shapeNow = adjustShape(live.shape, live.shapeFrom, [x, y]);
        return void this.renderSoon();
      }
      if (live.light) {
        const now = performance.now();
        for (const ev of e.getCoalescedEvents?.() || [e]) {
          const [x, y] = this.point(ev);
          this.light.pts.push(x, y, 0);
          this.light.times.push(now);
        }
        this.share?.grow("laser", this.light.pts);
        return void this.renderSoon();
      }
      // Every point the pen passed (not only one per frame), drawn at the next frame: the line
      // keeps up with the pen however fast it goes.
      for (const ev of e.getCoalescedEvents?.() || [e]) this.take(live, this.felt(live, ev));
      this.holdForShape(e);
      if (this.share && live.brush !== "erase") this.share.grow("ink", live.pts);
      this.renderSoon();
    });
    const end = (e) => {
      if (!this.live || e.pointerId !== this.live.pointer) return;
      this.xrayEnd();
      const live = this.live;
      if (live.fill) {
        this.live = null;
        clearTimeout(live.timer);
        if (live.hold) live.hold.end(e.type === "pointerup");
        else if (e.type === "pointerup") this.fillAt({ clientX: live.fill[0], clientY: live.fill[1] });
        return;
      }
      if (live.moving) {
        this.live = null;
        const { dx, dy } = this.shift || { dx: 0, dy: 0 };
        this.shift = null;
        const sel = this.selection;
        if (sel && e.type === "pointerup" && Math.hypot(dx, dy) >= 2) {
          const moved = this.onLassoMove?.([...sel.ids], Math.round(dx), Math.round(dy));
          sel.loop = sel.loop.map((v, i) => Math.round(v + (i % 2 ? dy : dx)));
          if (moved?.length) sel.ids = new Set(moved);
        }
        this.onLasso?.(this.selectionInfo());
        return void this.render();
      }
      if (live.loop) {
        this.live = null;
        if (live.loop.length >= 6) {
          const loop = closeLoop(live.loop).map(Math.round);
          const ids = strokesWithinLoop(this.ink().strokes().filter((s) => s.b !== "erase"), loop);
          this.selection = ids.length ? { ids: new Set(ids), loop } : null;
        }
        this.onLasso?.(this.selectionInfo());
        return void this.render();
      }
      if (live.light) {
        this.live = null;
        if (this.light) this.light.ended = performance.now();
        this.share?.end("laser");
        return void this.renderSoon();
      }
      if (e.type === "pointerup" && !live.erase && !live.shape) for (const ev of e.getCoalescedEvents?.() || []) this.take(live, this.felt(live, ev));
      // With 손떨림 보정 the brush trails the hand on its string: as the pen lifts, the line goes the
      // rest of the way to where it was lifted (Krita's stabiliser "finishes the line" so too).
      if (live.lazy && live.pts && !live.shape && e.type === "pointerup") {
        const [hx, hy] = live.hand;
        const n = live.pts.length;
        if (Math.hypot(hx - live.pts[n - 3], hy - live.pts[n - 2]) >= 1) live.pts.push(Math.round(hx), Math.round(hy), live.pts[n - 1]);
      }
      this.live = null;
      clearTimeout(live?.timer);
      const shape = live?.shapeNow || live?.shape;
      let opId = null;
      // An eraser's stroke has no colour of its own; it keeps a neutral one. A line keeps the look it
      // was drawn in (the part after a change mid-line has the new one).
      const st = live?.style || this.styleNow();
      const size = st.size || undefined;
      const opacity = st.opacity < 1 ? st.opacity : undefined;
      const inside = live?.brush !== "erase" && !!this.inside();
      const cont = live?.split || null;
      if (shape) opId = this.onStroke({ pts: shape.pts, color: st.color, width: st.width, size, brush: live.brush, shape: true, opacity, inside, cont });
      else if (live?.pts && live.pts.length >= 3) opId = this.onStroke({ pts: live.pts, color: live.brush === "erase" ? "black" : st.color, width: st.width, size, brush: live.brush, opacity, inside, cont });
      if (live?.pts && live.brush !== "erase") this.share?.end("ink", typeof opId === "string" ? opId : null);
      this.render();
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    // Losing hold of the pointer without a lift also ends the line, so it never waits forever.
    c.addEventListener("lostpointercapture", end);
  }

  /** The colour drawn at a point of the screen ("#rrggbb"), or null where nothing is drawn. */
  readColor(x, y) {
    if (this.pickAt) return this.pickAt(x, y);
    return pixelAt(this.canvas, x, y);
  }

  /** A point from the hand: with 손떨림 보정 the brush follows on its string, and only its moves count. */
  /**
   * 채우기 at a tap: the region joined to it on this layer's own picture (what is drawn here, not the
   * layers above or below), grown a little under the soft edges of its lines, kept as a shape (its
   * edge and its holes) in my colour. Too thin a sliver to see is not kept.
   */
  fillAt(e, tolerance = fillTol) {
    const region = this.fillRegion(e.clientX, e.clientY, tolerance);
    this.endFillPreview();
    if (!region) return;
    const { mask, c, sx, kept } = region;
    let eps = 0.75 * sx;
    let rings = maskRings(mask, c.width, c.height).map((r) => simplifyRing(r, eps));
    // A stroke holds at most 3000 points: a very ragged region is simplified more.
    while (rings.reduce((n, r) => n + r.length, 0) > 2900 && eps < 40) {
      eps *= 1.6;
      rings = rings.map((r) => simplifyRing(r, eps));
    }
    const inv = kept.t.inverse();
    const pts = ringsToPoints(rings.filter((r) => r.length >= 3), ([x, y]) => { const p = inv.transformPoint({ x, y }); return [p.x, p.y]; });
    if (pts.length < 9) return;
    this.onStroke({ pts, color: this.color, width: this.width, brush: "fill", shape: true, opacity: this.opacity < 1 ? this.opacity : undefined, inside: !!this.inside() });
    this.render();
  }

  /**
   * The region a fill at a point of the screen takes with this tolerance: { mask, c (the picture's
   * canvas), sx, kept }, or null. The picture is read once while a fill is held in one place.
   */
  fillRegion(x, y, tolerance) {
    if (!this.kept) this.render();
    const kept = this.kept;
    if (!kept?.canvas || !kept.t) return null;
    const c = kept.canvas;
    let src = this.fillSrc;
    if (!src || src.kept !== kept || src.w !== c.width || src.h !== c.height) {
      const box = this.canvas.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      const g = c.getContext("2d", { willReadFrequently: true });
      src = this.fillSrc = { kept, w: c.width, h: c.height, box, sx: c.width / box.width, sy: c.height / box.height, data: g.getImageData(0, 0, c.width, c.height).data };
    }
    const mask = fillMask(src.data, c.width, c.height, (x - src.box.left) * src.sx, (y - src.box.top) * src.sy, { tolerance: clampTol(tolerance), grow: Math.max(1, Math.round(src.sx)) });
    return { mask, c, sx: src.sx, kept };
  }

  /**
   * 채우는 정도: what a fill at this point would take, shown on this layer in the colour (over this
   * layer, under the layers above it: as it will look). Returns how many pixels it takes.
   */
  fillPreview(x, y, tolerance) {
    const region = this.fillRegion(x, y, tolerance);
    if (!region) return 0;
    const { mask, c } = region;
    let o = this.fillShow;
    if (!o) {
      o = this.fillShow = h("canvas", { class: "fill-preview", "aria-hidden": "true" });
      this.canvas.after(o);
    }
    Object.assign(o.style, { left: this.canvas.offsetLeft + "px", top: this.canvas.offsetTop + "px", width: this.canvas.offsetWidth + "px", height: this.canvas.offsetHeight + "px" });
    if (o.width !== c.width || o.height !== c.height) {
      o.width = c.width;
      o.height = c.height;
      this.fillImg = null;
    }
    const g = o.getContext("2d");
    if (!g) return 0;
    const img = this.fillImg || (this.fillImg = g.createImageData(c.width, c.height));
    const [r, gr, b] = rgbOfCss(inkColor(this.color, this.fixedInk));
    const a = Math.round(235 * this.opacity);
    const d = img.data;
    let n = 0;
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      if (mask[i]) {
        d[p] = r;
        d[p + 1] = gr;
        d[p + 2] = b;
        d[p + 3] = a;
        n++;
      } else d[p + 3] = 0;
    }
    g.putImageData(img, 0, 0);
    o.dataset.filled = String(n);
    return n;
  }

  endFillPreview() {
    this.fillShow?.remove();
    this.fillShow = null;
    this.fillImg = null;
    this.fillSrc = null;
  }

  /** The point of an event, a finger's pressure read from its speed. */
  felt(live, ev) {
    const p = this.point(ev);
    if (live.feel) p[2] = Math.round(fingerStep(live.feel, ev.clientX, ev.clientY, ev.timeStamp) * 100);
    return p;
  }

  take(live, p) {
    if (!live.lazy) return void live.pts.push(...p);
    live.hand = [p[0], p[1]];
    if (live.lazy.update(p[0], p[1])) live.pts.push(Math.round(live.lazy.x), Math.round(live.lazy.y), p[2]);
  }

  /**
   * 모양 잡기: each time the hand moves on, the clock starts again; held still that long, the line
   * becomes the shape it was meant to be (when it clearly is one). Not for the erasers.
   */
  holdForShape(e) {
    const live = this.live;
    if (!live || live.brush === "erase" || !this.shapes()) return;
    if (live.still && Math.hypot(e.clientX - live.still[0], e.clientY - live.still[1]) <= 6) return;
    live.still = [e.clientX, e.clientY];
    clearTimeout(live.timer);
    live.timer = setTimeout(() => this.snap(live), SHAPE_HOLD_MS);
  }

  snap(live) {
    if (this.live !== live || live.shape || !live.pts) return;
    const shape = quickShape(thinPoints(live.pts));
    if (!shape) return;
    live.shape = shape;
    live.shapeNow = shape;
    live.shapeFrom = live.pts.slice(-3, -1);
    this.onShape();
    this.renderSoon();
  }

  eraseAt(e) {
    const [x, y] = this.point(e);
    const id = this.ink().strokeAt(x, y, 40);
    if (id && !this.live.erase.has(id)) {
      this.live.erase.add(id);
      this.onErase(id);
    }
  }

  render() {
    const c = this.canvas;
    if (!this.view && this.growing) this.grow();
    const rect = c.getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    let ratio = window.devicePixelRatio || 1;
    // Never more than maxPixels: a little soft when zoomed far in, but every layer fits in memory.
    const pixels = rect.width * rect.height * ratio * ratio;
    if (pixels > this.maxPixels) ratio *= Math.sqrt(this.maxPixels / pixels);
    const w = Math.max(1, Math.round(rect.width * ratio));
    const hgt = Math.max(1, Math.round(rect.height * ratio));
    if (c.width !== w || c.height !== hgt) {
      c.width = w;
      c.height = hgt;
    }
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, hgt);
    // Drawn at the zoomed size (sharp), in the page's own units, from the paper's corner
    // (the canvas reaches past the paper's sides).
    if (this.view) {
      const [a, b, cc, d, e, f] = this.view.matrix();
      g.setTransform(a * ratio, b * ratio, cc * ratio, d * ratio, (e + host.left - rect.left) * ratio, (f + host.top - rect.top) * ratio);
    } else {
      const zoom = this.host.offsetWidth ? host.width / this.host.offsetWidth : 1;
      const scale = (remPx() / 100) * ratio * zoom;
      g.setTransform(scale, 0, 0, scale, (host.left - rect.left) * ratio, (host.top - rect.top) * ratio);
    }
    // What is already drawn is kept as a picture and drawn again only when it changes (or the view
    // moves); while a line is being drawn only that line is painted over it each frame.
    const shift = this.shift;
    const t = g.getTransform();
    const ink = this.ink();
    const version = ink.version;
    const key = [w, hgt, t.a, t.b, t.c, t.d, t.e, t.f, shift ? `${shift.dx},${shift.dy},${shift.ids.size}` : "", currentTheme()].join("|");
    // The picture belongs to one drawing (a layer can be pointed at another one: 애니메이션 방's frames).
    const kept = this.kept;
    if (!kept || kept.key !== key || kept.doc !== ink || kept.version !== version) {
      const strokes = ink.strokes();
      const last = strokes[strokes.length - 1];
      // One line added on top of what the picture already holds (the line just drawn, or a friend's
      // newest): only that line is painted onto it. Redrawing every line each time a line ended held
      // up the next line's start on a full board (the owner: "한 선 한 선 그릴 때마다 끊겨").
      if (kept && kept.key === key && kept.doc === ink && !shift && last && strokes.length === kept.count + 1 && (kept.count === 0 || strokes[strokes.length - 2]?.id === kept.lastId)) {
        const pg = kept.canvas.getContext("2d");
        pg.setTransform(t);
        this.paint(pg, last.pts, last.c, widthOf(last), brushOf(last), !!last.q, opacityOf(last), !!last.a);
        Object.assign(kept, { version, count: strokes.length, lastId: last.id });
      } else {
        const pic = kept?.canvas || document.createElement("canvas");
        pic.width = w;
        pic.height = hgt;
        const pg = pic.getContext("2d");
        pg.setTransform(t);
        for (const s of strokes) {
          const pts = shift && shift.ids.has(s.id) ? s.pts.map((v, i) => (i % 3 === 0 ? v + shift.dx : i % 3 === 1 ? v + shift.dy : v)) : s.pts;
          this.paint(pg, pts, s.c, widthOf(s), brushOf(s), !!s.q, opacityOf(s), !!s.a);
        }
        this.kept = { key, version, canvas: pic, doc: ink, t, count: strokes.length, lastId: last?.id ?? null };
      }
    }
    const live = this.live;
    // 문지르기 being drawn is the picture itself, smudged further as the finger goes on.
    const wet = live?.pts && live.brush === "smudge" && !live.shapeNow;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    const st = live?.style || this.styleNow();
    g.drawImage(wet ? wetPicture(live, this.kept, st.color, this.pxOf(st), st.opacity) : this.kept.canvas, 0, 0);
    g.restore();
    // The line being drawn as it will be kept (the same points), or the shape it became.
    const locked = !!this.inside();
    if (live?.shapeNow) this.paint(g, live.shapeNow.pts, st.color, this.pxOf(st), live.brush, true, st.opacity, locked);
    else if (live?.pts && !wet) this.paint(g, thinPoints(live.pts), st.color, this.pxOf(st), live.brush, false, st.opacity, locked);
    // 손떨림 보정 (중·강): the string from the hand to the brush, so the lag reads as a pull.
    if (live?.lazy && live.rope && !live.shape) this.paintRope(g, live);
    // 올가미: the loop being drawn, or the one that holds strokes (moving with them).
    if (live?.loop) this.paintLoop(g, live.loop, false);
    else if (this.selection) this.paintLoop(g, this.selection.loop, true);
    // Friends' lines as they draw them, in their brushes; their pen with their colour and name.
    const tips = [];
    for (const line of this.share?.lines() || []) {
      this.paint(g, line.pts, line.c, widthOf(line), line.b, false, opacityOf(line));
      if (line.live) tips.push(line);
    }
    // Pointer lights: friends' and mine; while one still glows, the next frame comes.
    const now = performance.now();
    let glowing = false;
    for (const light of this.share?.lights() || []) glowing = this.paintLight(g, light, now) || glowing;
    if (this.light) {
      const mine = this.share?.mine?.() || { color: inkColor("blue") };
      if (this.paintLight(g, { ...this.light, color: mine.color }, now)) glowing = true;
      else if (this.light.ended) this.light = null;
    }
    if (tips.length) this.paintTips(g, tips);
    // 클리핑: only where the layer below has ink (its canvas is the same size, laid over the same page).
    const base = this.clipTo();
    if (base && base.width === c.width && base.height === c.height) {
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = "destination-in";
      g.drawImage(base, 0, 0);
      g.restore();
    }
    if (glowing) this.renderSoon();
    this.afterRender?.();
  }

  paintRope(g, live) {
    const unit = this.unitsPerPx();
    g.save();
    g.globalAlpha = 0.45;
    g.strokeStyle = inkColor(this.color);
    g.lineWidth = 1.2 * unit;
    g.setLineDash([3 * unit, 3 * unit]);
    g.beginPath();
    g.moveTo(live.lazy.x, live.lazy.y);
    g.lineTo(live.hand[0], live.hand[1]);
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 0.3;
    g.beginPath();
    g.arc(live.hand[0], live.hand[1], live.lazy.radius, 0, Math.PI * 2);
    g.stroke();
    g.restore();
  }

  /** A pointer's light: a neon trail in the person's colour, each part fading as it ages. */
  paintLight(g, { pts, times, color }, now) {
    const n = Math.floor(pts.length / 3);
    if (!n) return false;
    const unit = this.unitsPerPx();
    const ratio = window.devicePixelRatio || 1;
    let alive = false;
    g.save();
    g.lineCap = "round";
    g.lineJoin = "round";
    // The trail goes in short runs, each one path (no bright dots where pieces would overlap),
    // fading with the age of its newest point.
    let first = 0;
    while (first < n && now - (times[first] || 0) > LIGHT_MS) first++;
    const RUN = 6;
    for (const pass of [0, 1]) {
      g.shadowColor = color;
      g.shadowBlur = pass ? 0 : 14 * ratio;
      g.strokeStyle = pass ? "rgba(255,255,255,0.92)" : color;
      for (let i = first; i < n; i += RUN) {
        const last = Math.min(n, i + RUN) - 1;
        const k = 1 - Math.min(1, (now - (times[last] || 0)) / LIGHT_MS);
        if (k <= 0) continue;
        alive = true;
        g.globalAlpha = pass ? k * k * 0.85 : k * k;
        g.lineWidth = (pass ? 1.6 : 5.5) * unit * (0.45 + 0.55 * k);
        g.beginPath();
        const from = Math.max(0, i - 1);
        g.moveTo(pts[from * 3], pts[from * 3 + 1]);
        for (let j = from + 1; j <= last; j++) g.lineTo(pts[j * 3], pts[j * 3 + 1]);
        if (last === from) g.lineTo(pts[from * 3] + 0.01, pts[from * 3 + 1]);
        g.stroke();
      }
    }
    g.restore();
    return alive;
  }

  /** Where each friend's pen is: a dot in their colour, their name beside it (kept screen-sized). */
  paintTips(g, tips) {
    const ratio = window.devicePixelRatio || 1;
    const t = g.getTransform();
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.font = `700 ${Math.round(11 * ratio)}px system-ui, sans-serif`;
    g.textBaseline = "middle";
    for (const tip of tips) {
      const n = tip.pts.length;
      const at = t.transformPoint(new DOMPoint(tip.pts[n - 3], tip.pts[n - 2]));
      g.globalAlpha = 1;
      g.fillStyle = tip.color;
      g.strokeStyle = "rgba(255,255,255,0.95)";
      g.lineWidth = 2 * ratio;
      g.beginPath();
      g.arc(at.x, at.y, 4.5 * ratio, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (!tip.name) continue;
      const w = g.measureText(tip.name).width + 12 * ratio;
      const hgt = 18 * ratio;
      const x = at.x + 9 * ratio;
      const y = at.y - hgt - 4 * ratio;
      g.fillStyle = tip.color;
      g.globalAlpha = 0.92;
      g.beginPath();
      g.roundRect?.(x, y, w, hgt, hgt / 2);
      g.fill();
      g.globalAlpha = 1;
      g.fillStyle = "#fff";
      g.fillText(tip.name, x + 6 * ratio, y + hgt / 2);
    }
    g.restore();
  }

  /**
   * Drawing near the floating glass (bars, tools, the frames' strip), the bars never fade (making every bar
   * fade at each pen-down stuttered the line's start); only the glass the pen comes near opens a soft round
   * window around the pen tip, and closes behind it. Where the glass stands is read once as the pen goes down.
   *
   * Only that window (the owner, 28 November, with four photos of a whiteboard drawn on: "드러워지고…
   * 깜빡임이 그 소리야.. 그림 그리기에서"). The wider see-through of 26 and 27 November (lines of the colour
   * being painted, and the inside of shapes they close, showing through the glass in spots) left the bars
   * spotted with lines and their words half rubbed out; and its mask, a picture made anew many times a
   * second, took the whole glass away for a moment each time it changed (a mask picture not yet read counts
   * as see-through). The window is a CSS gradient: nothing to read, nothing to blink.
   */
  xrayStart(x, y) {
    this.xrayClear();
    const room = this.host.closest(".room");
    const parts = room ? [...room.querySelectorAll(XRAY_PARTS)] : [];
    // The glass itself, not a box that only holds glass (one window, never two over each other).
    this.xr = parts.filter((el) => !parts.some((o) => o !== el && el.contains(o)))
      .map((el) => ({ el, r: el.getBoundingClientRect(), on: false })).filter((p) => p.r.width > 0 && p.r.height > 0);
    this.xrAt = null;
    this.xrayAt(x, y);
  }

  xrayAt(x, y) {
    if (!this.xr?.length) return;
    if (this.xrAt && Math.abs(this.xrAt[0] - x) + Math.abs(this.xrAt[1] - y) < 2) return;
    this.xrAt = [x, y];
    for (const p of this.xr) {
      const r = p.r;
      const near = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom)) < XRAY_NEAR;
      if (near) {
        p.el.style.setProperty("--xr-x", Math.round(x - r.left) + "px");
        p.el.style.setProperty("--xr-y", Math.round(y - r.top) + "px");
      }
      if (near !== p.on) {
        p.on = near;
        p.el.classList.toggle("xray", near);
      }
    }
  }

  /** Pen up: the window closes. */
  xrayEnd() {
    this.xrayClear();
  }

  xrayClear() {
    for (const p of this.xr || []) if (p.on) p.el.classList.remove("xray");
    this.xr = null;
  }

  /** One drawing per frame however many points came. */
  renderSoon() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** The paper is at least as tall as its lowest drawing, and, while drawing, has room below. */
  grow() {
    let lowest = 0;
    for (const s of this.ink().strokes()) for (let i = 1; i < s.pts.length; i += 3) if (s.pts[i] > lowest) lowest = s.pts[i];
    if (this.live?.pts) for (let i = 1; i < this.live.pts.length; i += 3) if (this.live.pts[i] > lowest) lowest = this.live.pts[i];
    const rem = remPx();
    const want = Math.max(lowest > 0 ? (lowest / 100 + 1.5) * rem : 0, this.tool ? this.room() : 0);
    const next = want > 0 ? Math.ceil(want) + "px" : "";
    if (this.host.style.minHeight !== next) this.host.style.minHeight = next;
  }

  paint(g, pts, color, px, brush, shaped = false, alpha = 1, inside = false) {
    paintStroke(g, pts, this.fixedInk ? fixedInk(color) : color, px, brush, shaped, alpha, inside);
  }

  destroy() {
    // What the 올가미 held lets go (its small menu goes with the room).
    if (this.selection) {
      this.selection = null;
      this.onLasso?.(null);
    }
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.share?.detach(this);
    this.canvas.remove();
  }
}

// 문지르기: at each step along the line the soft round patch just behind is lifted and laid down where
// the finger is now, part of the way (Krita's smearing smudge; libmypaint's smudge for the idea).
// The patch is blended in, see-through included, so colour is pulled into empty paper and empty
// paper thins the colour it is pulled over, as a finger in wet paint. It reads the picture as it
// stands under the line (only that layer), so the same strokes in the same order smudge the same on
// every screen.
// from/upto: the dabs to lay (a line still being drawn lays only its new ones each frame); it
// returns where it stopped.
let smudgeScratch = null;
function smudgeAlong(g, points, size, look, real, from = 1, upto = Infinity) {
  if (points.length < 2 || !g.canvas) return from;
  const t = g.getTransform();
  const scale = Math.hypot(t.a, t.b) || 1;
  const r = Math.max(2, Math.round((size / 2) * scale));
  const d = r * 2;
  const marks = dabs(points, { step: size * look.spacing });
  const end = Math.min(upto, marks.length);
  from = Math.max(1, from);
  if (end <= from) return from;
  smudgeScratch ||= document.createElement("canvas");
  const s = smudgeScratch;
  if (s.width !== d || s.height !== d) {
    s.width = d;
    s.height = d;
  }
  const sg = s.getContext("2d");
  if (!sg) return from;
  const fade = sg.createRadialGradient(r, r, 0, r, r, r);
  fade.addColorStop(0, "rgba(0,0,0,1)");
  fade.addColorStop(0.5, "rgba(0,0,0,0.85)");
  fade.addColorStop(1, "rgba(0,0,0,0)");
  const px = (m) => [Math.round(t.a * m.x + t.c * m.y + t.e - r), Math.round(t.b * m.x + t.d * m.y + t.f - r)];
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  let [fx, fy] = px(marks[from - 1]);
  for (let i = from; i < end; i++) {
    const [tx, ty] = px(marks[i]);
    // The patch under where the finger was, softened to a round dab.
    sg.globalCompositeOperation = "source-over";
    sg.clearRect(0, 0, d, d);
    sg.drawImage(g.canvas, fx, fy, d, d, 0, 0, d, d);
    sg.globalCompositeOperation = "destination-in";
    sg.fillStyle = fade;
    sg.fillRect(0, 0, d, d);
    // Where it is now: what is there gives way by the dab's share, and the patch fills that share
    // (a blend that carries see-through as well as colour). Harder pressed, more of it.
    const a = look.alpha * (real ? 0.45 + 0.55 * marks[i].p : 0.85);
    g.globalAlpha = a;
    g.globalCompositeOperation = "destination-out";
    g.fillStyle = fade;
    g.translate(tx, ty);
    g.fillRect(0, 0, d, d);
    g.globalCompositeOperation = "lighter";
    g.drawImage(s, 0, 0);
    g.translate(-tx, -ty);
    fx = tx;
    fy = ty;
  }
  g.restore();
  return end;
}

/** 문지르기 while it is being drawn: the picture smudged so far, kept, smudged further each frame. */
function wetPicture(live, kept, color, px, alpha = 1) {
  // The picture changes without its key when a line is painted onto it (a friend's): its version tells.
  const key = kept.key + "|" + kept.version;
  if (!live.wet || live.wet.key !== key) {
    const c = live.wet?.canvas || document.createElement("canvas");
    c.width = kept.canvas.width;
    c.height = kept.canvas.height;
    const wg = c.getContext("2d");
    wg.drawImage(kept.canvas, 0, 0);
    live.wet = { key, canvas: c, done: 1 };
  }
  const pts = thinPoints(live.pts);
  if (pts.length < 6) return live.wet.canvas;
  const base = brushLook("smudge");
  const look = alpha < 1 ? { ...base, alpha: base.alpha * alpha } : base;
  const size = (px || 4) * (100 / 16) * look.scale;
  const points = strokePoints(pts, { streamline: look.streamline });
  // Only up to the line's last settled point: its very end still moves as the hand goes on.
  const settled = points.length > 2 ? Math.floor(points[points.length - 2].run / Math.max(1, size * look.spacing)) + 1 : 1;
  const wg = live.wet.canvas.getContext("2d");
  wg.setTransform(kept.t);
  live.wet.done = smudgeAlong(wg, points, size, look, hasPressure(pts), live.wet.done, settled);
  return live.wet.canvas;
}

/** A small line drawn with the brush, as it will look (pressure rising and falling, as a hand does). */
function brushPreview(brush, color, width) {
  const canvas = h("canvas", { class: "ink-preview", "aria-hidden": "true" });
  const draw = () => {
    const w = 34;
    const ht = 16;
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(ht * ratio);
    const g = canvas.getContext("2d");
    if (!g) return;
    // Stroke units: 100 to a rem (16 px), so 1 unit = 0.16 px.
    const k = 0.16 * ratio;
    g.setTransform(k, 0, 0, k, 0, 0);
    const pts = [];
    if (brush === "smudge") {
      // 문지르기 shows itself pulling three bars of the colour along to the right.
      for (const x of [40, 78, 116]) paintStroke(g, [x, 10, 60, x, 50, 60, x, 90, 60], color, WIDTH_PX[2], "marker");
      for (let i = 0; i <= 12; i++) pts.push(Math.round(24 + i * 13), 50, 70);
    } else if (brush === "fill") {
      // 채우기 shows a filled drop (a bucket's paint) rather than a line.
      for (const [x, y, p] of [[60, 18, 100], [128, 18, 0], [176, 60, 0], [128, 92, 0], [60, 92, 0], [18, 55, 0]]) pts.push(x, y, p);
    } else if (brush === "sketch") {
      // 스케치 shows itself when rubbed back and forth (its web of faint strokes appears).
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        pts.push(Math.round(30 + t * 150 + Math.sin(i * 1.7) * 14), Math.round(50 + (i % 2 ? -26 : 26) * (0.6 + 0.4 * Math.sin(t * Math.PI))), 50);
      }
    } else {
      const n = 24;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        pts.push(Math.round(24 + t * 164), Math.round(50 + Math.sin(t * Math.PI * 2) * 22), Math.round(25 + 70 * Math.sin(t * Math.PI)));
      }
    }
    paintStroke(g, pts, color, WIDTH_PX[Math.min(width, 2)] || 4, brush);
  };
  // Its size is fixed, so it is painted at once (a frame may never come to a screen in the back).
  draw();
  return canvas;
}

/**
 * The drawing tools, the same in every room that draws, laid out as ArtCraft's paint page lays its
 * side toolbar (MIT/Apache; read for the layout) and as Procreate and ibisPaint keep the size on a
 * side bar: a slim glass rail at the left edge — the brush (a little line of itself in the colour),
 * the eraser, 가리키기, the colour, and the size (a bar, fine at the bottom, bold at the top, with
 * three quick sizes). A tap on the brush, the colour or the eraser (when it is on) opens a small window
 * beside the rail: every brush with 모양 잡기 and 보정; the eight colours, 색 원판 and the last colours;
 * 부분 or 획. Choosing in it closes it, so the next touch draws. In a card (the games) the same tools
 * lie in one row. pen: { tool, brush, color, width, size }; setTool(tool) applies a change;
 * units(): stroke units in a screen pixel now (the size dot shows the brush as big as it will draw).
 */
/** restyle(): the pen's look goes to the drawing layers at once, while the size bar is still held. */
export function drawInkTools(panel, { pen, setTool, store, layout = "rail", units = null, lasso = false, fixedInk: fixed = false, restyle = null, pieces = null, drop = null }) {
  // In 그림 방 and 애니메이션 방 black is shown as the black it draws (it never turns with 어둡게).
  const shown = (c) => inkColor(c, fixed);
  // 채우는 정도, the same in every room's 채우기 and 컬러드롭: as this device last set it.
  fillTol = clampTol(getSettings(store).fillTol ?? 48);
  keepTol = (v) => setSetting(store, "fillTol", v);
  const drawn = (c) => (fixed ? fixedInk(c) : c);
  panel.hidden = !pen.tool;
  for (const el of railParts(panel)) el.hidden = !pen.tool;
  if (pen.tool !== "pen") closeColorWheel();
  if (!pen.tool) return void closeInkPop();
  notePenColor(store, pen.color);
  // A button of this rail wherever its piece is (the rail may be in pieces: ui/ink-pieces.js).
  const inRail = (sel) => railParts(panel).map((el) => el.querySelector(sel)).find(Boolean) || null;
  const rail = layout === "rail";
  panel.classList.toggle("rail", rail);
  panel.classList.toggle("row", !rail);
  const erasing = pen.tool === "eraser" || pen.tool === "eraser-stroke";
  const pointing = pen.tool === "laser";
  const eraserKind = () => (getSettings(store).inkEraser === "stroke" ? "eraser-stroke" : "eraser");
  const choose = (patch) => { Object.assign(pen, patch); setTool("pen"); };
  const own = typeof pen.color === "string" && pen.color.startsWith("#");
  const brushName = BRUSH_NAMES.find(([b]) => b === pen.brush)?.[1] || "펜";
  const brushNow = h("button", { class: "ink-tool ink-brush-now", id: "ink-brush-now", type: "button", "aria-label": `붓: ${brushName} (눌러서 붓 고르기)`,
    "aria-pressed": String(pen.tool === "pen"), "aria-expanded": String(inkPop?.kind === "brush"),
    onclick: () => (pen.tool !== "pen" ? setTool("pen") : togglePop("brush", brushNow)) },
    brushPreview(pen.brush, drawn(pen.color), pen.width), h("span", { class: "ink-tool-name", text: brushName }));
  const eraserButton = iconButton("eraser", "eraser", "지우개 (다시 누르면 부분·획)", () => (erasing ? togglePop("erase", eraserButton) : setTool(eraserKind())));
  eraserButton.setAttribute("aria-pressed", String(erasing));
  const laserButton = iconButton("ink-laser", "laser", "가리키기 (친구 화면에 빛으로, 남지 않아요)", () => setTool(pointing ? "pen" : "laser"));
  laserButton.setAttribute("aria-pressed", String(pointing));
  // 올가미 (the text room, 그림 방): drawn round lines, it holds them to take anywhere, recolour, copy or rub out.
  const lassoButton = !lasso ? null : iconButton("ink-lasso", "lasso", "올가미 (그림을 둘러 골라 아무 데나 옮기기·색·복제·지우기)", () => setTool(pen.tool === "lasso" ? "pen" : "lasso"));
  lassoButton?.setAttribute("aria-pressed", String(pen.tool === "lasso"));
  const colorNow = h("button", { class: "ink-tool ink-color-now" + (own ? " own" : ""), id: "ink-color-now", type: "button",
    "aria-label": "색 고르기 (지금 " + pen.color + ") · 꾹 누르면 바로 전 색" + (drop ? " · 종이로 끌어 놓으면 채우기" : ""),
    "aria-expanded": String(inkPop?.kind === "color"), style: { "--c": shown(pen.color) }, onclick: () => togglePop("color", colorNow) }, h("span", { class: "ink-dot" }));
  // The colour button as Procreate's: held, 바로 전 색 (and held again, back: the owner, 28 November: "색깔
  // 꾹 누르면 저번에 한 색깔이 뜨게… 와따가따를 빠르고 좋게"); dragged onto the drawing, 컬러드롭 fills where
  // it is let go (the owner, 27 November: "체우기는 색을 꾹 눌러서 어디다가 가져다 두면").
  wireColorButton(colorNow, {
    colourOf: () => shown(pen.color),
    drop,
    swap: () => {
      const before = getSettings(store).inkPrev;
      if (!before || before === pen.color) return void flashHint("색을 한 번 바꾸면, 꾹 = 바로 전 색");
      choose({ color: before });
      inRail("#ink-color-now")?.classList.add("swapped");
      flashHint("바로 전 색 · 다시 꾹 누르면 돌아가요");
    },
  });
  // 빠른 굵기: three sizes at a tap; held, a button takes the size the brush has now (the owner, 27
  // November: "브러쉬 크기 바꾸는 버튼 3개 나열되어있는거 꾹누르면 그거 설치하기도").
  const quick = quickSizes(store);
  const pxNow = pen.size || WIDTH_PX[pen.width] || 4;
  const widths = h("div", { class: "ink-widths", role: "group", "aria-label": "빠른 굵기 (꾹 누르면 지금 굵기를 넣어요)" },
    ...[3, 2, 1].map((w, i) => {
      const px = quick[i] || WIDTH_PX[w];
      const on = quick[i] ? pen.size === px || (!pen.size && WIDTH_PX[pen.width] === px) : !pen.size && pen.width === w;
      const dot = quick[i] ? dotRem(px) : 0.2 + w * 0.18;
      const b = h("button", { class: "ink-width", type: "button", data: { width: String(w), px: String(px) }, "aria-label": `굵기 ${px}px (꾹 누르면 지금 굵기를 넣어요)`, "aria-pressed": String(on) },
        h("span", { style: { width: dot + "rem", height: dot + "rem" } }));
      holdToSet(b, () => {
        setQuickSize(store, i, pxNow);
        flashHint(`이 굵기를 넣었어요 · ${pxNow}px`);
        setTool(pen.tool);
      });
      b.addEventListener("click", () => {
        if (b.dataset.held) return void delete b.dataset.held;
        if (quick[i]) {
          pen.size = px;
          pen.width = nearestWidth(px);
        } else {
          pen.width = w;
          pen.size = null;
        }
        setTool(pen.tool);
      });
      return b;
    }));
  const size = rail && !pointing ? sizeBar() : null;
  if (rail && pieces) {
    // 그림 방, 애니메이션 방: the rail in pieces, where this kind of room keeps them.
    placePieces(panel, { tools: [brushNow, eraserButton, lassoButton, laserButton].filter(Boolean), color: [colorNow], size: size ? [size] : [], widths: pointing ? [] : [widths] },
      { store, kind: pieces, hidden: new Set(pointing ? ["size", "widths"] : []), redraw: () => setTool(pen.tool) });
  } else {
    const parts = [brushNow, eraserButton, lassoButton, laserButton, h("span", { class: "ink-sep", "aria-hidden": "true" }), colorNow].filter(Boolean);
    if (size) parts.push(h("span", { class: "ink-sep", "aria-hidden": "true" }), size, widths);
    else if (!pointing) parts.push(widths);
    panel.replaceChildren(...parts);
  }

  /** The size bar: 0.5 to 40 px on a doubling scale; while a finger is on it a dot shows the brush. */
  function sizeBar() {
    const px = () => pen.size || WIDTH_PX[pen.width] || 4;
    const t = (v) => Math.log(v / SIZE_MIN) / Math.log(SIZE_MAX / SIZE_MIN);
    const from = (k) => Math.round(SIZE_MIN * (SIZE_MAX / SIZE_MIN) ** Math.max(0, Math.min(1, k)) * 10) / 10;
    // The brush's dot beside the bar while a finger is on it, on the screen itself: inside the rail's
    // glass it was cut off where it stood out of it (so it never showed).
    const peek = h("span", { class: "size-peek floating", id: "size-peek", "aria-hidden": "true" });
    const bar = h("div", { class: "size-rail", id: "size-rail", role: "slider", tabindex: "0", "aria-label": "붓 크기", "aria-orientation": "vertical",
      "aria-valuemin": String(SIZE_MIN), "aria-valuemax": String(SIZE_MAX) }, h("span", { class: "size-track" }), h("span", { class: "size-thumb" }));
    const placePeek = () => {
      if (!peek.isConnected) return;
      const r = bar.getBoundingClientRect();
      const d = parseFloat(peek.style.width) || 4;
      const pad = 11;
      const k = t(px());
      const turn = Number(bar.closest("[data-turn]")?.dataset.turn) || 0;
      let x;
      let y;
      if (turn === 90 || turn === 270) {
        x = turn === 90 ? r.left + pad + k * (r.width - 2 * pad) : r.right - pad - k * (r.width - 2 * pad);
        y = r.top - 14 - d / 2;
        if (y - d / 2 < 4) y = r.bottom + 14 + d / 2;
      } else {
        y = turn === 180 ? r.top + pad + k * (r.height - 2 * pad) : r.bottom - pad - k * (r.height - 2 * pad);
        x = r.right + 14 + d / 2;
        if (x + d / 2 > innerWidth - 4) x = r.left - 14 - d / 2;
      }
      peek.style.left = x + "px";
      peek.style.top = y + "px";
    };
    const paint = () => {
      const v = px();
      bar.style.setProperty("--t", t(v).toFixed(4));
      bar.setAttribute("aria-valuenow", String(v));
      bar.setAttribute("aria-valuetext", v + "px");
      const look = brushLook(erasing ? "erase" : pen.brush);
      const d = Math.max(2, Math.min(220, (v * (100 / 16) * (look.scale || 1)) / (units?.() || 100 / 16)));
      peek.style.width = peek.style.height = d.toFixed(1) + "px";
      peek.style.background = erasing ? "transparent" : shown(pen.color);
      peek.classList.toggle("erase", erasing);
      placePeek();
    };
    // The size goes to the layers while the bar is still held (a line being drawn takes it from here on).
    const set = (v) => {
      if (pen.size === v) return;
      pen.size = v;
      paint();
      restyle?.();
    };
    let drag = null;
    // Along the bar as its piece is turned: upright, the big end at the top; a quarter turned, at the right.
    const at = (e) => {
      const r = bar.getBoundingClientRect();
      const pad = 9;
      const turn = Number(bar.closest("[data-turn]")?.dataset.turn) || 0;
      const across = (e.clientX - r.left - pad) / Math.max(1, r.width - pad * 2);
      const down = (e.clientY - r.top - pad) / Math.max(1, r.height - pad * 2);
      set(from(turn === 90 ? across : turn === 270 ? 1 - across : turn === 180 ? down : 1 - down));
    };
    bar.addEventListener("pointerdown", (e) => {
      if (drag || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault();
      drag = { id: e.pointerId };
      bar.setPointerCapture?.(e.pointerId);
      bar.classList.add("sizing");
      document.body.append(peek);
      at(e);
      placePeek();
    });
    bar.addEventListener("pointermove", (e) => { if (drag && e.pointerId === drag.id) at(e); });
    const done = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      bar.classList.remove("sizing");
      peek.remove();
      setTool(pen.tool); // the layers take the size; the quick sizes let go of their choice
    };
    bar.addEventListener("pointerup", done);
    bar.addEventListener("pointercancel", done);
    bar.addEventListener("keydown", (e) => {
      const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      set(from(t(px()) + step / 24));
      setTool(pen.tool);
    });
    paint();
    return bar;
  }

  /** A small window beside the rail (above the row): the brushes, the colours or the eraser's way. */
  function togglePop(kind, anchor) {
    if (inkPop?.kind === kind) return void closeInkPop();
    closeInkPop();
    closeColorWheel();
    const el = h("div", { class: "ink-pop", id: "ink-pop", role: "dialog", data: { kind }, "aria-label": { brush: "붓", color: "색", erase: "지우개" }[kind] });
    document.body.append(el);
    const stop = closeOnOutside((t) => el.contains(t), () => closeInkPop(), el);
    const pop = { kind, el, anchor, panel, close: () => { stop(); el.remove(); }, fill: () => fillPop(pop) };
    inkPop = pop;
    pop.fill();
    place(pop);
    for (const part of railParts(panel)) for (const b of part.querySelectorAll("[aria-expanded]")) b.setAttribute("aria-expanded", String(b === anchor));
  }

  function fillPop(pop) {
    const { el, kind } = pop;
    if (kind === "brush") {
      const shapes = getSettings(store).inkShapes !== false;
      // 손떨림 보정 is off at first: it pulls a quick small letter round (6 px off at '약'); who wants it turns it on.
      const steady = Math.max(0, Math.min(3, getSettings(store).inkSteady ?? 0));
      el.replaceChildren(
        h("div", { class: "ink-brushes", role: "group", "aria-label": "붓" },
          ...BRUSH_NAMES.map(([b, name]) => h("button", { class: "ink-brush", type: "button", data: { brush: b }, "aria-pressed": String(pen.tool === "pen" && pen.brush === b), "aria-label": name,
            onclick: () => { setSetting(store, "inkBrush", b); closeInkPop(); choose({ brush: b }); } },
            brushPreview(b, drawn(pen.color), pen.width), h("span", { class: "ink-brush-name", text: name })))),
        h("div", { class: "ink-pop-row" },
          h("button", { class: "ink-shapes chip", id: "ink-shapes", type: "button", "aria-pressed": String(shapes), title: "그리고 잠깐 멈추면 반듯한 선·동그라미·네모로",
            onclick: () => { setSetting(store, "inkShapes", !shapes); pop.fill(); } }, "모양 잡기"),
          h("button", { class: "ink-steady chip", id: "ink-steady", type: "button", "aria-pressed": String(steady > 0), "aria-label": "손떨림 보정: " + STEADY_NAMES[steady], title: "손떨림 보정: 손이 떨려도 선이 매끈하게 (누를 때마다 약·중·강·끔)",
            onclick: () => { setSetting(store, "inkSteady", (steady + 1) % 4); pop.fill(); } }, "보정 " + STEADY_NAMES[steady])));
    } else if (kind === "color") {
      const recent = (getSettings(store).inkRecent || []).slice(0, 8);
      mount(el,
        h("div", { class: "ink-colors", role: "group", "aria-label": "색" },
          ...INK_COLORS.map((c) => h("button", { class: "ink-color", type: "button", data: { ink: c }, "aria-label": c, "aria-pressed": String(!erasing && pen.color === c),
            style: { background: shown(c) }, onclick: () => { closeInkPop(); choose({ color: c }); } })),
          inkWell()),
        recent.length ? h("div", { class: "ink-colors recent", role: "group", "aria-label": "최근 색" },
          ...recent.map((c) => h("button", { class: "ink-color", type: "button", data: { recent: c }, "aria-label": "최근 색 " + c, "aria-pressed": String(pen.color === c),
            style: { background: c }, onclick: () => { closeInkPop(); choose({ color: c }); } }))) : null);
    } else {
      el.replaceChildren(h("div", { class: "seg ink-erase", role: "group", "aria-label": "지우개 방식" },
        ...[["eraser", "부분"], ["eraser-stroke", "획"]].map(([way, name]) => h("button", { type: "button", data: { erase: way }, "aria-pressed": String(pen.tool === way), text: name,
          onclick: () => { setSetting(store, "inkEraser", way === "eraser-stroke" ? "stroke" : "area"); closeInkPop(); setTool(way); } }))));
    }
  }

  // 색 원판: any colour (the wheel and the last eight); a colour of my own, or one picked from the
  // drawing (스포이트), fills it while it is the pen's.
  function inkWell() {
    const well = h("button", { class: "ink-color more" + (own ? " has" : ""), id: "ink-more", type: "button", "aria-label": own ? "고른 색 " + pen.color + " · 색 원판" : "색 더 고르기 (색 원판)",
      "aria-pressed": String(own && !erasing), style: own ? { "--well": pen.color } : {},
      onclick: () => {
        const anchor = colorNow.isConnected ? colorNow : inRail("#ink-color-now") || well;
        closeInkPop();
        openColorWheel({
          anchor,
          color: own ? pen.color : shown(pen.color),
          recent: getSettings(store).inkRecent || [],
          // While the finger moves only the pen and the colour dot change; the lift chooses it.
          onPick: (hex, done) => {
            if (done) return void choose({ color: hex });
            pen.color = hex;
            inRail("#ink-color-now")?.style.setProperty("--c", hex);
          },
          onRecent: (list) => setSetting(store, "inkRecent", list),
          alive: () => panel.isConnected && !panel.hidden && pen.tool === "pen",
        });
      } });
    return well;
  }

  // Beside the rail (or the piece it is in) at its button's height, on whichever side has room; above
  // or below a piece lying on its side; above the row in a card. Always inside the screen.
  function place(pop) {
    const a = pop.anchor.getBoundingClientRect();
    const stack = pop.anchor.closest(".ink-tools") || panel;
    const box = stack.getBoundingClientRect();
    const w = pop.el.offsetWidth;
    const ht = pop.el.offsetHeight;
    const turn = Number(stack.dataset.turn) || 0;
    if (rail && (turn === 0 || turn === 180)) {
      const right = box.right + 8;
      const left = box.left - 8 - w;
      const fitsRight = right + w <= innerWidth - 8;
      if (fitsRight || left >= 8) {
        pop.el.style.left = (fitsRight ? right : left) + "px";
        pop.el.style.top = Math.max(8, Math.min(innerHeight - ht - 8, a.top + a.height / 2 - ht / 2)) + "px";
        return;
      }
      // No room on either side (a piece put in the middle of a phone): above it or below it, never over
      // it (over it, the window covered the very button that opens and closes it).
    }
    pop.el.style.left = Math.max(8, Math.min(innerWidth - w - 8, a.left + a.width / 2 - w / 2)) + "px";
    const above = box.top - ht - 8;
    pop.el.style.top = (above >= 8 || !rail ? Math.max(8, above) : Math.min(innerHeight - ht - 8, box.bottom + 8)) + "px";
  }

  // An open window keeps up with the tools (the brush in the new colour, what is chosen).
  if (inkPop && inkPop.panel === panel) {
    const anchor = inRail(inkPop.kind === "brush" ? "#ink-brush-now" : inkPop.kind === "color" ? "#ink-color-now" : "#eraser");
    if (!anchor || (inkPop.kind === "erase" && !erasing)) closeInkPop();
    else {
      inkPop.anchor = anchor;
      anchor.setAttribute("aria-expanded", "true");
      inkPop.fill();
    }
  }
}

/**
 * The 올가미's few actions beside what it holds (the text room, 그림 방; the whiteboard's 올가미 for the
 * idea, kept to what drawings on a page want): 색, 복제 (beside it, held), 복사 (into 비서's 바구니, to
 * put into another room: carry(strokes)), 지우기, and ✕ to let go. What it holds is moved by drawing it
 * anywhere. commit(made) keeps a change ({ ops, atoms }, one undo).
 */
let lassoMenuNow = null;
export function lassoActions({ ink, doc, clock, by, commit, carry = null }) {
  let colours = false;
  const hide = () => {
    if (lassoMenuNow?.ink === ink) {
      lassoMenuNow.el.remove();
      lassoMenuNow = null;
    }
    colours = false;
  };
  function show(info) {
    if (!info) return hide();
    if (info.moving) return void (lassoMenuNow?.ink === ink && lassoMenuNow.el.classList.add("moving"));
    const ids = [...info.ids];
    const keep = (made, select) => {
      if (!made.ops.length) return;
      commit(made);
      const fresh = made.ops.filter((o) => o.t === "stroke").map((o) => o.id);
      if (select && fresh.length) {
        // A copy is held where it lies (beside the first), ready to be taken where it should go.
        const shiftBy = made.copied ? (v, i) => v + 300 : (v) => v;
        ink.setSelection(fresh, info.loop.map(shiftBy));
      } else ink.clearSelection();
    };
    const chip = (id, text, fn) => h("button", { class: "chip", id, type: "button", text, onclick: fn });
    const el = h("div", { class: "ink-lasso-menu", id: "ink-lasso-menu", role: "toolbar", "aria-label": "올가미로 고른 그림" },
      colours
        ? INK_COLORS.map((c) => h("button", { class: "ink-color", type: "button", data: { lassoInk: c }, "aria-label": c, style: { background: inkColor(c) },
            onclick: () => { colours = false; keep(recolorStrokesOps(clock, doc(), ids, c, by), true); } }))
        : [h("span", { class: "ink-lasso-count", text: `그림 ${ids.length}` }),
          chip("ink-lasso-color", "색", () => { colours = true; show(ink.selectionInfo()); }),
          chip("ink-lasso-copy", "복제", () => keep({ ...copyStrokesOps(clock, doc(), ids, 300, 300, by), copied: true }, true)),
          carry && chip("ink-lasso-carry", "복사", () => carry(carryStrokes(doc(), ids, ink.unitsPerPx()))),
          chip("ink-lasso-delete", "지우기", () => {
            const all = ids.map((id) => eraseOps(clock, doc(), id));
            keep({ ops: all.flatMap((m) => m.ops), atoms: all.flatMap((m) => m.atoms) }, false);
          }),
          h("button", { class: "icon-btn", id: "ink-lasso-off", type: "button", "aria-label": "올가미 풀기", onclick: () => ink.clearSelection() }, icon("close"))]);
    lassoMenuNow?.el.remove();
    lassoMenuNow = { ink, el };
    document.body.append(el);
    const r = info.rect;
    const w = el.offsetWidth;
    const ht = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(innerWidth - w - 8, (r.left + r.right) / 2 - w / 2)) + "px";
    el.style.top = (r.top - ht - 10 >= 8 ? r.top - ht - 10 : Math.min(innerHeight - ht - 8, r.bottom + 10)) + "px";
  }
  return { show, hide };
}

/** A whiteboard's drawings (in its units, from a copied group's corner) as strokes to carry: screen px at its own size. */
export function boardStrokesCarried(strokes) {
  return (strokes || []).map((s) => ({ ...s, pts: s.pts.map((v, i) => (i % 3 === 2 ? v : Math.round((v / BOARD_INK_UNIT) * 10) / 10)) }));
}

/**
 * 비서's 바구니 → this drawing (the day's plan 6.8): carried strokes put down in the middle of what shows
 * of it, at the size they were seen at, and held by the 올가미 so the finger takes them where they
 * should go (one undo). The room turns its 올가미 on first. Returns whether anything landed.
 */
export function landInk({ ink, doc, clock, by, commit }, carried) {
  if (!carried?.length) return false;
  const r = ink.host.getBoundingClientRect();
  const left = Math.max(r.left, 0);
  const right = Math.min(r.right, innerWidth);
  const top = Math.max(r.top, 0);
  const bottom = Math.min(r.bottom, innerHeight);
  const mx = right > left ? (left + right) / 2 : r.left + r.width / 2;
  const my = bottom > top ? (top + bottom) / 2 : r.top + r.height / 2;
  const [cx, cy] = ink.point({ clientX: mx, clientY: my, pointerType: "mouse", pressure: 0 });
  const unit = ink.unitsPerPx();
  const made = landStrokesOps(clock, doc(), carried, unit, cx, cy, by, ink.fixedInk ? fixedInk : (c) => c);
  if (!made.ops.length) return false;
  commit(made);
  const fresh = made.ops.filter((o) => o.t === "stroke");
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const op of fresh) {
    for (let i = 0; i < op.pts.length; i += 3) {
      x0 = Math.min(x0, op.pts[i]); x1 = Math.max(x1, op.pts[i]);
      y0 = Math.min(y0, op.pts[i + 1]); y1 = Math.max(y1, op.pts[i + 1]);
    }
  }
  const pad = 12 * unit;
  ink.setSelection(fresh.map((o) => o.id), [x0 - pad, y0 - pad, x1 + pad, y0 - pad, x1 + pad, y1 + pad, x0 - pad, y1 + pad]);
  return true;
}

/** The one small tools window open now (brushes, colours or the eraser's way). */
// 빠른 굵기 put in by hand (held): [px for the first button, the second, the third], 0 = its own width.
const QUICK = "inkQuick";
function quickSizes(store) {
  const v = store.get(QUICK, null);
  return Array.isArray(v) ? [0, 1, 2].map((i) => (Number.isFinite(v[i]) && v[i] >= SIZE_MIN && v[i] <= SIZE_MAX ? v[i] : 0)) : [0, 0, 0];
}
function setQuickSize(store, i, px) {
  const v = quickSizes(store);
  v[i] = Math.round(px * 10) / 10;
  store.set(QUICK, v);
}
// A size as the dot that shows it on its button (a doubling scale, within the button).
const dotRem = (px) => Math.max(0.24, Math.min(1.1, 0.22 + 0.17 * Math.log2(Math.max(1, px))));

/** Held a moment, a button does `act` instead of its tap (its click that follows is let go). */
function holdToSet(button, act, ms = 450) {
  let timer = 0;
  let at = null;
  button.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    at = [e.clientX, e.clientY];
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.dataset.held = "1";
      try { navigator.vibrate?.(10); } catch { /* not every device buzzes */ }
      act();
    }, ms);
  });
  button.addEventListener("pointermove", (e) => { if (at && Math.hypot(e.clientX - at[0], e.clientY - at[1]) > 10) clearTimeout(timer); });
  for (const end of ["pointerup", "pointercancel", "pointerleave"]) button.addEventListener(end, () => clearTimeout(timer));
  button.addEventListener("contextmenu", (e) => e.preventDefault());
}

/** A colour as [r, g, b] (a "#rrggbb", or anything a canvas understands). */
function rgbOfCss(css) {
  let hex = /^#[0-9a-f]{6}$/i.test(css) ? css : null;
  if (!hex) {
    const g = document.createElement("canvas").getContext("2d");
    if (g) {
      g.fillStyle = "#000000";
      g.fillStyle = css;
      hex = g.fillStyle;
    }
  }
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

/** The bar at the top while a fill is held: 채우는 정도 and how much, in my colour. */
function showFillAmount(tol) {
  let bar = document.getElementById("fill-amount");
  if (!bar) {
    bar = h("div", { class: "fill-amount", id: "fill-amount", role: "status" },
      h("span", { class: "fill-amount-name", text: "채우는 정도" }),
      h("span", { class: "fill-amount-track", "aria-hidden": "true" }, h("span", { class: "fill-amount-level" })),
      h("b", { class: "fill-amount-num" }));
    document.body.append(bar);
  }
  const pct = Math.round((tol / 255) * 100);
  bar.style.setProperty("--k", String(tol / 255));
  bar.dataset.amount = String(pct);
  bar.querySelector(".fill-amount-num").textContent = pct + "%";
}

/**
 * 채우는 정도 (Procreate's ColorDrop Threshold): a fill held where it lands. What it would take shows
 * on the layer in the colour and a bar at the top says how much; the finger slid right takes in more
 * alike colours, left fewer; let go, it is filled there, and the amount is kept for the next fill.
 */
function holdFill(layer, x, y) {
  const from = fillTol;
  let tol = from;
  let frame = 0;
  const show = () => {
    frame = 0;
    showFillAmount(tol);
    layer.fillPreview(x, y, tol);
  };
  show();
  try { navigator.vibrate?.(8); } catch { /* not every device buzzes */ }
  return {
    at: [x, y],
    move(cx) {
      const next = clampTol(from + (cx - x) * TOL_PER_PX);
      if (next === tol) return;
      tol = next;
      if (!frame) frame = requestAnimationFrame(show);
    },
    /** keep: fill (the finger let go); else only put it away. True when it filled. */
    end(keep) {
      cancelAnimationFrame(frame);
      document.getElementById("fill-amount")?.remove();
      if (!keep) {
        layer.endFillPreview();
        return false;
      }
      setFillTol(tol);
      layer.fillAt({ clientX: x, clientY: y }, tol);
      return true;
    },
  };
}

// 바로 전 색: the pen's colour as this device last saw it, and the one before (any room's; so it is the
// colour last drawn with anywhere). Every change of colour comes back through drawInkTools.
function notePenColor(store, c) {
  if (!c) return;
  const s = getSettings(store);
  if (s.inkLast === c) return;
  store.set("settings", { ...s, inkPrev: s.inkLast || null, inkLast: c });
}

const PREV_HOLD_MS = 450;
const DRAG_PX = 10;
// A hold's lift is no tap: the swap makes the rail again, so the click that ends the hold may come to
// the new colour button (where the finger is), which would open the colours. Until a moment after
// that lift, no colour button takes a click.
let quietColourTap = 0;

/**
 * The colour button's own touches, as Procreate's colour button. Held still a moment: swap() (바로 전
 * 색); the tap that ends it opens nothing. Dragged out (no waiting first), 컬러드롭: a drop of the colour
 * follows the finger, its tip where it will land; let go, it fills there (drop(x, y) gives the layer
 * under it, or null) and a ring spreads; held still on the drawing first, 채우는 정도 (holdFill). A short
 * tap is still the colour window; let go off the drawing, nothing happens. Without drop (a room that
 * does not fill), a drag is nothing.
 */
function wireColorButton(btn, { colourOf, drop = null, swap = null }) {
  let g = null;
  btn.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const id = e.pointerId;
    g = { id, x0: e.clientX, y0: e.clientY, bead: null };
    g.timer = setTimeout(() => {
      if (!g || g.id !== id || g.bead) return;
      g = null;
      btn.dataset.held = "1";
      quietColourTap = Infinity;
      const lifted = () => {
        quietColourTap = performance.now() + 450;
        removeEventListener("pointerup", lifted, true);
        removeEventListener("pointercancel", lifted, true);
      };
      addEventListener("pointerup", lifted, true);
      addEventListener("pointercancel", lifted, true);
      try { navigator.vibrate?.(10); } catch { /* not every device buzzes */ }
      swap?.();
    }, PREV_HOLD_MS);
  });
  btn.addEventListener("pointermove", (e) => {
    if (!g || e.pointerId !== g.id) return;
    if (!g.bead) {
      if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) <= DRAG_PX) return;
      clearTimeout(g.timer);
      if (!drop) return void (g = null);
      g.colour = colourOf();
      g.bead = h("div", { class: "color-drop", id: "color-drop", "aria-hidden": "true", style: { "--c": g.colour, left: e.clientX + "px", top: e.clientY + "px" } });
      document.body.append(g.bead);
      btn.dataset.held = "1";
      try { btn.setPointerCapture(g.id); } catch { /* fine */ }
      try { navigator.vibrate?.(10); } catch { /* not every device buzzes */ }
    }
    if (g.hold) return void g.hold.move(e.clientX);
    g.bead.style.left = e.clientX + "px";
    g.bead.style.top = e.clientY + "px";
    // Held still on the drawing: 채우는 정도 there.
    if (g.still && Math.hypot(e.clientX - g.still[0], e.clientY - g.still[1]) <= 6) return;
    const at = (g.still = [e.clientX, e.clientY]);
    const mine = g;
    clearTimeout(g.stillTimer);
    g.stillTimer = setTimeout(() => {
      if (g !== mine || g.hold || g.still !== at) return;
      const layer = drop(at[0], at[1]);
      if (!layer) return;
      g.bead.classList.add("landed");
      g.hold = holdFill(layer, at[0], at[1]);
    }, FILL_HOLD_MS);
  });
  const end = (e, landed) => {
    if (!g || e.pointerId !== g.id) return;
    clearTimeout(g.timer);
    clearTimeout(g.stillTimer);
    const { bead, colour, hold } = g;
    g = null;
    if (!bead) return;
    bead.remove();
    let at = [e.clientX, e.clientY];
    if (hold) {
      if (!hold.end(landed)) return;
      at = hold.at;
    } else {
      const layer = landed ? drop(e.clientX, e.clientY) : null;
      if (!layer) return;
      layer.fillAt({ clientX: e.clientX, clientY: e.clientY });
    }
    const ring = h("div", { class: "color-drop-ring", "aria-hidden": "true", style: { "--c": colour, left: at[0] + "px", top: at[1] + "px" } });
    document.body.append(ring);
    setTimeout(() => ring.remove(), 600);
  };
  btn.addEventListener("pointerup", (e) => end(e, true));
  btn.addEventListener("pointercancel", (e) => end(e, false));
  // The tap that ends a drop does not open the colour window.
  btn.addEventListener("click", (e) => {
    if (!btn.dataset.held && performance.now() >= quietColourTap) return;
    delete btn.dataset.held;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
}

// The rail keeps between the room's top bar and what lies along its foot (the 애니메이션 방's frames and
// buttons, a toolbar), centred in that band, never over them (the owner, 27 November: "애니메이션 방 ui
// 겹친다": on a phone the rail stood in the middle of the whole screen and its foot lay over the
// frames' ‹, so a tap meant for ‹ pressed the rail). The band is measured, as bars differ by room.
const RAIL_GAP = 8;

/** Keeps a room's rail in the band between its bars; returns what stops it. */
export function keepRailBetween(panel) {
  const room = panel.parentElement;
  if (!room) return () => {};
  panel.classList.add("between");
  let frame = 0;
  const measure = () => {
    frame = 0;
    if (!panel.isConnected) return;
    const { top, foot } = railBand(room);
    const band = Math.max(80, foot - top - RAIL_GAP * 2);
    panel.style.setProperty("--rail-max", band + "px");
    // A short screen: the size bar gives way first, so every tool is in view without scrolling.
    const bar = panel.querySelector(".size-rail");
    const stack = panel.querySelector(":scope > .ink-stack") || panel;
    panel.style.removeProperty("--size-h");
    if (bar) {
      const over = stack.scrollHeight - stack.clientHeight;
      if (over > 0) panel.style.setProperty("--size-h", Math.max(56, bar.offsetHeight - over - 2) + "px");
    }
    const tall = Math.min(band, panel.offsetHeight);
    panel.style.setProperty("--rail-y", Math.round(top + RAIL_GAP + (band - tall) / 2) + "px");
  };
  const soon = () => { if (!frame) frame = requestAnimationFrame(measure); };
  const watch = new ResizeObserver(soon);
  watch.observe(panel);
  for (const el of room.children) if (el.matches?.(RAIL_TOP + ", " + RAIL_FOOT)) watch.observe(el);
  addEventListener("resize", soon);
  measure();
  return () => {
    cancelAnimationFrame(frame);
    watch.disconnect();
    removeEventListener("resize", soon);
    panel.classList.remove("between");
  };
}

let inkPop = null;
let picking = false;
/** Whether two fingers are picking a colour now (the zooms that two fingers make hold still meanwhile). */
export const pickingNow = () => picking;

/**
 * 스포이트 (the owner, 27 November: "손가락 대고 가만히 두면 스포이드가 되는데 두 손가락으로 꾹 누르기
 * 하자"): two fingers that land together on el and stay still a moment pick the colour between them.
 * A loupe above that point shows it (the upper half what is picked, the lower the colour now); the
 * fingers moved together, it reads as they go, and the page neither zooms nor moves; one finger
 * lifted, the colour is the brush's (the layer's onPick). A third finger stops it, taking nothing.
 * Fingers that moved first (a zoom) and then rest, or came down one after the other (a line and then a
 * finger), are no pick, nor are they while a pen is on the glass (a resting palm).
 * layerAt(x, y) gives the InkLayer drawing at that point of the screen, or null where nothing would
 * be drawn now (a room with its pen off). Returns stop().
 */
export function watchPick(el, layerAt, { hold = 450, slop = 10, together = 300 } = {}) {
  const fingers = new Map(); // touch pointerId → { from: [x, y], at: [x, y] }
  const pens = new Set();
  let first = 0;
  let timer = 0;
  let pick = null; // { layer, loupe, picked }
  const quiet = () => { clearTimeout(timer); timer = 0; };
  const middle = () => {
    const [a, b] = [...fingers.values()].map((f) => f.at);
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  const begin = () => {
    timer = 0;
    if (fingers.size !== 2 || pens.size || !el.isConnected) return;
    const [x, y] = middle();
    const layer = layerAt(x, y);
    if (!layer?.tool || !layer.onPick) return;
    // A line the first finger began is put away first (the second finger already stopped it), so
    // its dot is not what is picked.
    layer.cancelTouch?.();
    const loupe = h("div", { class: "loupe", "aria-hidden": "true" });
    loupe.style.setProperty("--cur", inkColor(layer.color, layer.fixedInk));
    document.body.append(loupe);
    pick = { layer, loupe, picked: null };
    picking = true;
    follow();
  };
  const follow = () => {
    const [x, y] = middle();
    const color = pick.layer.readColor(x, y);
    pick.picked = color;
    pick.loupe.style.setProperty("--pick", color || "transparent");
    pick.loupe.classList.toggle("bare", !color);
    // Above the fingers, so they do not hide it; below them near the top of the screen.
    pick.loupe.style.left = x + "px";
    pick.loupe.style.top = (y > 110 ? y - 78 : y + 78) + "px";
  };
  const finish = (take) => {
    if (!pick) return;
    const { layer, loupe, picked } = pick;
    pick = null;
    picking = false;
    loupe.remove();
    if (take && picked) layer.onPick(picked);
  };
  const press = (e) => {
    if (e.pointerType === "pen") {
      pens.add(e.pointerId);
      quiet();
      return;
    }
    if (e.pointerType !== "touch") return;
    if (!fingers.size) first = e.timeStamp;
    fingers.set(e.pointerId, { from: [e.clientX, e.clientY], at: [e.clientX, e.clientY] });
    quiet();
    if (fingers.size > 2) return void finish(false);
    if (fingers.size === 2 && !pick && !pens.size && e.timeStamp - first <= together) {
      for (const f of fingers.values()) f.from = f.at.slice();
      timer = setTimeout(begin, hold);
    }
  };
  const move = (e) => {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    f.at = [e.clientX, e.clientY];
    if (pick) return void follow();
    if (timer && Math.hypot(f.at[0] - f.from[0], f.at[1] - f.from[1]) > slop) quiet();
  };
  const lift = (e) => {
    pens.delete(e.pointerId);
    if (!fingers.has(e.pointerId)) return;
    fingers.delete(e.pointerId);
    quiet();
    finish(e.type === "pointerup");
  };
  el.addEventListener("pointerdown", press, true);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", lift, true);
  window.addEventListener("pointercancel", lift, true);
  return function stop() {
    quiet();
    finish(false);
    el.removeEventListener("pointerdown", press, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", lift, true);
    window.removeEventListener("pointercancel", lift, true);
  };
}

export function closeInkPop() {
  const pop = inkPop;
  inkPop = null;
  pop?.close();
  for (const b of pop?.panel?.querySelectorAll("[aria-expanded]") || []) b.setAttribute("aria-expanded", "false");
}
