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
// Used by the text room and the whiteboard.

import { h, iconButton } from "./dom.js";
import { getSettings, setSetting } from "../identity.js";
import { INK_COLORS, thinPoints, brushOf } from "../core/ink.js";
import { brushLook, strokePoints, outline, dabs, hasPressure, wobble, quickShape, adjustShape, LazyBrush, sketchLines, crayonMarks, chalkAlpha, chalkTurn, fingerFeel, fingerStep } from "../core/brush.js";
import { LIGHT_MS } from "./live-ink.js";
import { currentTheme } from "./theme.js";
import { INK } from "../core/paint.js";

const COLORS = {
  red: "#e5484d", orange: "#f2802a", yellow: "#e8b422", green: "#2f9e5b", blue: "#2f7bf0", indigo: "#4b4fd8", violet: "#9a4fd8",
};
/** Pixel width of each size at 1 rem = 16 px. */
const WIDTHS = { 1: 2, 2: 4, 3: 8 };
/** The brushes in the tools, in this order. */
export const BRUSH_NAMES = [["pen", "펜"], ["fountain", "만년필"], ["brushpen", "붓펜"], ["pencil", "연필"], ["sketch", "스케치"], ["crayon", "크레용"], ["marker", "마커"], ["airbrush", "에어브러시"], ["highlighter", "형광펜"]];
/** 손떨림 보정's string, in screen pixels, for 끔 · 약 · 중 · 강. */
const STEADY_PX = [0, 6, 14, 26];
export const STEADY_NAMES = ["끔", "약", "중", "강"];
/** How long a line is held still before it becomes a shape. */
const SHAPE_HOLD_MS = 600;

