// 찾기와 집: what the ⋮ at home's top right brings out (the owner, 17 November). At the top, a search
// of my rooms by their names (초성 too, core/search.js) or by what they hold; the last searches
// under it. Then 집: houses that hold rooms, each one colour of deep glass with a ㅅ roof, a small
// chimney and a white icon, its name beneath. It comes out of the edge it was thrown to (a tap
// brings it out where it last was). Its grip (and a side panel's inner edge) can be held and thrown
// on: back to its own edge it goes away, toward another edge it goes there (the owner, 20 November:
// "끝자락을 스와이프하면 없어지게", "맨 위 가로 바로 어디에 발사해서 왼쪽 끝 오른쪽 끝 아래 위"), judged
// as vaul (MIT) judges a drawer's swipe. Leaving the app puts it away, and the search with it.

import { h, icon, toast } from "./dom.js";
import { glowEdge, aimMarker } from "./edge-glow.js";
import { buzz } from "./chime.js";
import { VelocityTracker, gripThrow } from "../core/fling.js";
import { segmented } from "./dom.js";
import { kindInfo } from "./kinds.js";
import { getSettings } from "../identity.js";
import { rankByName, snippet } from "../core/search.js";
import { houses, addHouse, updateHouse, removeHouse, putInHouse, takeOutOfHouse, houseOf, recentSearches, rememberSearch, forgetSearches, roomWords, HOUSE_COLORS, HOUSE_ICONS } from "../houses.js";

const PANEL_EDGE = "homePanelEdge";
const EDGES = ["left", "right", "top", "bottom"];
const MIN_SIDE = 120; // the smallest it is drawn to, either way (px)

// Where the floating 찾기와 집 was left (its head dragged it there) and its size: { x, y, w?, h? }.
const FLOAT_KEY = "homePanelFloat";
// Its size at each edge (the ┘ corner drawn): { bottom: height, top: height, left: width, right: width }.
const SIZE_KEY = "homePanelSize";
// Locked where it is (the owner, 21 November: "잠금… 아무리 눌러도 그 위치가 고정"): ⋮ and swipes leave
// it; only its bar drawn back to its own edge puts it away.
const LOCK_KEY = "homePanelLocked";

export const panelLocked = (store) => store.get(LOCK_KEY, false) === true;

/** Where 찾기와 집 last came out (a tap on ⋮ brings it from there, the owner asked): { edge, at }. */
export function lastPanelEdge(store) {
  const v = store.get(PANEL_EDGE, null);
  if (!v || !EDGES.includes(v.edge) || !Number.isFinite(v.at)) return { edge: "bottom", at: 0.5 };
  return { edge: v.edge, at: Math.max(0, Math.min(1, v.at)) };
}

export function rememberPanelEdge(store, { edge, at }) {
  if (EDGES.includes(edge)) store.set(PANEL_EDGE, { edge, at: Number.isFinite(at) ? Math.max(0, Math.min(1, at)) : 0.5 });
}

export function houseColor(key) {
  return (HOUSE_COLORS.find(([k]) => k === key) || HOUSE_COLORS[0])[1];
}

/** A house: one colour of deep glass, a ㅅ roof and a small chimney, a white icon inside. */
export function houseShape(house) {
  const wrap = h("span", { class: "house-shape", "aria-hidden": "true" });
  wrap.style.setProperty("--house", houseColor(house.color));
  wrap.innerHTML = '<svg viewBox="0 0 100 100"><rect class="house-chimney" x="67" y="15" width="11" height="24" rx="2.5"/>' +
    '<path class="house-body" d="M50 14 L84 43 V85 Q84 91 78 91 H22 Q16 91 16 85 V43 Z"/>' +
    '<path class="house-shine" d="M50 21 L78 45 V56 Q50 47 22 58 V45 Z"/>' +
    '<path class="house-roof" d="M9 46 L50 12 L91 46"/></svg>';
  const mark = icon(house.icon || "home");
  mark.classList.add("house-mark");
  wrap.append(mark);
  return wrap;
}

/** The parts of a name around a match, the match marked. */
function marked(text, at, len) {
  const t = [...text];
  return [t.slice(0, at).join(""), h("mark", { text: t.slice(at, at + len).join("") }), t.slice(at + len).join("")];
}

/**
 * Opens the panel. rooms(): every room I know (mine and those made on my other devices);
 * changed(): home draws itself again (a room went into a house, a house was built or taken down).
 * view: what it opens on ({ name: "main" }, { name: "house", id }, { name: "build", room }).
 */
