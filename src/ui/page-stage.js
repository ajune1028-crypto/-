// A page of fixed size on a stage, as 그림 방 and 애니메이션 방 show it: fitted to the screen at
// first; two fingers zoom and move it, and a quick pinch inward puts it back to fit (Procreate's
// quick pinch); a mouse wheel zooms around the pointer. onPinch() runs as a second finger lands
// (a line the first finger began is put away).

import { h } from "./dom.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function pageStage(body, { id, width, height, onPinch = () => {}, avoid = () => null }) {
  const page = h("div", { class: "draw-page", id: id + "-page", style: { width: width / 100 + "rem", height: height / 100 + "rem" } });
  const stage = h("div", { class: "draw-stage", id: id + "-stage" }, page);
  body.classList.add("draw-body");
  body.append(stage);
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let fitted = false;
  let pinch = null;

  const place = () => { page.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`; };
  /**
   * How much of the stage's left or right the page keeps clear of as it fits: the drawing rail
   * standing at that side (avoid() gives it), so the page is never under it at first (the owner, 27
   * November: "애니메이션 방 ui겹친다"). Zoomed or moved by hand, the page goes where it is put.
   */
  function clearOf(el) {
    if (!el || el.hidden || !el.isConnected) return { left: 0, right: 0 };
    const r = el.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    if (!r.width || r.bottom <= s.top || r.top >= s.bottom || r.right <= s.left || r.left >= s.right) return { left: 0, right: 0 };
    return (r.left + r.right) / 2 < s.left + s.width / 2 ? { left: Math.max(0, r.right - s.left), right: 0 } : { left: 0, right: Math.max(0, s.right - r.left) };
  }
  function fit(smooth = false) {
    const w = page.offsetWidth;
    const hgt = page.offsetHeight;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    if (!w || !sw || !sh) return;
    let { left, right } = clearOf(avoid());
    // A rail as wide as most of the stage (a very narrow screen) is not given the room.
    if (sw - left - right < sw * 0.6) left = right = 0;
    const free = sw - left - right;
    zoom = Math.min((free - 24) / w, (sh - 24) / hgt);
    panX = left + (free - w * zoom) / 2;
    panY = (sh - hgt * zoom) / 2;
    fitted = true;
    if (smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      page.classList.add("fitting");
      setTimeout(() => page.classList.remove("fitting"), 320);
    }
    place();
  }
  const resize = new ResizeObserver(() => { if (!fitted || !pinch) fit(); });
  resize.observe(stage);
  const touches = new Map();
  stage.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (touches.size === 2) {
      // A second finger: no line from it; the page follows the fingers.
      onPinch();
      const [[ax, ay], [bx, by]] = [...touches.values()];
      const s = stage.getBoundingClientRect();
      const mx = (ax + bx) / 2 - s.left;
      const my = (ay + by) / 2 - s.top;
      pinch = { d: Math.hypot(bx - ax, by - ay) || 1, zoom, px: (mx - panX) / zoom, py: (my - panY) / zoom, t0: e.timeStamp };
    }
  }, true);
  stage.addEventListener("pointermove", (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (!pinch || touches.size < 2) return;
    const [[ax, ay], [bx, by]] = [...touches.values()];
    const s = stage.getBoundingClientRect();
    const mx = (ax + bx) / 2 - s.left;
    const my = (ay + by) / 2 - s.top;
    zoom = clamp(pinch.zoom * (Math.hypot(bx - ax, by - ay) / pinch.d), 0.3, 8);
    panX = mx - pinch.px * zoom;
    panY = my - pinch.py * zoom;
    place();
  }, true);
  const lift = (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.delete(e.pointerId);
    if (touches.size < 2 && pinch) {
      // A quick pinch inward: the whole page again.
      if (e.timeStamp - pinch.t0 < 350 && zoom < pinch.zoom * 0.8) fit(true);
      pinch = null;
    }
  };
  window.addEventListener("pointerup", lift, true);
  window.addEventListener("pointercancel", lift, true);
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const s = stage.getBoundingClientRect();
    const mx = e.clientX - s.left;
    const my = e.clientY - s.top;
    const px = (mx - panX) / zoom;
    const py = (my - panY) / zoom;
    zoom = clamp(zoom * Math.exp(-e.deltaY * 0.0015), 0.3, 8);
    panX = mx - px * zoom;
    panY = my - py * zoom;
    place();
  }, { passive: false });

  return {
    page,
    stage,
    fit,
    get pinching() {
      return !!pinch;
    },
    destroy() {
      resize.disconnect();
      window.removeEventListener("pointerup", lift, true);
      window.removeEventListener("pointercancel", lift, true);
    },
  };
}
