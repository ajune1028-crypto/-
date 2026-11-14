// A drawing layer over any surface: a canvas that shows an InkDoc's strokes
// and, while a tool is on, turns the finger or pen into strokes.
//
// Off, it lets every touch through to what is underneath (the text).
// Brushes: 펜 (swells and thins with the pen's pressure), 연필 (grainy, like a
// colored pencil), 마커 (even and bold), 형광펜 (wide and see-through). Two
// erasers: 부분 지우개 rubs out only where it passes (it is a stroke of its
// own that clears what lies under it), 획 지우개 removes whole strokes.
// Used by the text room; the photo room and whiteboard can reuse it.

import { h } from "./dom.js";
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
  constructor({ host, ink, onStroke, onErase }) {
    this.host = host;
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
    const rem = remPx();
    const pressure = e.pointerType === "pen" || (e.pressure > 0 && e.pressure !== 0.5) ? e.pressure : 0.5;
    return [Math.round(((e.clientX - r.left) / rem) * 100), Math.round(((e.clientY - r.top) / rem) * 100), Math.round(pressure * 100)];
  }

  wire() {
    const c = this.canvas;
    // A line belongs to the finger (or pen) that began it. Another touch while it is
    // being drawn, such as a resting palm or a second finger, is left out of it.
    c.addEventListener("pointerdown", (e) => {
      if (!this.tool || this.live) return;
      e.preventDefault();
      c.setPointerCapture?.(e.pointerId);
      if (this.tool === "eraser-stroke") {
        this.live = { pointer: e.pointerId, erase: new Set() };
        this.eraseAt(e);
      } else {
        this.live = { pointer: e.pointerId, pts: this.point(e), brush: this.tool === "eraser" ? "erase" : this.brush };
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
    const rect = this.host.getBoundingClientRect();
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
    const scale = (remPx() / 100) * ratio;
    g.setTransform(scale, 0, 0, scale, 0, 0);
    for (const s of this.ink().strokes()) this.paint(g, s.pts, s.c, s.w, s.b || "pen");
    if (this.live?.pts) this.paint(g, this.live.pts, this.color, this.width, this.live.brush);
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
