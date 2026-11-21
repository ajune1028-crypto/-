// The houses a held room can go into, as a small world rising from the bottom of the screen (the
// owner, 21 November: "자연스러운 아주 예쁘고 촤라라락 펼쳐지듯이… 한 세계가 나오듯 그 선들이 나오면서
// 원형이 나오는데… 큰 원의 3분의 1… 거기에 내가 생성한 집이 있고, 가운데에 플러스"): the top third of a big
// circle fitted to the screen comes up, its rings draw themselves out from the middle to both sides,
// and the houses pop up along its rim from the middle out, + at the top. Drawn onto a house the room
// goes in; let go without moving, the world stays for a tap on a house (outside it closes).
// Where things stand is ui/house-arc-geometry.js.

import { h, icon, swallowPress } from "./dom.js";
import { arcGeometry } from "./house-arc-geometry.js";

const NS = "http://www.w3.org/2000/svg";
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

/**
 * houses: [{ id, name }], shapeOf(house) → its house element. Returns { el, choose(onPick), close() }:
 * choose() keeps it open for a tap (onPick(id), id "new" for +); close() sinks it away.
 */
export function openHouseArc({ houses, shapeOf }) {
  const w = innerWidth;
  const hgt = innerHeight;
  const g = arcGeometry(w, hgt, houses.length);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "arc-world");
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  svg.setAttribute("aria-hidden", "true");
  const el = (name, attrs) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const defs = el("defs", {});
  const grad = el("radialGradient", { id: "arc-glow", cx: "50%", cy: "0%", r: "75%" });
  grad.append(el("stop", { offset: "0%", class: "arc-glow-top" }), el("stop", { offset: "100%", class: "arc-glow-edge" }));
  defs.append(grad);
  svg.append(defs, el("circle", { class: "arc-face", cx: g.cx, cy: g.cy, r: g.r, fill: "url(#arc-glow)" }));
  // The rings: each drawn from the top out to both sides at once, so they open like a fan.
  const rings = [];
  for (const [i, k] of [1, 0.86, 0.72].entries()) {
    const rad = g.r * k;
    const c = (g.cy - hgt) / rad;
    if (c >= 1) continue;
    const a = Math.acos(Math.max(-1, c));
    const x0 = g.cx;
    const y0 = g.cy - rad;
    for (const side of [1, -1]) {
      const path = el("path", { class: "arc-ring" + (i === 0 ? " rim" : ""), d: `M ${x0} ${y0} A ${rad} ${rad} 0 0 ${side > 0 ? 1 : 0} ${g.cx + side * rad * Math.sin(a)} ${hgt}`, pathLength: "1" });
      svg.append(path);
      rings.push({ path, i });
    }
  }
  // Frosted glass under the rings (an SVG cannot blur what is behind it).
  const glass = h("div", { class: "arc-glass", "aria-hidden": "true", style: { left: g.cx - g.r + "px", top: g.cy - g.r + "px", width: 2 * g.r + "px", height: 2 * g.r + "px" } });
  const box = h("div", { class: "house-arc", id: "house-dock", role: "group", "aria-label": "넣을 집" }, glass, svg);
  const tiles = g.spots.map((spot, i) => {
    const house = i === 0 ? null : houses[i - 1];
    const tile = h("button", { class: "dock-house" + (house ? "" : " dock-new"), type: "button", data: { house: house ? house.id : "new" },
      "aria-label": house ? `'${house.name}'에 넣기` : "새 집을 지어 넣기", style: { left: spot.x + "px", top: spot.y + "px", "--s": String(g.scale) } },
      house ? shapeOf(house) : h("span", { class: "house-shape house-plan" }, icon("plus")),
      h("span", { class: "dock-name", text: house ? house.name : "새 집" }));
    box.append(tile);
    return { tile, spot };
  });
  const hint = h("p", { class: "dock-hint arc-hint", text: houses.length ? "집 위에 놓으면 그 집에 들어가요" : "새 집 위에 놓으면 집을 지어 넣어요" });
  box.append(hint);
  document.body.append(box);

  if (!reduced && box.animate) {
    for (const part of [glass, svg]) part.animate([{ transform: `translateY(${g.cap * 0.7}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 460, easing: EASE });
    for (const { path, i } of rings) {
      path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 700, delay: 120 + i * 90, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)", fill: "backwards" });
    }
    // From the middle out, as if the world were being laid out under them.
    const order = tiles.map((t, i) => [Math.abs(t.spot.angle) + t.spot.ring * 0.01, i]).sort((a, b) => a[0] - b[0]);
    order.forEach(([, i], n) => {
      tiles[i].tile.animate([{ opacity: 0, translate: "0 18px", scale: "0.4" }, { opacity: 1, translate: "0 0", scale: "1" }], { duration: 380, delay: 200 + n * 45, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)", fill: "backwards" });
    });
    hint.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 360, fill: "backwards" });
  }

  let catcher = null;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    catcher?.remove();
    if (reduced || !box.animate) return void box.remove();
    box.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateY(${Math.round(g.cap * 0.4)}px)` }], { duration: 220, easing: "ease-in", fill: "forwards" })
      .finished.then(() => box.remove(), () => box.remove());
  }
  /** Stays for a tap: a house or + picks it, anywhere else closes it (and touches nothing there). */
  function choose(onPick) {
    if (closed) return;
    box.classList.add("choosing");
    hint.textContent = "넣을 집을 눌러요";
    catcher = h("div", { class: "arc-catcher", "aria-hidden": "true" });
    catcher.addEventListener("pointerdown", (e) => { swallowPress(e); close(); });
    document.body.insertBefore(catcher, box);
    for (const { tile } of tiles) tile.addEventListener("click", () => { const id = tile.dataset.house; close(); onPick(id); });
  }
  return { el: box, choose, close, get closed() { return closed; } };
}