export function openHomePanel(app, { edge: firstEdge = "bottom", at = 0.5, rooms, changed, view = { name: "main" }, floating = false, swap = null }) {
  let edge = floating ? "float" : firstEdge;
  const root = app.root;
  const store = app.store;
  const max = () => getSettings(store).recentSearchMax || 5;
  let mode = "name";
  let query = "";
  const panel = h("aside", { class: "home-panel" + (floating ? " floating" : ""), id: "home-panel", data: { edge }, role: "dialog", "aria-label": "햇살 (방 찾기와 집)" });
  // While the panel is still coming out, a tap beside it does not put it away (it may be a tap on
  // the part of the panel that is not shown yet).
  let entering = false;
  // Nothing lies over home while the panel is out (the owner: "바깥에꺼가 터치가 되게끔"): rooms can be
  // opened, scrolled, and held and drawn into a house in the panel. A tap on an empty place puts it
  // away (see onOutside).
  const scrim = h("div", { class: "home-panel-scrim", "aria-hidden": "true" });
  // The grip stays the same element while the views change under it (a finger on it keeps its hold).
  // It is the window's bar: its lock, its way between edge and window and its close live on it (the
  // owner: "창 끝에 무슨 바 있는 거, 거기 줄에다가 잠금과 나가기와 다른 식으로 바꾸기").
  const grip = h("div", { class: "panel-grip", id: "panel-grip" });
  // A side panel's inner edge (its 끝자락) takes the same throw.
  const end = h("div", { class: "panel-end", id: "panel-end" });
  const body = h("div", { class: "home-panel-body" });
  // At its top left a lock, at its top right the way between an edge and a window of its own (the
  // owner: "점3개… 거기 누르면 나오는 곳에서 위쪽 오른쪽에다가 그거 따로 독단적 창 나오게 하는 걸 버튼").
  let locked = panelLocked(store);
  const lockBtn = h("button", { class: "icon-btn panel-lock", id: "panel-lock", type: "button", onclick: () => setLocked(!locked) }, icon("lock"));
  const floatBtn = h("button", { class: "icon-btn panel-float", id: "panel-float", type: "button", "aria-label": floating ? "가장자리에 붙이기" : "따로 떠 있는 창으로",
    onclick: () => swap?.(!floating) }, icon(floating ? "dock" : "float"));
  const paintLock = () => {
    lockBtn.setAttribute("aria-pressed", String(locked));
    lockBtn.setAttribute("aria-label", locked ? "잠금 풀기 (지금 이 자리에 고정돼 있어요)" : "이 자리에 잠그기");
    panel.classList.toggle("locked", locked);
  };
  function setLocked(on) {
    locked = on;
    store.set(LOCK_KEY, on);
    paintLock();
    toast(root, on ? "이 자리에 고정했어요. 바를 제자리로 밀면 닫혀요" : "잠금을 풀었어요", 2000);
  }
  // Its ┘ corner draws it bigger or smaller (the owner: "'ㄴ'을 반대로 한 거… 스와이프하면 그대로 크기가 그만큼
  // 작아지고"); small, only the houses stay, in a column when tall and a row when wide.
  const sizer = h("div", { class: "panel-sizer", id: "panel-sizer", role: "separator", "aria-label": "크기 바꾸기 (끌어서)" });
  // Floating: its bar moves it and keeps its size; no name over it (the owner: "그 창 위에 이름을
  // 넣지 마… 촌스러워"); its own button puts it away. Its two sides draw it wider or narrower.
  const head = floating && h("div", { class: "float-head", id: "float-head" },
    lockBtn,
    h("span", { class: "grip-bar", "aria-hidden": "true" }),
    h("span", { class: "panel-ctrl-end" }, floatBtn,
      h("button", { class: "icon-btn float-close", id: "float-close", type: "button", "aria-label": "닫기", onclick: () => close() }, icon("close"))));
  const sides = floating ? ["left", "right"].map((side) => h("div", { class: "panel-side " + side, id: "panel-side-" + side, role: "separator", "aria-label": (side === "left" ? "왼쪽" : "오른쪽") + " 가장자리를 끌어 너비 바꾸기" })) : [];
  // Docked, its lock, its way to a window of its own and its close stand beside the bar it already
  // has at its inner end (the owner, 21 November: "위쪽에 바를 새로 만들지 말고 이미 있는 그 창 바에다가
  // 옆에"): across the end of a bottom or top window, along the inner edge of a side one.
  const ctrlEnd = !floating && h("span", { class: "panel-ctrl-end" }, floatBtn,
    h("button", { class: "icon-btn panel-close", id: "panel-close", type: "button", "aria-label": "닫기", onclick: () => close() }, icon("close")));
  const gripBar = h("span", { class: "grip-bar", "aria-hidden": "true" });
  const endBar = h("span", { class: "grip-bar", "aria-hidden": "true" });
  function placeControls() {
    if (floating) return;
    const side = edge === "left" || edge === "right";
    grip.replaceChildren(...(side ? [] : [lockBtn, gripBar, ctrlEnd]));
    end.replaceChildren(...(side ? [lockBtn, endBar, ctrlEnd] : []));
  }
  if (floating) panel.append(head, body, ...sides, sizer);
  else {
    placeControls();
    panel.append(grip, body, end, sizer);
  }
  paintLock();
  root.append(scrim, panel);
  // 햇살 stays where it is while its window is out (the owner: "아이콘들 다 가리고서 거기 있던 그 아이콘만
  // 보이게"); where the window comes under it (a small screen, a window at the top or the right),
  // the rows under it make room: the bar's buttons and the search field shrink away from it.
  function keepClearOfSun() {
    const sun = document.getElementById("home-more")?.getBoundingClientRect();
    for (const row of panel.querySelectorAll(".panel-grip, .float-head, .search-row")) {
      row.style.removeProperty("--sun-r");
      row.style.removeProperty("--sun-l");
      if (!sun || !sun.width) continue;
      const r = row.getBoundingClientRect();
      if (!(sun.bottom > r.top && sun.top < r.bottom && sun.right > r.left && sun.left < r.right)) continue;
      if (sun.left + sun.width / 2 >= r.left + r.width / 2) row.style.setProperty("--sun-r", Math.ceil(r.right - sun.left + 6) + "px");
      else row.style.setProperty("--sun-l", Math.ceil(sun.right - r.left + 6) + "px");
    }
    // Houses alone (a small window): the first ones lay under 햇살 (the owner, 27 November: "창 크기 줄이면
    // 햇빛 아이콘이랑 많이 곂쳐") → a tall one starts below it, a wide one keeps beside it.
    const body = panel.querySelector(".home-panel-body");
    if (!body) return;
    for (const k of ["--sun-t", "--sun-r", "--sun-l"]) body.style.removeProperty(k);
    if (!sun || !sun.width || !panel.classList.contains("compact")) return;
    const b = body.getBoundingClientRect();
    if (!(sun.bottom > b.top && sun.top < b.bottom && sun.right > b.left && sun.left < b.right)) return;
    if (panel.classList.contains("tall")) body.style.setProperty("--sun-t", Math.ceil(sun.bottom - b.top + 6) + "px");
    else if (sun.left + sun.width / 2 >= b.left + b.width / 2) body.style.setProperty("--sun-r", Math.ceil(b.right - sun.left + 6) + "px");
    else body.style.setProperty("--sun-l", Math.ceil(sun.right - b.left + 6) + "px");
  }
  addEventListener("resize", keepClearOfSun);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (floating) placeFloat(store.get(FLOAT_KEY, null));
  if (floating) popIn();
  else enter(at);

  function placeFloat(spot) {
    // Moved by its bar it keeps the size it has (it went back to 360 wide: the owner, "크기가 원상 복구").
    const now = panel.style.width ? panel.getBoundingClientRect().width : 360;
    const w = Math.round(Math.min(innerWidth - 16, spot && Number.isFinite(spot.w) ? Math.max(MIN_SIDE, spot.w) : now));
    const x = spot && Number.isFinite(spot.x) ? spot.x : innerWidth - w - 12;
    const y = spot && Number.isFinite(spot.y) ? spot.y : 72;
    panel.style.width = w + "px";
    if (spot && Number.isFinite(spot.h)) {
      panel.style.height = Math.round(Math.min(innerHeight - 16, Math.max(MIN_SIDE, spot.h))) + "px";
      panel.style.maxHeight = "none";
    }
    panel.style.left = Math.round(Math.max(8, Math.min(innerWidth - w - 8, x))) + "px";
    panel.style.top = Math.round(Math.max(8, Math.min(innerHeight - 120, y))) + "px";
  }

  // The size it was last drawn to at this edge (or floating, in placeFloat).
  function sizeAtEdge() {
    if (floating) return;
    const saved = store.get(SIZE_KEY, {})?.[edge];
    panel.style.width = "";
    panel.style.height = "";
    if (!Number.isFinite(saved)) return;
    if (edge === "left" || edge === "right") panel.style.width = Math.round(Math.max(MIN_SIDE, Math.min(innerWidth * 0.92, saved))) + "px";
    else panel.style.height = Math.round(Math.max(MIN_SIDE, Math.min(innerHeight * 0.9, saved))) + "px";
  }
  sizeAtEdge();

  // Small enough, it keeps only the houses (the search goes), laid along its longer side.
  const shape = () => {
    const w = panel.clientWidth;
    // A floating one not drawn to a size takes the height of what it holds (which is less when small).
    const ht = floating && !panel.style.height ? Infinity : panel.clientHeight;
    const compact = w < 170 || ht < 240;
    const tall = ht > w * 1.15;
    panel.classList.toggle("compact", compact);
    panel.classList.toggle("tall", compact && tall);
    panel.classList.toggle("wide", compact && !tall);
    keepClearOfSun();
  };
  const shapeWatch = typeof ResizeObserver === "function" ? new ResizeObserver(() => shape()) : null;
  shapeWatch?.observe(panel);
  shape();

  {
    let s = null;
    sizer.addEventListener("pointerdown", (e) => {
      if (!open || s || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault();
      e.stopPropagation();
      const r = panel.getBoundingClientRect();
      s = { id: e.pointerId, x0: e.clientX, y0: e.clientY, w: r.width, h: r.height };
      try { sizer.setPointerCapture(e.pointerId); } catch { /* fine */ }
      for (const a of panel.getAnimations()) a.cancel();
      panel.classList.add("sizing");
    });
    sizer.addEventListener("pointermove", (e) => {
      if (!s || e.pointerId !== s.id) return;
      const dx = e.clientX - s.x0;
      const dy = e.clientY - s.y0;
      if (floating) {
        const r = panel.getBoundingClientRect();
        panel.style.width = Math.round(Math.max(MIN_SIDE, Math.min(innerWidth - r.left - 8, s.w + dx))) + "px";
        panel.style.height = Math.round(Math.max(MIN_SIDE, Math.min(innerHeight - r.top - 8, s.h + dy))) + "px";
        panel.style.maxHeight = "none";
      } else if (edge === "left" || edge === "right") {
        panel.style.width = Math.round(Math.max(MIN_SIDE, Math.min(innerWidth * 0.92, s.w + (edge === "left" ? dx : -dx)))) + "px";
      } else {
        panel.style.height = Math.round(Math.max(MIN_SIDE, Math.min(innerHeight * 0.9, s.h + (edge === "top" ? dy : -dy)))) + "px";
      }
      shape();
    });
    const doneSizing = (e) => {
      if (!s || e.pointerId !== s.id) return;
      s = null;
      panel.classList.remove("sizing");
      const r = panel.getBoundingClientRect();
      if (floating) store.set(FLOAT_KEY, { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
      else store.set(SIZE_KEY, { ...(store.get(SIZE_KEY, {}) || {}), [edge]: Math.round(edge === "left" || edge === "right" ? r.width : r.height) });
    };
    sizer.addEventListener("pointerup", doneSizing);
    sizer.addEventListener("pointercancel", doneSizing);
    sizer.addEventListener("touchmove", (e) => { if (s) e.preventDefault(); }, { passive: false });
  }

  for (const strip of sides) {
    let s = null;
    const left = strip.classList.contains("left");
    strip.addEventListener("pointerdown", (e) => {
      if (!open || s || locked || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault();
      e.stopPropagation();
      const r = panel.getBoundingClientRect();
      s = { id: e.pointerId, x0: e.clientX, left: r.left, right: r.right };
      try { strip.setPointerCapture(e.pointerId); } catch { /* fine */ }
      panel.classList.add("sizing");
    });
    strip.addEventListener("pointermove", (e) => {
      if (!s || e.pointerId !== s.id) return;
      const dx = e.clientX - s.x0;
      if (left) {
        const x = Math.max(8, Math.min(s.right - MIN_SIDE, s.left + dx));
        panel.style.left = Math.round(x) + "px";
        panel.style.width = Math.round(s.right - x) + "px";
      } else {
        panel.style.width = Math.round(Math.max(MIN_SIDE, Math.min(innerWidth - 8 - s.left, s.right - s.left + dx))) + "px";
      }
      shape();
    });
    const done = (e) => {
      if (!s || e.pointerId !== s.id) return;
      s = null;
      panel.classList.remove("sizing");
      const r = panel.getBoundingClientRect();
      store.set(FLOAT_KEY, { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), ...(panel.style.height ? { h: Math.round(r.height) } : {}) });
    };
    strip.addEventListener("pointerup", done);
    strip.addEventListener("pointercancel", done);
    strip.addEventListener("touchmove", (e) => { if (s) e.preventDefault(); }, { passive: false });
  }

  function popIn() {
    if (reduced || !panel.animate) return;
    entering = true;
    const done = () => { entering = false; keepClearOfSun(); };
    panel.animate([{ opacity: 0, transform: "translateY(-8px) scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }).finished.then(done, done);
  }

  if (floating) {
    let d = null;
    head.addEventListener("pointerdown", (e) => {
      // Locked, it stays where it is.
      if (locked || e.target.closest("button") || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      d = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
      try { head.setPointerCapture(e.pointerId); } catch { /* fine */ }
      panel.classList.add("held");
    });
    head.addEventListener("pointermove", (e) => {
      if (!d || e.pointerId !== d.id) return;
      placeFloat({ x: e.clientX - d.dx, y: e.clientY - d.dy });
    });
    const drop = (e) => {
      if (!d || e.pointerId !== d.id) return;
      d = null;
      panel.classList.remove("held");
      const r = panel.getBoundingClientRect();
      const was = store.get(FLOAT_KEY, null) || {};
      store.set(FLOAT_KEY, { ...(Number.isFinite(was.w) ? { w: was.w } : {}), ...(Number.isFinite(was.h) ? { h: was.h } : {}), x: Math.round(r.left), y: Math.round(r.top) });
    };
    head.addEventListener("pointerup", drop);
    head.addEventListener("pointercancel", drop);
    head.addEventListener("touchmove", (e) => { if (d) e.preventDefault(); }, { passive: false });
  }

  /**
   * Comes out of the light: a sliver of glass where the edge was lit, opening along the edge and
   * into the screen as the panel slides out.
   */
  function enter(spot) {
    if (reduced || !panel.animate) return;
    const r = panel.getBoundingClientRect();
    const side = edge === "left" || edge === "right";
    const ox = side ? (edge === "right" ? r.width : 0) : Math.max(0, Math.min(r.width, spot * innerWidth - r.left));
    const oy = side ? Math.max(0, Math.min(r.height, spot * innerHeight - r.top)) : (edge === "bottom" ? r.height : 0);
    const band = 28;
    const sliver = side
      ? `inset(${Math.max(0, oy - band)}px ${edge === "left" ? r.width - 12 : 0}px ${Math.max(0, r.height - oy - band)}px ${edge === "right" ? r.width - 12 : 0}px round 14px)`
      : `inset(${edge === "bottom" ? r.height - 12 : 0}px ${Math.max(0, r.width - ox - band)}px ${edge === "top" ? r.height - 12 : 0}px ${Math.max(0, ox - band)}px round 14px)`;
    const slid = { right: "translate(16%, 0px)", left: "translate(-16%, 0px)", top: "translate(0px, -16%)", bottom: "translate(0px, 16%)" }[edge];
    panel.style.transformOrigin = `${ox}px ${oy}px`;
    const open = "inset(-48px -48px -48px -48px round 14px)";
    entering = true;
    const anim = panel.animate([
      { clipPath: sliver, transform: `${slid} scale(0.94)`, opacity: 0.55, offset: 0 },
      { clipPath: open, offset: 0.55 },
      { clipPath: open, transform: "translate(0px, 0px) scale(1)", opacity: 1, offset: 1 },
    ], { duration: 480, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
    const done = () => { entering = false; keepClearOfSun(); };
    anim.finished.then(done, done);
  }
  let open = true;

  // ---- the grip: held, the panel follows; thrown, it goes away or to another edge ------------

  const aim = aimMarker();
  for (const handle of [grip, end]) {
    let g = null;
    handle.addEventListener("pointerdown", (e) => {
      // Its buttons are pressed, not held as the bar.
      if (!open || g || (e.pointerType === "mouse" && e.button !== 0) || e.target.closest?.("button")) return;
      e.preventDefault();
      g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, track: new VelocityTracker() };
      g.track.add(e.timeStamp, e.clientX, e.clientY);
      try { handle.setPointerCapture(e.pointerId); } catch { /* fine */ }
      for (const a of panel.getAnimations()) a.cancel();
      panel.classList.add("held");
    });
    handle.addEventListener("pointermove", (e) => {
      if (!g || e.pointerId !== g.id) return;
      for (const one of e.getCoalescedEvents?.() || [e]) g.track.add(one.timeStamp, one.clientX, one.clientY);
      g.x = e.clientX;
      g.y = e.clientY;
      const dx = g.x - g.x0;
      const dy = g.y - g.y0;
      panel.style.transform = `translate(${dx}px, ${dy}px)`;
      const now = judge(g, e.timeStamp);
      // Toward its own edge it fades as it goes; toward another, a light shows where it will land
      // (locked, it goes nowhere else).
      panel.style.opacity = now.act === "close" ? "0.75" : "";
      aim.show(now.act === "move" && !locked ? spotOn(now) : null);
    });
    const letGo = (e) => {
      if (!g || e.pointerId !== g.id) return;
      g.track.add(e.timeStamp, e.clientX, e.clientY);
      g.x = e.clientX;
      g.y = e.clientY;
      const now = e.type === "pointerup" ? judge(g, e.timeStamp) : { act: "stay" };
      const from = [g.x - g.x0, g.y - g.y0];
      g = null;
      aim.hide();
      panel.classList.remove("held");
      panel.style.opacity = "";
      if (now.act === "close") return close({ from });
      if (now.act === "move" && !locked) return relocate(now, from);
      settle(from);
    };
    handle.addEventListener("pointerup", letGo);
    handle.addEventListener("pointercancel", letGo);
  }

  // A swipe anywhere on it toward its own edge puts it away (the owner: "그냥 스와이프해도 되게 없애는
  // 거는"); moving it elsewhere stays with its bar. Not while locked, and not while what it holds can
  // still scroll that way.
  if (!floating) {
    let sw = null;
    body.addEventListener("pointerdown", (e) => {
      if (!open || locked || sw || (e.pointerType === "mouse" && e.button !== 0) || e.target.closest?.("input, textarea")) return;
      sw = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, on: false, track: new VelocityTracker() };
      sw.track.add(e.timeStamp, e.clientX, e.clientY);
    });
    body.addEventListener("pointermove", (e) => {
      if (!sw || e.pointerId !== sw.id) return;
      for (const one of e.getCoalescedEvents?.() || [e]) sw.track.add(one.timeStamp, one.clientX, one.clientY);
      sw.x = e.clientX;
      sw.y = e.clientY;
      const dx = sw.x - sw.x0;
      const dy = sw.y - sw.y0;
      if (!sw.on) {
        if (Math.hypot(dx, dy) < 10) return;
        const toward = {
          bottom: dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.2 && body.scrollTop <= 0,
          top: dy < 0 && Math.abs(dy) > Math.abs(dx) * 1.2 && body.scrollTop + body.clientHeight >= body.scrollHeight - 1,
          left: dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.2,
          right: dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.2,
        }[edge];
        if (!toward) { sw = null; return; }
        sw.on = true;
        try { body.setPointerCapture(sw.id); } catch { /* fine */ }
        for (const a of panel.getAnimations()) a.cancel();
        panel.classList.add("held");
      }
      panel.style.transform = edge === "left" ? `translate(${Math.min(0, dx)}px, 0px)` : edge === "right" ? `translate(${Math.max(0, dx)}px, 0px)`
        : edge === "top" ? `translate(0px, ${Math.min(0, dy)}px)` : `translate(0px, ${Math.max(0, dy)}px)`;
    });
    const swEnd = (e) => {
      if (!sw || e.pointerId !== sw.id) return;
      const was = sw;
      sw = null;
      if (!was.on) return;
      panel.classList.remove("held");
      const side = edge === "left" || edge === "right";
      const sign = edge === "right" || edge === "bottom" ? 1 : -1;
      const d = Math.max(0, (side ? was.x - was.x0 : was.y - was.y0) * sign) * sign;
      const v = was.track.velocity(e.timeStamp);
      const speed = (side ? v.vx : v.vy) * sign;
      const size = side ? panel.offsetWidth : panel.offsetHeight;
      const from = side ? [d, 0] : [0, d];
      if (e.type === "pointerup" && (Math.abs(d) > size * 0.25 || speed > 0.45)) return close({ from });
      settle(from);
    };
    body.addEventListener("pointerup", swEnd);
    body.addEventListener("pointercancel", swEnd);
    body.addEventListener("touchmove", (e) => { if (sw?.on) e.preventDefault(); }, { passive: false });
  }

  function judge(g, time) {
    const v = g.track.velocity(time);
    const r = panel.getBoundingClientRect();
    const side = edge === "left" || edge === "right";
    return gripThrow({ x0: g.x0, y0: g.y0, x1: g.x, y1: g.y, vx: v.vx, vy: v.vy, w: innerWidth, h: innerHeight, home: edge, size: side ? r.width : r.height });
  }

  const spotOn = ({ edge: e, at: a }) => (e === "left" || e === "right" ? { edge: e, x: e === "left" ? 0 : innerWidth, y: a * innerHeight } : { edge: e, x: a * innerWidth, y: e === "top" ? 0 : innerHeight });

  /** Not thrown far or fast enough: back where it was. */
  function settle([dx, dy]) {
    panel.style.transform = "";
    if (reduced || !panel.animate) return;
    panel.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }], { duration: 320, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
  }

  /** Thrown toward another edge: it flies off that way, the edge lights where it lands, and it comes out there. */
  async function relocate({ edge: to, at: spot, strength }, [dx, dy]) {
    const d = Math.hypot(dx, dy) || 1;
    rememberPanelEdge(store, { edge: to, at: spot });
    const fly = reduced || !panel.animate ? null : panel.animate([
      { transform: `translate(${dx}px, ${dy}px)`, opacity: 1 },
      { transform: `translate(${dx + (dx / d) * 180}px, ${dy + (dy / d) * 180}px) scale(0.92)`, opacity: 0 },
    ], { duration: 190, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
    entering = true;
    await Promise.all([fly?.finished.catch(() => {}), glowEdge({ edge: to, at: spot, strength, delay: 60, onImpact: () => buzz(app, 8) })]);
    if (!open) return;
    fly?.cancel();
    panel.style.transform = "";
    edge = to;
    panel.dataset.edge = to;
    placeControls();
    sizeAtEdge();
    shape();
    enter(spot);
  }

  /**
   * Thrown at the edge it already stands on (the owner, 21 November: "그쪽으로 또 보낸다면… 보내지는
   * 쪽으로 아주 약간 찌그러지고… 보낸 그 각도의 그 부분부터 약간 찌부되는데 그거랑 멀어질수록 찌부가
   * 안 되도록… 공이 던져져 간다고 했을 때 먼저 닿는 면적부터… 갈수록 줄어드는… 빨리 복구… 애플같이 세련되게"):
   * when the ball arrives, its inner end gives way where it was hit (deepest there, less further off),
   * the dent widens as it eases and springs back, quick enough to be whole before the next throw.
   */
  let squashing = null;
  function squash({ at = 0.5, strength = 0.4, delay = 0 } = {}) {
    if (!open || floating || reduced || !panel.animate) return Promise.resolve();
    squashing?.cancel();
    const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const r = panel.getBoundingClientRect();
    const side = edge === "left" || edge === "right";
    const len = side ? r.height : r.width;
    const depth = side ? r.width : r.height;
    // Where it was hit along the inner end, in the panel's own length.
    const u0 = Math.max(0, Math.min(len, (side ? at * innerHeight - r.top : at * innerWidth - r.left)));
    const s = Math.max(0.15, Math.min(1, strength));
    const deep = Math.min(depth * 0.18, (10 + 16 * s) * (remPx() / 16));
    const width = (48 + 70 * s) * (remPx() / 16);
    const out = 48; // past the panel, so its shadow stays wherever it is not dented
    const N = 36;
    // (u along the inner end, v into the panel from it) → the panel's own corner-based px.
    const toXY = (u, v) => ({ bottom: [u, v], top: [u, r.height - v], left: [r.width - v, u], right: [v, u] }[edge]);
    const shape = (k, spread) => {
      const sig = width * spread;
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const u = -out + ((len + 2 * out) * i) / N;
        const bell = Math.exp(-((u - u0) ** 2) / (2 * sig * sig));
        // Far from the hit the line runs outside the panel (nothing is cut), near it inside (the dent).
        const v = deep * k * bell - out * (1 - Math.min(1, bell * 2.2));
        pts.push(toXY(u, v));
      }
      // Round the far side, wide of the panel, back to the start.
      const far = depth + out;
      pts.push(toXY(len + out, far), toXY(-out, far));
      return `polygon(${pts.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(", ")})`;
    };
    // A ball's hit: in fast, out with one small give, settled (about a third of a second).
    const keys = [[0, 0, 1], [0.16, 1, 1], [0.34, 0.55, 1.35], [0.52, 0.18, 1.7], [0.72, 0.05, 1.9], [1, 0, 2]];
    // Each step eases on its own (an easing over the whole would keep the dent from ever going deep).
    const frames = keys.map(([offset, k, spread], i) => ({ offset, clipPath: shape(k, spread), easing: i === 0 ? "cubic-bezier(0.2, 0.9, 0.4, 1)" : "cubic-bezier(0.35, 0, 0.3, 1)" }));
    const into = { bottom: [0, 1], top: [0, -1], left: [-1, 0], right: [1, 0] }[edge];
    const push = (1.5 + 2.5 * s) * (remPx() / 16);
    const nudge = [{ translate: "0 0" }, { translate: `${into[0] * push}px ${into[1] * push}px`, offset: 0.18 }, { translate: "0 0" }];
    return new Promise((resolve) => {
      setTimeout(() => {
        if (!open) return resolve();
        squashing = panel.animate(frames, { duration: 380 });
        panel.animate(nudge, { duration: 300, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" });
        buzz(app, 8);
        squashing.finished.then(() => resolve(), () => resolve());
      }, delay);
    });
  }

  const onKey = (e) => { if (e.key === "Escape") close(); };
  // Leaving the app and coming back finds home as it was: no search, no panel.
  const onHide = () => { if (document.visibilityState === "hidden") close({ now: true, forget: true }); };
  // A tap on an empty place puts it away; a room, a button, a field keep working and it stays out,
  // and a finger that moves (scrolling the rooms) leaves it out too. Floating, it stays until it is
  // put away by its own ✕ or the icon (like 레퍼런스).
  let tap = null;
  const onOutside = (e) => {
    tap = null;
    if (floating || !open || entering || panel.contains(e.target)) return;
    if (e.target.closest?.("button, a, input, textarea, select, label, [role='button'], .room-cell, .room-row, .home-top, .house-dock, .room-ghost, .sheet, .toast, .notice")) return;
    tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
  };
  const onOutsideUp = (e) => {
    if (!tap || e.pointerId !== tap.id) return;
    const ok = Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 10 && e.timeStamp - tap.t < 600;
    tap = null;
    if (ok && open) close();
  };
  const onLeave = () => close({ now: true });
  // A sheet opened from home (a room's actions, 설정) is not covered: the panel at an edge steps
  // aside; floating, it stays like 레퍼런스.
  const onSheet = () => { if (!floating) close({ now: true }); };
  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onHide);
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("pointerup", onOutsideUp, true);
  document.addEventListener("sheet-open", onSheet);
  addEventListener("hashchange", onLeave);

  function close({ now = false, forget = false, from = [0, 0] } = {}) {
    if (!open) return;
    open = false;
    aim.hide();
    shapeWatch?.disconnect();
    if (!forget && query.trim()) rememberSearch(store, query, max());
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", onHide);
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("pointerup", onOutsideUp, true);
    document.removeEventListener("sheet-open", onSheet);
    removeEventListener("hashchange", onLeave);
    removeEventListener("resize", keepClearOfSun);
    const gone = () => { panel.remove(); scrim.remove(); };
    if (now || reduced || !panel.animate) return gone();
    if (floating) {
      panel.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-8px) scale(0.96)" }], { duration: 200, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" }).finished.then(gone, gone);
      return;
    }
    // Out the way it came, from wherever the finger left it.
    const [fx, fy] = from;
    const out = { right: `translate(105%, ${fy}px)`, left: `translate(-105%, ${fy}px)`, top: `translate(${fx}px, -105%)`, bottom: `translate(${fx}px, 105%)` }[edge];
    panel.style.transform = "";
    panel.animate([{ transform: `translate(${fx}px, ${fy}px)`, opacity: 1 }, { transform: out, opacity: 0.4 }], { duration: 260, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" }).finished.then(gone, gone);
    scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: "forwards" });
  }

  const goRoom = (id) => {
    if (query.trim()) rememberSearch(store, query, max());
    close({ now: true });
    app.go("r-" + id);
  };

  function draw() {
    if (!open) return;
    // A house open in the panel takes a room held and dropped anywhere on it.
    if (view.name === "house") panel.dataset.dropHouse = view.id;
    else delete panel.dataset.dropHouse;
    if (view.name === "house") drawHouse();
    else if (view.name === "build") drawBuild();
    else drawMain();
    keepClearOfSun();
  }

  // ---- 찾기 + 집 ----------------------------------------------------------------------------

  function drawMain() {
    const results = h("div", { class: "search-results", id: "search-results", "aria-live": "polite" });
    const field = h("input", { class: "input search-input", id: "home-search", type: "search", enterkeyhint: "search", autocomplete: "off", spellcheck: "false",
      placeholder: mode === "name" ? "방 이름 (ㅅㅌ처럼 초성도)" : "쓴 글, 녹음 이름, 메모",
      value: query,
      oninput: () => { query = field.value; fill(); },
      onkeydown: (e) => { if (e.key === "Enter") { rememberSearch(store, query, max()); field.blur(); } } });
    const modes = segmented([["name", "이름", "search-by-name"], ["words", "내용", "search-by-words"]], mode, (m) => {
      mode = m;
      field.placeholder = m === "name" ? "방 이름 (ㅅㅌ처럼 초성도)" : "쓴 글, 녹음 이름, 메모";
      fill();
    }, "searchMode");
    modes.classList.add("search-modes");
    const fill = () => results.replaceChildren(...resultsFor(), ...[]);
    function resultsFor() {
      const q = query.trim();
      if (!q) {
        const recent = recentSearches(store, max());
        if (!recent.length) return [];
        return [h("div", { class: "recent", id: "recent-searches" },
          h("span", { class: "group-label", text: "최근 검색" }),
          h("div", { class: "recent-chips" }, recent.map((r) => h("button", { class: "chip recent-chip", type: "button", text: r, onclick: () => { query = r; field.value = r; fill(); } }))),
          h("button", { class: "link-btn", id: "recent-clear", type: "button", text: "지우기", onclick: () => { forgetSearches(store); fill(); } }))];
      }
      const all = rooms();
      if (mode === "name") {
        const found = rankByName(all, q);
        if (!found.length) return [h("p", { class: "help", id: "no-results", text: "그런 이름의 방이 없어요" })];
        return found.map(({ item, at, len }) => hit(item, marked(item.name || "방", at, len)));
      }
      const words = roomWords(store);
      const found = [];
      for (const r of all) {
        const w = words[r.id];
        const s = w && snippet(w.text, q, 14);
        if (s) found.push([r, s]);
      }
      const unread = all.filter((r) => !words[r.id]).length;
      return [
        ...found.map(([r, s]) => hit(r, r.name || "방", h("span", { class: "hit-words" }, s.before.replace(/\n/g, " "), h("mark", { text: s.match }), s.after.replace(/\n/g, " ")))),
        !found.length && h("p", { class: "help", id: "no-results", text: "그런 내용이 있는 방이 없어요" }),
        unread > 0 && h("p", { class: "help small", text: `이 기기에서 아직 열어 보지 않은 방 ${unread}개는 내용을 몰라요` }),
      ].filter(Boolean);
    }
    function hit(room, name, extra = null) {
      const kind = kindInfo(room.kind);
      const home = houseOf(store, room.id);
      return h("button", { class: "search-hit", type: "button", data: { room: room.id }, onclick: () => goRoom(room.id) },
        h("span", { class: "hit-name" }, ...(Array.isArray(name) ? name : [name])),
        h("span", { class: "hit-meta" }, icon(kind?.icon || "lines"), kind?.name || "방", home && h("span", { class: "hit-house", text: "· " + home.name })),
        extra);
    }
    const list = houses(store);
    body.replaceChildren(
        h("div", { class: "search-row" }, h("span", { class: "search-icon", "aria-hidden": "true" }, icon("search")), field, modes),
        results,
        h("section", { class: "houses", id: "houses" },
          h("h2", { class: "houses-title" }, "집", list.length > 0 && h("span", { class: "houses-count", text: String(list.length) })),
          !list.length && h("p", { class: "help small", text: "방을 꾹 눌러 끌어다 집에 넣을 수 있어요." }),
          h("div", { class: "house-grid", id: "house-grid" },
            ...list.map((house) => h("button", { class: "house-tile", type: "button", data: { house: house.id }, "aria-label": `${house.name} (방 ${house.rooms.length}개)`,
              onclick: () => { view = { name: "house", id: house.id }; draw(); } },
              houseShape(house),
              h("span", { class: "house-name", text: house.name }),
              house.rooms.length > 0 && h("span", { class: "house-count", text: String(house.rooms.length) }))),
            h("button", { class: "house-tile house-new", id: "house-new", type: "button", "aria-label": "집 짓기", onclick: () => { view = { name: "build" }; draw(); } },
              h("span", { class: "house-shape house-plan", "aria-hidden": "true" }, icon("plus")),
              h("span", { class: "house-name", text: "집 짓기" })))));
    fill();
  }

  // ---- one house ----------------------------------------------------------------------------

  function drawHouse() {
    const house = houses(store).find((x) => x.id === view.id);
    if (!house) {
      view = { name: "main" };
      return draw();
    }
    const known = new Map(rooms().map((r) => [r.id, r]));
    const inside = house.rooms.map((id) => known.get(id)).filter(Boolean);
    let asking = false;
    const actions = h("div", { class: "house-actions" });
    const paintActions = () => actions.replaceChildren(...(asking
      ? [h("p", { class: "help", text: "이 집을 허물까요? 방은 그대로 홈으로 돌아가요." }),
        h("button", { class: "chip danger", id: "house-remove-yes", type: "button", text: "허물기", onclick: () => { removeHouse(store, house.id); changed(); view = { name: "main" }; draw(); toast(root, "집을 허물었어요. 방은 홈에 있어요"); } }),
        h("button", { class: "chip", type: "button", text: "그대로 두기", onclick: () => { asking = false; paintActions(); } })]
      : [h("button", { class: "chip", id: "house-edit", type: "button", text: "꾸미기", onclick: () => { view = { name: "build", id: house.id }; draw(); } }),
        h("button", { class: "chip", id: "house-remove", type: "button", text: "허물기", onclick: () => { asking = true; paintActions(); } })]));
    paintActions();
    body.replaceChildren(
        h("div", { class: "house-head" },
          h("button", { class: "icon-btn", id: "house-back", type: "button", "aria-label": "뒤로", onclick: () => { view = { name: "main" }; draw(); } }, icon("back")),
          h("span", { class: "house-head-shape" }, houseShape(house)),
          h("h2", { class: "house-head-name", text: house.name })),
        inside.length
          ? h("div", { class: "house-rooms", id: "house-rooms" }, inside.map((r) => {
            const kind = kindInfo(r.kind);
            return h("div", { class: "house-room", data: { room: r.id } },
              h("button", { class: "search-hit", type: "button", onclick: () => goRoom(r.id) },
                h("span", { class: "hit-name", text: r.name || "방" }),
                h("span", { class: "hit-meta" }, icon(kind?.icon || "lines"), kind?.name || "방")),
              h("button", { class: "chip", type: "button", data: { takeOut: r.id }, text: "꺼내기", onclick: () => { takeOutOfHouse(store, r.id); changed(); draw(); toast(root, `'${r.name || "방"}'을(를) 홈으로 꺼냈어요`); } }));
          }))
          : h("p", { class: "help", id: "house-empty", text: "아직 빈 집이에요. 홈에서 방을 꾹 눌러 끌어다 넣어요." }),
        actions);
  }

  // ---- 집 짓기 / 꾸미기 ------------------------------------------------------------------------

  function drawBuild() {
    const old = view.id ? houses(store).find((x) => x.id === view.id) : null;
    const draft = { name: old?.name || "", color: old?.color || HOUSE_COLORS[0][0], icon: old?.icon || HOUSE_ICONS[0] };
    const preview = h("span", { class: "build-preview" });
    const paint = () => preview.replaceChildren(houseShape(draft));
    paint();
    const name = h("input", { class: "input", id: "house-name", maxlength: 30, autocomplete: "off", placeholder: "집 이름 (예: 우리 가족)", value: draft.name, oninput: () => { draft.name = name.value; } });
    const colors = h("div", { class: "house-colors", id: "house-colors", role: "group", "aria-label": "집 색" },
      HOUSE_COLORS.map(([k, c, label]) => h("button", { class: "house-color", type: "button", data: { color: k }, "aria-label": label, "aria-pressed": String(draft.color === k), style: { background: c },
        onclick: (e) => { draft.color = k; for (const b of colors.children) b.setAttribute("aria-pressed", String(b === e.currentTarget)); paint(); } })));
    const icons = h("div", { class: "house-icons", id: "house-icons", role: "group", "aria-label": "집 아이콘" },
      HOUSE_ICONS.map((k) => h("button", { class: "house-icon-pick", type: "button", data: { icon: k }, "aria-pressed": String(draft.icon === k), "aria-label": k,
        onclick: (e) => { draft.icon = k; for (const b of icons.children) b.setAttribute("aria-pressed", String(b === e.currentTarget)); paint(); } }, icon(k))));
    const save = () => {
      if (old) {
        updateHouse(store, old.id, draft);
        changed();
        view = { name: "house", id: old.id };
      } else {
        const made = addHouse(store, draft);
        if (view.room) {
          putInHouse(store, view.room, made.id);
          toast(root, `'${made.name}'에 넣었어요`);
        }
        changed();
        view = view.room ? { name: "main" } : { name: "house", id: made.id };
      }
      draw();
    };
    body.replaceChildren(
        h("div", { class: "house-head" },
          h("button", { class: "icon-btn", id: "build-back", type: "button", "aria-label": "뒤로", onclick: () => { view = old ? { name: "house", id: old.id } : { name: "main" }; draw(); } }, icon("back")),
          h("h2", { class: "house-head-name", text: old ? "집 꾸미기" : "집 짓기" })),
        h("div", { class: "build" }, preview,
          h("div", { class: "form" },
            name,
            h("span", { class: "label", text: "색" }), colors,
            h("span", { class: "label", text: "아이콘" }), icons,
            h("button", { class: "btn", id: "house-save", type: "button", text: old ? "저장" : "짓기", onclick: save }))));
    if (!old) setTimeout(() => name.focus({ preventScroll: true }), 80);
  }

  draw();
  // nodes: home draws itself anew by replacing what it holds; it puts these back after.
  return {
    close, show: (next) => { view = next; draw(); }, isOpen: () => open, nodes: [scrim, panel],
    floating, edge: () => edge, locked: () => locked,
    // Locked and ⋮ pressed: it stays, with a small shake to say so.
    nudge: () => {
      toast(root, "잠겨 있어요. 왼쪽 위 자물쇠로 풀어요", 1600);
      if (!reduced && panel.animate) panel.animate([{ translate: "0 0" }, { translate: "-5px 0" }, { translate: "5px 0" }, { translate: "0 0" }], { duration: 260 });
    },
    squash: (hit) => squash(hit),
    // Somewhere else on the screen (the owner: "그걸 눌러서 다른 위치로 그게 옮겨가게").
    moveTo: (to, spot = 0.5, strength = 0.3) => { if (open && !floating && to !== edge) relocate({ edge: to, at: spot, strength }, [0, 0]); },
    refresh: () => draw(),
  };
}
