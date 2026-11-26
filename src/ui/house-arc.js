// The houses a held room can go into, as a small planet rising from the bottom of the screen with my
// houses built on it (the owner, 21 November: "그 원형은 행성이야… 거기에 집이 지어진 거야", "한 세계가
// 나오듯 그 선들이 나오면서 원형이 나오는데… 큰 원의 3분의 1", "1번 집이 먼저 가운데… 오른쪽으로",
// "플러스 버튼은 1번 방 옆에", "행성을 스크롤하면 그 원이 돌아가면서", "넣어짐 당하는 그 집이… 좀 커짐",
// "힐링받게 간결하면서도 디테일에서 좋은 느낌"). Its rings draw themselves out from the top to both
// sides, then the houses grow up out of the ground from the middle out. Drawn onto a house the room
// goes in (held near either end, the planet turns to bring more houses); let go without moving, it
// stays for a tap on a house, and a finger sliding along it turns it (outside, it closes).
// Where things stand is ui/house-arc-geometry.js.

import { h, icon, swallowPress } from "./dom.js";
import { planet, slotAngle, snapTurn, spotAt, seen } from "./house-arc-geometry.js";

const NS = "http://www.w3.org/2000/svg";
const RISE = "cubic-bezier(0.22, 1.12, 0.36, 1)";

/**
 * houses: [{ id, name }], shapeOf(house) → its house element. Returns { el, choose(onPick), follow(x, y),
 * onSpin, close() }: choose() keeps it open for a tap (onPick(id), id "new" for +); follow() is the held
 * room's finger (near an end, the planet turns; onSpin() then runs so the house under it is read again);
 * close() sinks it away.
 */
