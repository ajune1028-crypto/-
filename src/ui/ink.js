// A drawing layer over any surface: a canvas that shows an InkDoc's strokes
// and, while a tool is on, turns the finger or pen into strokes.
//
// Off, it lets every touch through to what is underneath (the text). The pen
// draws with the device's pressure where it has one; the eraser hides whole
// strokes. Used by the text room; the photo room and whiteboard can reuse it.

import { h } from "./dom.js";
import { currentTheme } from "./theme.js";
import { INK } from "../core/paint.js";

const COLORS = {
  red: "#e5484d", orange: "#f2802a", yellow: "#e8b422", green: "#2f9e5b", blue: "#2f7bf0", indigo: "#4b4fd8", violet: "#9a4fd8",
};
/** Pixel width of each pen size at 1 rem = 16 px. */
const WIDTHS = { 1: 2, 2: 4, 3: 8 };

export function inkColor(c) {
  if (c === "black") return INK[currentTheme()];
  return COLORS[c] || c;
}

const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

export class InkLayer {
  /**
   * host     the element to draw over (gets position: relative)
   * ink      () => InkDoc
   * onStroke ({ pts, color, width }) when a stroke is finished
   * onErase  (strokeId) when the eraser touches a stroke
   */
  constructor({ host, ink, onStroke, onErase }) {
    this.host = host;
    this.ink = ink;
    this.onStroke = onStroke;
    this.onErase = onErase;
    this.tool = null;
    this.color = "black";
    this.width = 2;
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

  setStyle({ color, width }) {
    if (color) this.color = color;
    if (width) this.width = width;
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
    c.addEventListener("pointerdown", (e) => {
      if (!this.tool) return;
      e.preventDefault();
      c.setPointerCapture?.(e.pointerId);
      if (this.tool === "eraser") {
        this.live = { erase: new Set() };
        this.eraseAt(e);
      } else {
        this.live = { pts: this.point(e) };
        this.render();
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.live) return;
      if (this.live.erase) return void this.eraseAt(e);
      for (const ev of e.getCoalescedEvents?.() || [e]) this.live.pts.push(...this.point(ev));
      this.render();
    });
    const end = () => {
      const live = this.live;
      this.live = null;
      if (live?.pts && live.pts.length >= 3) this.onStroke({ pts: live.pts, color: this.color, width: this.width });
      this.render();
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
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
    const strokes = this.ink().strokes();
    for (const s of strokes) this.paint(g, s.pts, s.c, s.w, scale);
    if (this.live?.pts) this.paint(g, this.live.pts, this.color, this.width, scale);
  }

  paint(g, pts, color, width, scale) {
    const base = (WIDTHS[width] || 4) * (100 / 16);
    g.strokeStyle = inkColor(color);
    g.lineCap = "round";
    g.lineJoin = "round";
    if (pts.length <= 3) {
      g.fillStyle = g.strokeStyle;
      g.beginPath();
      g.arc(pts[0], pts[1], (base * (0.5 + pts[2] / 100)) / 2, 0, Math.PI * 2);
      g.fill();
      return;
    }
    // Short pieces, each as wide as the pressure at that point: a pen that swells and thins.
    for (let i = 3; i < pts.length; i += 3) {
      g.lineWidth = base * (0.5 + (pts[i + 2] + pts[i - 1]) / 200);
      g.beginPath();
      g.moveTo(pts[i - 3], pts[i - 2]);
      g.lineTo(pts[i], pts[i + 1]);
      g.stroke();
    }
    void scale;
  }

  destroy() {
    this.resize.disconnect();
    this.canvas.remove();
  }
}