export function inkColor(c) {
  if (c === "black") return INK[currentTheme()];
  return COLORS[c] || c;
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
export function paintStroke(g, pts, color, width, brush, shaped = false) {
  if (!pts || pts.length < 3) return;
  const look = brushLook(brush);
  const size = (WIDTHS[width] || 4) * (100 / 16) * look.scale;
  const erase = brush === "erase";
  const ink = erase ? "#000" : inkColor(color);
  const real = hasPressure(pts);
  const points = strokePoints(pts, { streamline: shaped ? 0 : look.streamline });
  g.save();
  g.globalCompositeOperation = erase ? "destination-out" : "source-over";
  if (look.kind === "sketch") {
    // 스케치: the line itself, fine and pencil-dark, then faint strokes joining its near points.
    const poly = outline(points, { size: size * 0.55, thinning: real ? 0.5 : 0, taperStart: 0, taperEnd: size * 1.5 });
    g.globalAlpha = look.alpha;
    g.fillStyle = ink;
    fillOutline(g, poly);
    const seg = sketchLines(points, { reach: size * 9, seed: (pts[0] * 31 + pts[1]) | 0 });
    if (seg.length) {
      g.globalAlpha = 0.22;
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
   * onPick(color): a finger held still at the start of a line picks the colour under it (스포이트,
   * as in Procreate); pick(clientX, clientY) reads that colour ("#rrggbb" or null for bare
   * paper), by default from this layer's own picture.
   */
  constructor({ host, ink, onStroke, onErase, blocked = () => false, room = () => 0, view = null, shapes = () => true, onShape = () => {}, grow = true, maxPixels = Infinity, share = null, steady = () => 0, onPick = null, pick = null }) {
    this.host = host;
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
    this.brush = "pen";
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
    this.tool = tool;
    this.canvas.classList.toggle("on", !!tool);
    this.host.classList.toggle("inking", !!tool);
    this.canvas.dataset.tool = tool || "";
  }

  setStyle({ color, width, brush }) {
    if (color) this.color = color;
    if (width) this.width = width;
    if (brush) this.brush = brush;
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
    clearTimeout(this.live.pickTimer);
    if (this.live.picking) this.loupe?.remove();
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
      } else {
        const first = this.point(e);
        const brush = this.tool === "eraser" ? "erase" : this.brush;
        // A finger presses as a pen would: from the hand's speed, kept in the line (a pen gives its own).
        const feel = e.pointerType === "touch" && brush !== "erase" ? fingerFeel(e.clientX, e.clientY, e.timeStamp) : null;
        if (feel) first[2] = Math.round(feel.p * 100);
        const level = Math.max(0, Math.min(3, this.steady() | 0));
        const string = STEADY_PX[level] * this.unitsPerPx();
        this.live = { pointer: e.pointerId, kind: e.pointerType, pts: first, brush, feel, lazy: string > 0 ? new LazyBrush(string, first[0], first[1]) : null, hand: first.slice(0, 2), rope: level >= 2, down: [e.clientX, e.clientY] };
        // 스포이트: a finger held still where it went down picks the colour there (not a pen,
        // which often rests a moment before it draws; not the erasers).
        if (this.onPick && e.pointerType === "touch" && brush !== "erase") {
          const live = this.live;
          live.pickTimer = setTimeout(() => this.startPick(live), 450);
        }
        // Friends see the line from its first point (the eraser's rubbing shows when it is done).
        if (this.share && brush !== "erase") {
          this.share.begin("ink", { c: this.color, w: this.width, b: brush });
          this.share.grow("ink", this.live.pts);
        }
        this.render();
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.live || e.pointerId !== this.live.pointer) return;
      if (this.live.erase) return void this.eraseAt(e);
      const live = this.live;
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
      if (live.picking) return void this.movePick(e.clientX, e.clientY);
      if (live.pickTimer && Math.hypot(e.clientX - live.down[0], e.clientY - live.down[1]) > 6) {
        clearTimeout(live.pickTimer);
        live.pickTimer = 0;
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
      const live = this.live;
      if (live.light) {
        this.live = null;
        if (this.light) this.light.ended = performance.now();
        this.share?.end("laser");
        return void this.renderSoon();
      }
      clearTimeout(live.pickTimer);
      if (live.picking) {
        this.live = null;
        this.loupe?.remove();
        this.loupe = null;
        if (e.type === "pointerup" && live.picked) this.onPick?.(live.picked);
        return void this.render();
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
      // An eraser's stroke has no colour of its own; it keeps a neutral one.
      if (shape) opId = this.onStroke({ pts: shape.pts, color: this.color, width: this.width, brush: live.brush, shape: true });
      else if (live?.pts && live.pts.length >= 3) opId = this.onStroke({ pts: live.pts, color: live.brush === "erase" ? "black" : this.color, width: this.width, brush: live.brush });
      if (live?.pts && live.brush !== "erase") this.share?.end("ink", typeof opId === "string" ? opId : null);
      this.render();
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    // Losing hold of the pointer without a lift also ends the line, so it never waits forever.
    c.addEventListener("lostpointercapture", end);
  }

  /** Held still: the line's first dot goes, and the loupe shows the colour under the finger. */
  startPick(live) {
    if (this.live !== live || live.shape) return;
    live.picking = true;
    live.pickTimer = 0;
    live.pts = null;
    this.share?.end("ink", null);
    // The dot the touch began is taken off the picture first, so it is not what is picked.
    this.render();
    this.loupe = h("div", { class: "loupe", "aria-hidden": "true" });
    this.loupe.style.setProperty("--cur", inkColor(this.color));
    document.body.append(this.loupe);
    this.movePick(live.down[0], live.down[1]);
  }

  movePick(x, y) {
    const live = this.live;
    if (!live?.picking || !this.loupe) return;
    const color = this.readColor(x, y);
    live.picked = color;
    this.loupe.style.setProperty("--pick", color || "transparent");
    this.loupe.classList.toggle("bare", !color);
    // Above the finger, so the finger does not hide it; below it near the top of the screen.
    this.loupe.style.left = x + "px";
    this.loupe.style.top = (y > 110 ? y - 78 : y + 78) + "px";
  }

  /** The colour drawn at a point of the screen ("#rrggbb"), or null where nothing is drawn. */
  readColor(x, y) {
    if (this.pickAt) return this.pickAt(x, y);
    return pixelAt(this.canvas, x, y);
  }

  /** A point from the hand: with 손떨림 보정 the brush follows on its string, and only its moves count. */
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
    const key = [this.ink().version, w, hgt, t.a, t.b, t.c, t.d, t.e, t.f, shift ? `${shift.dx},${shift.dy},${shift.ids.size}` : "", currentTheme()].join("|");
    // The picture belongs to one drawing (a layer can be pointed at another one: 애니메이션 방's frames).
    if (!this.kept || this.kept.key !== key || this.kept.doc !== this.ink()) {
      const pic = this.kept?.canvas || document.createElement("canvas");
      pic.width = w;
      pic.height = hgt;
      const pg = pic.getContext("2d");
      pg.setTransform(t);
      for (const s of this.ink().strokes()) {
        const pts = shift && shift.ids.has(s.id) ? s.pts.map((v, i) => (i % 3 === 0 ? v + shift.dx : i % 3 === 1 ? v + shift.dy : v)) : s.pts;
        this.paint(pg, pts, s.c, s.w, brushOf(s), !!s.q);
      }
      this.kept = { key, canvas: pic, doc: this.ink() };
    }
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.kept.canvas, 0, 0);
    g.restore();
    // The line being drawn as it will be kept (the same points), or the shape it became.
    const live = this.live;
    if (live?.shapeNow) this.paint(g, live.shapeNow.pts, this.color, this.width, live.brush, true);
    else if (live?.pts) this.paint(g, thinPoints(live.pts), this.color, this.width, live.brush);
    // 손떨림 보정 (중·강): the string from the hand to the brush, so the lag reads as a pull.
    if (live?.lazy && live.rope && !live.shape) this.paintRope(g, live);
    // Friends' lines as they draw them, in their brushes; their pen with their colour and name.
    const tips = [];
    for (const line of this.share?.lines() || []) {
      this.paint(g, line.pts, line.c, line.w, line.b);
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
    if (glowing) this.renderSoon();
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

  paint(g, pts, color, width, brush, shaped = false) {
    paintStroke(g, pts, color, width, brush, shaped);
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.share?.detach(this);
    this.canvas.remove();
  }
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
    if (brush === "sketch") {
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
    paintStroke(g, pts, color, Math.min(width, 2), brush);
  };
  // Its size is fixed, so it is painted at once (a frame may never come to a screen in the back).
  draw();
  return canvas;
}

/**
 * The drawing tools (펜·만년필·붓펜·연필·마커·에어브러시·형광펜, 지우개 부분/획, eight colours, three widths,
 * 모양 잡기), the same in the text room and on the whiteboard. pen: { tool, brush, color, width };
 * setTool(tool) applies a change. Hidden while no tool is on. Each brush shows a little line of
 * itself in the chosen colour, its name beneath.
 */
export function drawInkTools(panel, { pen, setTool, store }) {
  panel.hidden = !pen.tool;
  if (!pen.tool) return;
  const erasing = pen.tool === "eraser" || pen.tool === "eraser-stroke";
  const pointing = pen.tool === "laser";
  const steady = Math.max(0, Math.min(3, getSettings(store).inkSteady ?? 1));
  const eraserKind = () => (getSettings(store).inkEraser === "stroke" ? "eraser-stroke" : "eraser");
  const choose = (patch) => { Object.assign(pen, patch); setTool("pen"); };
  const shapes = getSettings(store).inkShapes !== false;
  const brushes = h("div", { class: "ink-brushes", role: "group", "aria-label": "붓" },
    ...BRUSH_NAMES.map(([b, name]) => h("button", { class: "ink-brush", type: "button", data: { brush: b }, "aria-pressed": String(pen.tool === "pen" && pen.brush === b), "aria-label": name,
      onclick: () => { setSetting(store, "inkBrush", b); choose({ brush: b }); } },
      brushPreview(b, pen.color, pen.width), h("span", { class: "ink-brush-name", text: name }))));
  panel.replaceChildren(
    h("div", { class: "ink-row ink-row-brushes" },
      brushes,
      iconButton("ink-laser", "laser", "가리키기 (친구 화면에 빛으로, 남지 않아요)", () => setTool(pointing ? "pen" : "laser")),
      iconButton("eraser", "eraser", "지우개", () => setTool(erasing ? "pen" : eraserKind())),
      erasing && h("div", { class: "seg ink-erase", role: "group", "aria-label": "지우개 방식" },
        ...[["eraser", "부분"], ["eraser-stroke", "획"]].map(([kind, name]) => h("button", { type: "button", data: { erase: kind }, "aria-pressed": String(pen.tool === kind), text: name,
          onclick: () => { setSetting(store, "inkEraser", kind === "eraser-stroke" ? "stroke" : "area"); setTool(kind); } })))),
    h("div", { class: "ink-row" },
      ...INK_COLORS.map((c) => h("button", { class: "ink-color", type: "button", data: { ink: c }, "aria-label": c, "aria-pressed": String(!erasing && pen.color === c),
        style: { background: inkColor(c) }, onclick: () => choose({ color: c }) })),
      // A colour picked from the drawing (스포이트) shows beside them while it is the pen's.
      typeof pen.color === "string" && pen.color.startsWith("#") && h("button", { class: "ink-color custom", id: "ink-picked", type: "button", "aria-label": "고른 색 " + pen.color, "aria-pressed": String(!erasing),
        style: { background: pen.color }, onclick: () => choose({ color: pen.color }) }),
      ...[1, 2, 3].map((w) => h("button", { class: "ink-width", type: "button", data: { width: String(w) }, "aria-label": "굵기 " + w, "aria-pressed": String(pen.width === w),
        onclick: () => { pen.width = w; setTool(pen.tool); } }, h("span", { style: { width: 0.2 + w * 0.18 + "rem", height: 0.2 + w * 0.18 + "rem" } }))),
      h("button", { class: "ink-shapes chip", id: "ink-shapes", type: "button", "aria-pressed": String(shapes), title: "그리고 잠깐 멈추면 반듯한 선·동그라미·네모로",
        onclick: () => { setSetting(store, "inkShapes", !shapes); setTool(pen.tool); } }, "모양 잡기"),
      h("button", { class: "ink-steady chip", id: "ink-steady", type: "button", "aria-pressed": String(steady > 0), "aria-label": "손떨림 보정: " + STEADY_NAMES[steady], title: "손떨림 보정: 손이 떨려도 선이 매끈하게 (누를 때마다 약·중·강·끔)",
        onclick: () => { setSetting(store, "inkSteady", (steady + 1) % 4); setTool(pen.tool); } }, "보정 " + STEADY_NAMES[steady])));
  panel.querySelector("#eraser").setAttribute("aria-pressed", String(erasing));
  panel.querySelector("#ink-laser").setAttribute("aria-pressed", String(pointing));
  // The chosen brush in view (the row slides sideways on a narrow screen, and says so). Done at
  // once, not a frame later: a frame later it could slide the row away under a finger already
  // reaching for another brush.
  brushes.classList.toggle("more", brushes.scrollWidth > brushes.clientWidth + 1);
  const chosen = brushes.querySelector('[aria-pressed="true"]');
  if (chosen) {
    const r = chosen.getBoundingClientRect();
    const box = brushes.getBoundingClientRect();
    if (r.left < box.left || r.right > box.right) chosen.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }
}