export function openHouseArc({ houses, shapeOf }) {
  const w = innerWidth;
  const hgt = innerHeight;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const g = planet(w, hgt, houses.length, { house: 2.7 * rem, gap: 0.7 * rem, low: 2.6 * rem });
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let turn = g.start;
  const el = (name, attrs) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const svg = el("svg", { class: "arc-world", viewBox: `0 0 ${w} ${hgt}`, "aria-hidden": "true" });
  const defs = el("defs", {});
  const grad = el("radialGradient", { id: "arc-glow", cx: "50%", cy: "0%", r: "75%" });
  grad.append(el("stop", { offset: "0%", class: "arc-glow-top" }), el("stop", { offset: "100%", class: "arc-glow-edge" }));
  defs.append(grad);
  svg.append(defs, el("circle", { class: "arc-face", cx: g.cx, cy: g.cy, r: g.r, fill: "url(#arc-glow)" }));
  // The air around it: a soft light just outside the rim.
  svg.append(el("circle", { class: "arc-air", cx: g.cx, cy: g.cy, r: g.r + 5 }));
  // Its ground: a few small marks that turn with it, so a turn is seen even between houses.
  const ground = el("g", { class: "arc-ground" });
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + (i % 3) * 0.07;
    const rr = g.r * (0.9 - (i % 4) * 0.055);
    ground.append(el("circle", { cx: g.cx + rr * Math.sin(a), cy: g.cy - rr * Math.cos(a), r: 1 + (i % 3) * 0.45 }));
  }
  svg.append(ground);
  // The rings: each drawn from the top out to both sides at once, so they open like a fan.
  const rings = [];
  for (const [i, k] of [1, 0.86, 0.72].entries()) {
    const rad = g.r * k;
    const c = (g.cy - hgt) / rad;
    if (c >= 1) continue;
    const a = Math.acos(Math.max(-1, c));
    for (const side of [1, -1]) {
      const path = el("path", { class: "arc-ring" + (i === 0 ? " rim" : ""), d: `M ${g.cx} ${g.cy - rad} A ${rad} ${rad} 0 0 ${side > 0 ? 1 : 0} ${g.cx + side * rad * Math.sin(a)} ${hgt}`, pathLength: "1" });
      svg.append(path);
      rings.push({ path, i });
    }
  }
  // Frosted glass under the rings (an SVG cannot blur what is behind it).
  const glass = h("div", { class: "arc-glass", "aria-hidden": "true", style: { left: g.cx - g.r + "px", top: g.cy - g.r + "px", width: 2 * g.r + "px", height: 2 * g.r + "px" } });
  const box = h("div", { class: "house-arc", id: "house-dock", role: "group", "aria-label": "넣을 집" }, glass, svg);
  box.style.setProperty("--hw", 2.7 * rem + "px");
  box.style.setProperty("--s", String(g.scale));
  // Slot 0 is +, right beside house 1; slot k is house k.
  const slots = [null, ...houses].map((house, slot) => {
    const tile = h("button", { class: "dock-house" + (house ? "" : " dock-new"), type: "button", data: { house: house ? house.id : "new" },
      "aria-label": house ? `'${house.name}'에 넣기` : "새 집을 지어 넣기" },
    h("span", { class: "dock-body" }, house ? shapeOf(house) : h("span", { class: "house-shape house-plan" }, icon("plus"))),
    h("span", { class: "dock-name", text: house ? house.name : "새 집" }));
    box.append(tile);
    return { tile, slot };
  });
  const more = slots.length > seen(g);
  const hint = h("p", { class: "dock-hint arc-hint", text: houses.length ? (more ? "집 위에 놓으면 들어가요 · 끝으로 가면 행성이 돌아요" : "집 위에 놓으면 그 집에 들어가요") : "새 집 위에 놓으면 집을 지어 넣어요" });
  box.append(hint);

  /** Every house where the turn puts it, standing up from the ground; past the visible rim it fades. */
  function place() {
    for (const { tile, slot } of slots) {
      const a = slotAngle(g, slot, turn);
      const p = spotAt(g, a);
      const fade = Math.max(0, Math.min(1, (g.reach + g.step * 0.45 - Math.abs(a)) / (g.step * 0.45)));
      tile.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) rotate(${a.toFixed(4)}rad)`;
      tile.style.opacity = fade.toFixed(3);
      tile.classList.toggle("far", fade < 0.5);
    }
    ground.setAttribute("transform", `rotate(${((-turn * 180) / Math.PI).toFixed(3)} ${g.cx} ${g.cy})`);
  }
  place();
  document.body.append(box);

  if (!reduced && box.animate) {
    for (const part of [glass, svg]) part.animate([{ transform: `translateY(${g.cap * 0.75}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 540, easing: RISE });
    for (const { path, i } of rings) {
      path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 760, delay: 140 + i * 95, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)", fill: "backwards" });
    }
    ground.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, delay: 420, fill: "backwards" });
    // Built up out of the ground, from the middle out, as if the world were laid out under them.
    const order = slots.map((t, i) => [Math.abs(slotAngle(g, t.slot, turn)), i]).sort((a, b) => a[0] - b[0]);
    order.forEach(([, i], n) => {
      const { tile } = slots[i];
      const delay = 250 + n * 55;
      tile.querySelector(".dock-body").animate([{ transform: "scaleY(0.05)", opacity: 0 }, { transform: "scaleY(1.12)", opacity: 1, offset: 0.62 }, { transform: "scaleY(0.97)", offset: 0.84 }, { transform: "none", opacity: 1 }], { duration: 520, delay, easing: "cubic-bezier(0.3, 0.7, 0.3, 1)", fill: "backwards" });
      tile.querySelector(".dock-name").animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 300, delay: delay + 200, fill: "backwards" });
    });
    hint.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 420, fill: "backwards" });
  }

  // ---- turning ------------------------------------------------------------------------------------
  // A spring brings it to rest with a house in the middle (the wheel pickers' way: it coasts, then
  // settles on the nearest).
  let spin = 0;
  let aim = turn;
  let speed = 0;
  let holdAt = null; // the held room's finger, when it is near an end
  const api = { el: box, choose, follow, close, onSpin: null };
  function frame(now, last) {
    const dt = Math.min(0.033, (now - last) / 1000);
    if (holdAt) {
      // Near an end, the planet turns toward it: quicker the nearer the finger is.
      turn = Math.max(g.min, Math.min(g.max, turn + holdAt.push * 1.4 * dt));
      aim = snapTurn(g, turn);
      speed = 0;
    } else {
      speed += (-240 * (turn - aim) - 26 * speed) * dt;
      turn += speed * dt;
      if (Math.abs(turn - aim) < 1e-4 && Math.abs(speed) < 1e-3) {
        turn = aim;
        speed = 0;
      }
    }
    place();
    api.onSpin?.();
    spin = (holdAt || turn !== aim) && !closed ? requestAnimationFrame((t) => frame(t, now)) : 0;
  }
  function settle(to) {
    aim = snapTurn(g, to);
    if (reduced) {
      turn = aim;
      place();
      return;
    }
    if (!spin) spin = requestAnimationFrame((t) => frame(t, t - 16));
  }
  /** The held room's finger: near either end of the planet, it turns (only while there is more to see). */
  function follow(x, y) {
    if (closed) return;
    const band = y > hgt - g.cap - 3 * rem;
    const half = g.r * Math.sin(g.reach);
    const out = (x - g.cx) / Math.max(1, half);
    const push = band && Math.abs(out) > 0.62 ? Math.sign(out) * Math.min(1, (Math.abs(out) - 0.62) / 0.3) : 0;
    const can = push > 0 ? turn < g.max - 1e-6 : push < 0 ? turn > g.min + 1e-6 : false;
    holdAt = can ? { push } : null;
    if (holdAt && !spin && !reduced) spin = requestAnimationFrame((t) => frame(t, t - 16));
    if (!holdAt) settle(turn);
  }

  let catcher = null;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(spin);
    catcher?.remove();
    if (reduced || !box.animate) return void box.remove();
    box.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateY(${Math.round(g.cap * 0.4)}px)` }], { duration: 220, easing: "ease-in", fill: "forwards" })
      .finished.then(() => box.remove(), () => box.remove());
  }
  /** Stays for a tap: a house or + picks it, a slide along it turns it, anywhere else closes it. */
  function choose(onPick) {
    if (closed) return;
    box.classList.add("choosing");
    hint.textContent = more ? "넣을 집을 눌러요 · 옆으로 밀면 행성이 돌아요" : "넣을 집을 눌러요";
    catcher = h("div", { class: "arc-catcher", "aria-hidden": "true" });
    catcher.addEventListener("pointerdown", (e) => { swallowPress(e); close(); });
    document.body.insertBefore(catcher, box);
    let drag = null;
    const down = (e) => {
      if (drag || (e.pointerType === "mouse" && e.button !== 0)) return;
      drag = { id: e.pointerId, x0: e.clientX, turn0: turn, moved: false, t: [[e.timeStamp, e.clientX]] };
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* fine */ }
    };
    const move = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x0;
      if (!drag.moved && Math.abs(dx) < 7) return;
      drag.moved = true;
      // The finger carries the ground under it; past either end it gives a little and pulls back.
      let to = drag.turn0 - dx / g.r;
      if (to < g.min) to = g.min - (g.min - to) * 0.3;
      if (to > g.max) to = g.max + (to - g.max) * 0.3;
      turn = to;
      aim = to;
      cancelAnimationFrame(spin);
      spin = 0;
      place();
      drag.t.push([e.timeStamp, e.clientX]);
      if (drag.t.length > 6) drag.t.shift();
    };
    const up = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (!d.moved) return;
      d.swallow = true;
      // Let go moving, it coasts on a little and settles on the nearest house.
      const [t0, x0] = d.t[0];
      const [t1, x1] = d.t[d.t.length - 1];
      const v = t1 > t0 ? (x1 - x0) / (t1 - t0) : 0; // px per ms
      settle(turn - (v * 260) / g.r);
      const tile = e.target.closest?.(".dock-house");
      if (tile) tile.dataset.slid = "1";
    };
    for (const part of [glass, ...slots.map((t) => t.tile)]) {
      part.addEventListener("pointerdown", down);
      part.addEventListener("pointermove", move);
      part.addEventListener("pointerup", up);
      part.addEventListener("pointercancel", up);
    }
    for (const { tile } of slots) {
      tile.addEventListener("click", () => {
        // A slide that began on a house turned the planet; it is not a pick.
        if (tile.dataset.slid) return void delete tile.dataset.slid;
        if (tile.classList.contains("far")) return;
        const id = tile.dataset.house;
        close();
        onPick(id);
      });
    }
  }
  return api;
}
