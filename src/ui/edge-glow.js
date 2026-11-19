// The light at the screen's edge where something is thrown. The owner (17 November): "안 보이는 공이
// 가서 터지면 가장 가까운 곳이 먼저 드러나고 점점 퍼지고, 변 끝까지는 안 가고 세기에 따라 달라지는
// 미묘한 맛, 활성화된 변의 끝부분은 그라데이션으로 빛나고, 내가 지정한 색으로, 네온 느낌도, 완전 예쁘게",
// with a very small buzz.
//
// So: a burst where the ball hits; from there a thin bar of my glass colour runs along the edge
// both ways, further the harder it was thrown (never to the corners), its two ends fading out,
// its light coming in from the very edge (bright at the glass, soft inward). Then it lets go.

import { h } from "./dom.js";

/** Which edge a throw from (x, y) going (dx, dy) reaches first, and where along it (0..1). */
export function edgeOf(x, y, dx, dy, w, hgt) {
  let edge;
  if (Math.abs(dx) >= Math.abs(dy)) edge = dx >= 0 ? "right" : "left";
  else edge = dy >= 0 ? "bottom" : "top";
  // Where the ball, flying straight on, meets that edge.
  let along;
  if (edge === "left" || edge === "right") {
    const tx = ((edge === "right" ? w : 0) - x) / (dx || 1e-6);
    along = (y + dy * tx) / hgt;
  } else {
    const ty = ((edge === "bottom" ? hgt : 0) - y) / (dy || 1e-6);
    along = (x + dx * ty) / w;
  }
  return { edge, at: Math.max(0.06, Math.min(0.94, along)) };
}

/**
 * Lights the edge: edge "left" | "right" | "top" | "bottom", at 0..1 along it, strength 0..1.
 * Returns a promise that settles when the light has spread (what comes out of the edge follows).
 */
export function glowEdge({ edge, at, strength = 0.5 }) {
  const across = edge === "top" || edge === "bottom";
  const span = 0.16 + 0.6 * Math.max(0, Math.min(1, strength));
  const from = Math.max(0.02, at - span / 2);
  const to = Math.min(0.98, at + span / 2);
  const bar = h("div", { class: "edge-glow", data: { edge }, "aria-hidden": "true" });
  const burst = h("div", { class: "edge-burst", data: { edge }, "aria-hidden": "true" });
  bar.style.setProperty("--from", from * 100 + "%");
  bar.style.setProperty("--len", (to - from) * 100 + "%");
  burst.style.setProperty("--at", at * 100 + "%");
  // The light spreads from where the ball hit: the bar grows from that point both ways.
  bar.style.transformOrigin = across ? `${((at - from) / (to - from)) * 100}% 50%` : `50% ${((at - from) / (to - from)) * 100}%`;
  document.body.append(burst, bar);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const grow = across ? ["scaleX(0.02)", "scaleX(1)"] : ["scaleY(0.02)", "scaleY(1)"];
  const spread = 170 + 160 * strength;
  if (!reduced && bar.animate) {
    burst.animate([
      { transform: "translate(-50%, -50%) scale(0.15)", opacity: 0.95 },
      { transform: "translate(-50%, -50%) scale(1)", opacity: 0.7, offset: 0.35 },
      { transform: "translate(-50%, -50%) scale(1.6)", opacity: 0 },
    ], { duration: 460, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "forwards" });
    bar.animate([
      { transform: grow[0], opacity: 0.4 },
      { transform: grow[1], opacity: 1, offset: 0.55 },
      { transform: grow[1], opacity: 1 },
    ], { duration: spread * 1.6, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" });
    // It lingers a moment, then fades as what came out of the edge settles.
    bar.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 900, delay: spread + 520, easing: "ease-in", fill: "forwards" });
  }
  setTimeout(() => { bar.remove(); burst.remove(); }, reduced ? 400 : spread + 1500);
  return new Promise((resolve) => setTimeout(resolve, reduced ? 0 : Math.round(spread * 0.6)));
}
