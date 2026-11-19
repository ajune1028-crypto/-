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
import { brushLook, strokePoints, outline, dabs, hasPressure, wobble, quickShape, adjustShape } from "../core/brush.js";
import { currentTheme } from "./theme.js";
import { INK } from "../core/paint.js";

const COLORS = {
  red: "#e5484d", orange: "#f2802a", yellow: "#e8b422", green: "#2f9e5b", blue: "#2f7bf0", indigo: "#4b4fd8", violet: "#9a4fd8",
};
/** Pixel width of each size at 1 rem = 16 px. */
const WIDTHS = { 1: 2, 2: 4, 3: 8 };
/** The brushes in the tools, in this order. */
export const BRUSH_NAMES = [["pen", "펜"], ["fountain", "만년필"], ["brushpen", "붓펜"], ["pencil", "연필"], ["marker", "마커"], ["airbrush", "에어브러시"], ["highlighter", "형광펜"]];
/** How long a line is held still before it becomes a shape. */
const SHAPE_HOLD_MS = 600;

export function inkColor(c) {
  if (c === "black") return INK[currentTheme()];
  return COLORS[c] || c;
}

const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

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
  if (look.kind === "dabs") {
    const marks = dabs(points, { step: size * look.spacing });
    const seed = (pts[0] * 31 + pts[1]) | 0;
    if (look.soft) {
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
  constructor({ host, ink, onStroke, onErase, blocked = () => false, room = () => 0, view = null, shapes = () => true, onShape = () => {} }) {
    this.host = host;
    this.shapes = shapes;
    this.onShape = onShape;
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
      } else {
        this.live = { pointer: e.pointerId, kind: e.pointerType, pts: this.point(e), brush: this.tool === "eraser" ? "erase" : this.brush };
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
      // Every point the pen passed (not only one per frame), drawn at the next frame: the line
      // keeps up with the pen however fast it goes.
      for (const ev of e.getCoalescedEvents?.() || [e]) live.pts.push(...this.point(ev));
      this.holdForShape(e);
      this.renderSoon();
    });
    const end = (e) => {
      if (!this.live || e.pointerId !== this.live.pointer) return;
      if (e.type === "pointerup" && !this.live.erase) for (const ev of e.getCoalescedEvents?.() || []) this.live.pts.push(...this.point(ev));
      const live = this.live;
      this.live = null;
      clearTimeout(live?.timer);
      const shape = live?.shapeNow || live?.shape;
      // An eraser's stroke has no colour of its own; it keeps a neutral one.
      if (shape) this.onStroke({ pts: shape.pts, color: this.color, width: this.width, brush: live.brush, shape: true });
      else if (live?.pts && live.pts.length >= 3) this.onStroke({ pts: live.pts, color: live.brush === "erase" ? "black" : this.color, width: this.width, brush: live.brush });
      this.render();
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    // Losing hold of the pointer without a lift also ends the line, so it never waits forever.
    c.addEventListener("lostpointercapture", end);
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
    if (!this.view) this.grow();
    const rect = c.getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
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
    if (!this.kept || this.kept.key !== key) {
      const pic = this.kept?.canvas || document.createElement("canvas");
      pic.width = w;
      pic.height = hgt;
      const pg = pic.getContext("2d");
      pg.setTransform(t);
      for (const s of this.ink().strokes()) {
        const pts = shift && shift.ids.has(s.id) ? s.pts.map((v, i) => (i % 3 === 0 ? v + shift.dx : i % 3 === 1 ? v + shift.dy : v)) : s.pts;
        this.paint(pg, pts, s.c, s.w, brushOf(s), !!s.q);
      }
      this.kept = { key, canvas: pic };
    }
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.kept.canvas, 0, 0);
    g.restore();
    // The line being drawn as it will be kept (the same points), or the shape it became.
    const live = this.live;
    if (live?.shapeNow) this.paint(g, live.shapeNow.pts, this.color, this.width, live.brush, true);
    else if (live?.pts) this.paint(g, thinPoints(live.pts), this.color, this.width, live.brush);
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
    this.canvas.remove();
  }
}

/** A small line drawn with the brush, as it will look (pressure rising and falling, as a hand does). */
function brushPreview(brush, color, width) {
  const canvas = h("canvas", { class: "ink-preview", "aria-hidden": "true" });
  const draw = () => {
    const w = 46;
    const ht = 18;
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(ht * ratio);
    const g = canvas.getContext("2d");
    if (!g) return;
    // Stroke units: 100 to a rem (16 px), so 1 unit = 0.16 px.
    const k = 0.16 * ratio;
    g.setTransform(k, 0, 0, k, 0, 0);
    const pts = [];
    const n = 24;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push(Math.round(30 + t * 228), Math.round(56 + Math.sin(t * Math.PI * 2) * 26), Math.round(25 + 70 * Math.sin(t * Math.PI)));
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
  const erasing = pen.tool !== "pen";
  const eraserKind = () => (getSettings(store).inkEraser === "stroke" ? "eraser-stroke" : "eraser");
  const choose = (patch) => { Object.assign(pen, patch); setTool("pen"); };
  const shapes = getSettings(store).inkShapes !== false;
  const brushes = h("div", { class: "ink-brushes", role: "group", "aria-label": "붓" },
    ...BRUSH_NAMES.map(([b, name]) => h("button", { class: "ink-brush", type: "button", data: { brush: b }, "aria-pressed": String(!erasing && pen.brush === b), "aria-label": name,
      onclick: () => { setSetting(store, "inkBrush", b); choose({ brush: b }); } },
      brushPreview(b, pen.color, pen.width), h("span", { class: "ink-brush-name", text: name }))));
  panel.replaceChildren(
    h("div", { class: "ink-row ink-row-brushes" },
      brushes,
      iconButton("eraser", "eraser", "지우개", () => setTool(erasing ? "pen" : eraserKind())),
      h("button", { class: "ink-shapes chip", id: "ink-shapes", type: "button", "aria-pressed": String(shapes), title: "그리고 잠깐 멈추면 반듯한 선·동그라미·네모로",
        onclick: () => { setSetting(store, "inkShapes", !shapes); setTool(pen.tool); } }, "모양 잡기"),
      erasing && h("div", { class: "seg ink-erase", role: "group", "aria-label": "지우개 방식" },
        ...[["eraser", "부분"], ["eraser-stroke", "획"]].map(([kind, name]) => h("button", { type: "button", data: { erase: kind }, "aria-pressed": String(pen.tool === kind), text: name,
          onclick: () => { setSetting(store, "inkEraser", kind === "eraser-stroke" ? "stroke" : "area"); setTool(kind); } })))),
    h("div", { class: "ink-row" },
      ...INK_COLORS.map((c) => h("button", { class: "ink-color", type: "button", data: { ink: c }, "aria-label": c, "aria-pressed": String(!erasing && pen.color === c),
        style: { background: inkColor(c) }, onclick: () => choose({ color: c }) })),
      ...[1, 2, 3].map((w) => h("button", { class: "ink-width", type: "button", data: { width: String(w) }, "aria-label": "굵기 " + w, "aria-pressed": String(pen.width === w),
        onclick: () => { pen.width = w; setTool(pen.tool); } }, h("span", { style: { width: 0.2 + w * 0.18 + "rem", height: 0.2 + w * 0.18 + "rem" } })))));
  panel.querySelector("#eraser").setAttribute("aria-pressed", String(erasing));
  // The chosen brush in view (the row scrolls sideways on a narrow screen).
  requestAnimationFrame(() => brushes.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" }));
}
