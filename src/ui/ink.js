// A drawing layer over any surface: a canvas that shows an InkDoc's strokes
// and, while a tool is on, turns the finger or pen into strokes.
//
// Off, it lets every touch through to what is underneath (the text).
// Brushes: 펜 (swells and thins with the pen's pressure), 연필 (grainy, like a
// colored pencil), 마커 (even and bold), 형광펜 (wide and see-through). Two
// erasers: 부분 지우개 rubs out only where it passes (it is a stroke of its
// own that clears what lies under it), 획 지우개 removes whole strokes.
// Used by the text room; the photo room and whiteboard can reuse it.

import { h, iconButton } from "./dom.js";
import { getSettings, setSetting } from "../identity.js";
import { INK_COLORS } from "../core/ink.js";
import { currentTheme } from "./theme.js";
import { INK } from "../core/paint.js";

const COLORS = {
  red: "#e5484d", orange: "#f2802a", yellow: "#e8b422", green: "#2f9e5b", blue: "#2f7bf0", indigo: "#4b4fd8", violet: "#9a4fd8",
};
/** Pixel width of each size at 1 rem = 16 px. */
const WIDTHS = { 1: 2, 2: 4, 3: 8 };
/** How each brush scales the size, and how solid it is. */
const LOOK = {
  pen: { scale: 1, alpha: 1 },
  pencil: { scale: 0.9, alpha: 0.9 },
  marker: { scale: 1.6, alpha: 1 },
  highlighter: { scale: 3.4, alpha: 0.32 },
  erase: { scale: 3.2, alpha: 1 },
};

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
  constructor({ host, ink, onStroke, onErase, blocked = () => false, room = () => 0, view = null }) {
    this.host = host;
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
    const r = this.host.getBoundingClientRect();
    // The page may be zoomed (text room pinch): on-screen size over laid-out size is the zoom.
    const zoom = this.host.offsetWidth ? r.width / this.host.offsetWidth : 1;
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
      for (const ev of e.getCoalescedEvents?.() || [e]) this.live.pts.push(...this.point(ev));
      this.render();
    });
    const end = (e) => {
      if (!this.live || e.pointerId !== this.live.pointer) return;
      const live = this.live;
      this.live = null;
      // An eraser's stroke has no colour of its own; it keeps a neutral one.
      if (live?.pts && live.pts.length >= 3) this.onStroke({ pts: live.pts, color: live.brush === "erase" ? "black" : this.color, width: this.width, brush: live.brush });
      this.render();
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    // Losing hold of the pointer without a lift also ends the line, so it never waits forever.
    c.addEventListener("lostpointercapture", end);
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
    for (const s of this.ink().strokes()) this.paint(g, s.pts, s.c, s.w, s.b || "pen");
    if (this.live?.pts) this.paint(g, this.live.pts, this.color, this.width, this.live.brush);
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

  paint(g, pts, color, width, brush) {
    const look = LOOK[brush] || LOOK.pen;
    const base = (WIDTHS[width] || 4) * (100 / 16) * look.scale;
    g.save();
    g.globalAlpha = look.alpha;
    g.globalCompositeOperation = brush === "erase" ? "destination-out" : "source-over";
    const paintStyle = brush === "erase" ? "#000" : brush === "pencil" ? grainFor(g, inkColor(color)) : inkColor(color);
    g.strokeStyle = paintStyle;
    g.fillStyle = paintStyle;
    g.lineCap = brush === "highlighter" ? "square" : "round";
    g.lineJoin = "round";
    if (pts.length <= 3) {
      g.beginPath();
      g.arc(pts[0], pts[1], brush === "pen" ? (base * (0.5 + pts[2] / 100)) / 2 : base / 2, 0, Math.PI * 2);
      g.fill();
    } else if (brush === "pen") {
      // Short pieces, each as wide as the pressure there: a pen that swells and thins.
      for (let i = 3; i < pts.length; i += 3) {
        g.lineWidth = base * (0.5 + (pts[i + 2] + pts[i - 1]) / 200);
        g.beginPath();
        g.moveTo(pts[i - 3], pts[i - 2]);
        g.lineTo(pts[i], pts[i + 1]);
        g.stroke();
      }
    } else {
      // One smooth path of even width, so see-through brushes do not darken where pieces meet.
      g.lineWidth = base;
      g.beginPath();
      g.moveTo(pts[0], pts[1]);
      for (let i = 3; i < pts.length - 3; i += 3) {
        const mx = (pts[i] + pts[i + 3]) / 2;
        const my = (pts[i + 1] + pts[i + 4]) / 2;
        g.quadraticCurveTo(pts[i], pts[i + 1], mx, my);
      }
      g.lineTo(pts[pts.length - 3], pts[pts.length - 2]);
      g.stroke();
    }
    g.restore();
  }

  destroy() {
    this.resize.disconnect();
    this.canvas.remove();
  }
}

/**
 * The drawing tools (펜·연필·마커·형광펜, 지우개 부분/획, eight colours, three widths), the same in
 * the text room and on the whiteboard. pen: { tool, brush, color, width }; setTool(tool) applies a
 * change. Hidden while no tool is on.
 */
export function drawInkTools(panel, { pen, setTool, store }) {
  panel.hidden = !pen.tool;
  if (!pen.tool) return;
  const erasing = pen.tool !== "pen";
  const eraserKind = () => (getSettings(store).inkEraser === "stroke" ? "eraser-stroke" : "eraser");
  const choose = (patch) => { Object.assign(pen, patch); setTool("pen"); };
  const brushes = [["pen", "펜"], ["pencil", "연필"], ["marker", "마커"], ["highlighter", "형광펜"]];
  panel.replaceChildren(
    h("div", { class: "ink-row" },
      ...brushes.map(([b, name]) => h("button", { class: "ink-brush", type: "button", data: { brush: b }, "aria-pressed": String(!erasing && pen.brush === b), text: name,
        onclick: () => { setSetting(store, "inkBrush", b); choose({ brush: b }); } })),
      iconButton("eraser", "eraser", "지우개", () => setTool(erasing ? "pen" : eraserKind())),
      erasing && h("div", { class: "seg ink-erase", role: "group", "aria-label": "지우개 방식" },
        ...[["eraser", "부분"], ["eraser-stroke", "획"]].map(([kind, name]) => h("button", { type: "button", data: { erase: kind }, "aria-pressed": String(pen.tool === kind), text: name,
          onclick: () => { setSetting(store, "inkEraser", kind === "eraser-stroke" ? "stroke" : "area"); setTool(kind); } })))),
    h("div", { class: "ink-row" },
      ...INK_COLORS.map((c) => h("button", { class: "ink-color", type: "button", data: { ink: c }, "aria-label": c, "aria-pressed": String(!erasing && pen.color === c),
        style: { background: inkColor(c) }, onclick: () => choose({ color: c }) })),
      ...[1, 2, 3].map((w) => h("button", { class: "ink-width", type: "button", data: { width: String(w) }, "aria-label": "굵기 " + w, "aria-pressed": String(pen.width === w),
        onclick: () => { pen.width = w; setTool(pen.tool); } }, h("span", { style: { width: 0.2 + w * 0.18 + "rem", height: 0.2 + w * 0.18 + "rem" } })))));
  panel.querySelector("#eraser").setAttribute("aria-pressed", String(erasing));
}
