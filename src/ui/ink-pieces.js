// The drawing rail in pieces, on the screen (core/pieces.js keeps where they are). The owner (27
// November): "겹쳤을때는 끝부분에꺼가 좀 튀어나오는데 그거 꾹 누르면 뭐가 뜨고 거기서 각자거를 빼고 싶은거나
// 그런거를 빼서 어디다가 눌 수도 있고 다시 조립할 수도… 분리된거에서 그거는 아래에 조그마낫게 뭐가 티어나오고
// 그거로 또 꾹누르면 할 수 있게… 90도마다… 가까이 두면 마찬가지로 곂칠수도".
//
// Each stack has a small tab sticking out of its end. Held, every piece comes loose (they part a little
// and sway, as icons do when a phone's home screen is being arranged) and a line says what can be done.
// Then: a piece dragged out stands where it is let go; brought onto or near another stack it joins it
// at the nearer end (that end lights up first); a stack dragged by its tab moves whole; a tab tapped
// turns its stack a quarter clockwise (the icons stay upright; a turned size bar slides along). 다 됐어요,
// or a tap anywhere else, and they are tools again. Out of arranging only the tab listens, so drawing
// never moves a piece.

import { h, closeOnOutside } from "./dom.js";
import { wholeLayout, defaultLayout, putPiece, putStack, turnStack } from "../core/pieces.js";

const HOLD_MS = 450;
const MOVE_PX = 8;
const SNAP_PX = 30;
const EDGE = 8;
const keyOf = (kind) => "inkRail:" + kind;
const states = new WeakMap();

/**
 * This kind of room's arrangement on this device. Never arranged: one stack at the left; on a short,
 * wide screen (a phone on its side) the size half stands at the right, so neither has to scroll.
 */
export function railLayout(store, kind) {
  const kept = store.get(keyOf(kind), null);
  if (kept) return wholeLayout(kept);
  if (innerHeight < 520 && innerWidth > innerHeight) {
    return wholeLayout({ stacks: [{ pieces: ["tools", "color"], dock: true }, { pieces: ["size", "widths"], dock: false, x: 0.94, y: 0.15, turn: 0 }] });
  }
  return defaultLayout();
}

function stateOf(panel) {
  let st = states.get(panel);
  if (!st) {
    st = { floats: [], arranging: false, bar: null, stopOutside: null, ctx: null, layout: null };
    st.onResize = () => (panel.isConnected ? placeFloats(st) : releasePieces(panel));
    addEventListener("resize", st.onResize);
    states.set(panel, st);
    wireStack(panel, panel, st);
  }
  return st;
}

/** Every glass of this rail: the dock (the panel) and its floating stacks. */
export function railParts(panel) {
  const st = states.get(panel);
  return st ? [panel, ...st.floats] : [panel];
}

/**
 * Puts the rail's pieces where this kind of room keeps them: the dock's in `panel` (the rail in its
 * band), each floating stack in a glass of its own beside it in the room. parts: each piece's buttons
 * ({ tools, color, size, widths }); hidden: pieces not shown now (크기 and 빠른 굵기 while pointing);
 * redraw(): builds the tools again (after the arrangement changed).
 */
export function placePieces(panel, parts, { store, kind, hidden = new Set(), redraw }) {
  const st = stateOf(panel);
  st.ctx = { store, kind, redraw, hidden };
  st.layout = railLayout(store, kind);
  panel.classList.add("pieced");
  build(panel, st.layout.stacks[0], 0, parts, hidden);
  const floats = st.layout.stacks.slice(1);
  while (st.floats.length > floats.length) st.floats.pop().remove();
  const room = panel.parentElement;
  floats.forEach((stack, k) => {
    let el = st.floats[k];
    // Kept from before, not made again (a finger may be on it).
    if (!el) {
      el = h("div", { class: "ink-tools rail pieced floating", role: "toolbar", "aria-label": "그리기 도구 조각" });
      st.floats[k] = el;
      wireStack(panel, el, st);
    }
    if (room && el.parentElement !== room) panel.after(el);
    el.hidden = panel.hidden;
    build(el, stack, k + 1, parts, hidden);
  });
  for (const el of railParts(panel)) el.classList.toggle("arranging", st.arranging);
  placeFloats(st);
}

/** The pieces of one stack into its glass, a separator between those shown, its tab at its end. */
function build(el, stack, i, parts, hidden) {
  el.dataset.stack = String(i);
  el.dataset.turn = String(stack.turn || 0);
  const shown = stack.pieces.filter((p) => !hidden.has(p) && parts[p]?.length);
  const kids = [];
  for (const p of stack.pieces) {
    const on = shown.includes(p);
    if (on && shown.indexOf(p) > 0) kids.push(h("span", { class: "ink-sep", "aria-hidden": "true" }));
    kids.push(h("div", { class: "ink-piece", data: { piece: p }, hidden: !on }, ...(on ? parts[p] : [])));
  }
  let body = el.querySelector(":scope > .ink-stack");
  if (!body) {
    body = h("div", { class: "ink-stack" });
    el.prepend(body);
  }
  body.replaceChildren(...kids);
  if (!el.querySelector(":scope > .ink-tab")) {
    el.append(h("button", { class: "ink-tab", type: "button", "aria-label": "조각 손잡이: 꾹 누르면 조각을 떼어 옮기고, 그다음 톡 누르면 90도 돌려요" }, h("span", { class: "ink-tab-grip", "aria-hidden": "true" })));
  }
  el.classList.toggle("empty", !shown.length);
}

/** Floating stacks where they were put (as shares of the screen), kept whole on it. */
function placeFloats(st) {
  st.floats.forEach((el, k) => {
    const s = st.layout?.stacks[k + 1];
    if (!s || !el.isConnected) return;
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    el.style.left = Math.round(Math.max(EDGE, Math.min(innerWidth - w - EDGE, s.x * innerWidth))) + "px";
    el.style.top = Math.round(Math.max(EDGE, Math.min(innerHeight - hgt - EDGE, s.y * innerHeight))) + "px";
  });
}

/** The pieces' own line while they are being arranged: what can be done, 처음대로, 다 됐어요. */
function arrange(panel, st, on) {
  if (st.arranging === on) return;
  st.arranging = on;
  for (const el of railParts(panel)) el.classList.toggle("arranging", on);
  st.stopOutside?.();
  st.stopOutside = null;
  if (on) {
    st.bar = h("div", { class: "ink-arrange", id: "ink-arrange", role: "toolbar", "aria-label": "막대 조각 옮기기" },
      h("span", { class: "ink-arrange-text", text: "조각을 끌어 어디든 · 가까이 두면 붙어요 · 손잡이를 톡 = 90° 돌리기" }),
      h("span", { class: "ink-arrange-buttons" },
        h("button", { class: "chip", type: "button", id: "ink-arrange-reset", text: "처음대로", onclick: () => {
          st.ctx.store.set(keyOf(st.ctx.kind), null);
          st.ctx.redraw();
        } }),
        h("button", { class: "chip primary", type: "button", id: "ink-arrange-done", text: "다 됐어요", onclick: () => arrange(panel, st, false) })));
    document.body.append(st.bar);
    const inside = (t) => !!t?.closest?.(".ink-tools.pieced, .ink-arrange, .ink-ghost");
    setTimeout(() => { if (st.arranging) st.stopOutside = closeOnOutside(inside, () => arrange(panel, st, false), st.bar); }, 0);
  } else {
    st.bar?.remove();
    st.bar = null;
  }
}

function save(st, layout) {
  st.layout = layout;
  st.ctx.store.set(keyOf(st.ctx.kind), layout);
  st.ctx.redraw();
}

function wireStack(panel, el, st) {
  // While arranging, every press on a stack is the arranging's (a tool does nothing then).
  el.addEventListener("pointerdown", (e) => onDown(panel, el, st, e), true);
  el.addEventListener("click", (e) => {
    if (!st.arranging && !st.swallow) return;
    st.swallow = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  el.addEventListener("contextmenu", (e) => { if (st.arranging || e.target.closest?.(".ink-tab")) e.preventDefault(); });
}

function onDown(panel, el, st, e) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const tab = e.target.closest?.(".ink-tab");
  if (!st.arranging && !tab) return;
  e.preventDefault();
  if (st.arranging) e.stopPropagation();
  const piece = tab ? null : e.target.closest?.(".ink-piece")?.dataset.piece || null;
  const g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, el, tab: !!tab, piece, was: st.arranging, held: st.arranging, drag: null, timer: 0 };
  if (!g.held) {
    // Held, the pieces come loose (and the press is not a tap on anything).
    g.timer = setTimeout(() => {
      g.held = true;
      st.swallow = true;
      try { navigator.vibrate?.(10); } catch { /* not every device buzzes */ }
      arrange(panel, st, true);
    }, HOLD_MS);
  }
  const end = () => {
    clearTimeout(g.timer);
    removeEventListener("pointermove", move, true);
    removeEventListener("pointerup", up, true);
    removeEventListener("pointercancel", cancel, true);
  };
  const move = (ev) => {
    if (ev.pointerId !== g.id) return;
    const d = Math.hypot(ev.clientX - g.x0, ev.clientY - g.y0);
    if (!g.held) {
      if (d > MOVE_PX) end(); // moved before it was held: not ours
      return;
    }
    ev.preventDefault();
    if (!g.drag && d > MOVE_PX) g.drag = startDrag(panel, st, g, ev);
    if (g.drag) dragTo(panel, st, g.drag, ev);
  };
  const up = (ev) => {
    if (ev.pointerId !== g.id) return;
    end();
    if (g.drag) return void dropAt(panel, st, g.drag);
    // A tap on a tab while arranging: its stack turns a quarter.
    if (g.was && g.tab) turnAt(panel, st, el);
  };
  const cancel = (ev) => {
    if (ev.pointerId !== g.id) return;
    end();
    if (g.drag) {
      g.drag.ghost?.remove();
      st.ctx.redraw();
    }
  };
  addEventListener("pointermove", move, true);
  addEventListener("pointerup", up, true);
  addEventListener("pointercancel", cancel, true);
}

/** A piece (or a whole stack, by its tab) lifted to follow the finger. */
function startDrag(panel, st, g, ev) {
  const index = Number(g.el.dataset.stack) || 0;
  const kind = g.tab ? "stack" : "piece";
  if (kind === "stack" && index > 0) {
    // A float moves itself.
    const r = g.el.getBoundingClientRect();
    g.el.classList.add("lifted");
    return { kind, index, piece: null, ghost: g.el, own: false, dx: ev.clientX - r.left, dy: ev.clientY - r.top, target: null };
  }
  // One piece, or the dock moved whole: lifted into a glass of its own that follows the finger.
  const moving = kind === "piece" ? g.el.querySelector(`.ink-piece[data-piece="${g.piece}"]`) : g.el.querySelector(":scope > .ink-stack");
  if (!moving) return null;
  const r = moving.getBoundingClientRect();
  const body = h("div", { class: "ink-stack" });
  const ghost = h("div", { class: "ink-tools rail pieced floating ink-ghost lifted", "aria-hidden": "true", data: { turn: g.el.dataset.turn || "0" } }, body);
  if (kind === "piece") body.append(moving);
  else body.replaceChildren(...moving.childNodes);
  document.body.append(ghost);
  ghost.style.left = r.left + "px";
  ghost.style.top = r.top + "px";
  return { kind, index, piece: g.piece, ghost, own: true, dx: ev.clientX - r.left, dy: ev.clientY - r.top, target: null };
}

function dragTo(panel, st, drag, ev) {
  if (!drag) return;
  drag.ghost.style.left = ev.clientX - drag.dx + "px";
  drag.ghost.style.top = ev.clientY - drag.dy + "px";
  const r = drag.ghost.getBoundingClientRect();
  const cx = (r.left + r.right) / 2;
  const cy = (r.top + r.bottom) / 2;
  let target = null;
  for (const el of railParts(panel)) {
    const i = Number(el.dataset.stack) || 0;
    if (el === drag.ghost || (drag.kind === "stack" && i === drag.index)) continue;
    const b = el.getBoundingClientRect();
    if (!b.width) continue;
    if (cx < b.left - SNAP_PX || cx > b.right + SNAP_PX || cy < b.top - SNAP_PX || cy > b.bottom + SNAP_PX) continue;
    const turn = Number(el.dataset.turn) || 0;
    const across = turn === 90 || turn === 270;
    const nearFirst = across ? cx < (b.left + b.right) / 2 : cy < (b.top + b.bottom) / 2;
    const side = across ? (nearFirst ? "left" : "right") : nearFirst ? "top" : "bottom";
    const end = { 0: { top: "start", bottom: "end" }, 180: { top: "end", bottom: "start" }, 90: { right: "start", left: "end" }, 270: { left: "start", right: "end" } }[turn][side];
    target = { el, i, side, end };
    break;
  }
  for (const el of railParts(panel)) {
    const on = target?.el === el;
    el.classList.toggle("snap", on);
    if (on) el.dataset.snap = target.side;
    else delete el.dataset.snap;
  }
  drag.target = target;
}

function dropAt(panel, st, drag) {
  if (!drag) return;
  const r = drag.ghost.getBoundingClientRect();
  const to = drag.target ? { stack: drag.target.i, end: drag.target.end } : { x: r.left / innerWidth, y: r.top / innerHeight };
  for (const el of railParts(panel)) {
    el.classList.remove("snap");
    delete el.dataset.snap;
  }
  if (drag.own) drag.ghost.remove();
  else drag.ghost.classList.remove("lifted");
  const layout = drag.kind === "piece" ? putPiece(st.layout, drag.piece, to) : putStack(st.layout, drag.index, to);
  try { navigator.vibrate?.(6); } catch { /* not every device buzzes */ }
  save(st, layout);
}

function turnAt(panel, st, el) {
  const i = Number(el.dataset.stack) || 0;
  if (!i) {
    // The dock stands upright at its edge; a piece taken off it turns.
    el.animate?.([{ translate: "0 0" }, { translate: "0 -4px" }, { translate: "0 0" }], { duration: 220 });
    return;
  }
  save(st, turnStack(st.layout, i));
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) el.animate?.([{ rotate: "-90deg" }, { rotate: "0deg" }], { duration: 280, easing: "cubic-bezier(0.34, 1.4, 0.64, 1)" });
}

/** The room is going: its floating stacks and the arranging line go too. */
export function releasePieces(panel) {
  const st = states.get(panel);
  if (!st) return;
  st.stopOutside?.();
  st.bar?.remove();
  for (const el of st.floats) el.remove();
  st.floats = [];
  removeEventListener("resize", st.onResize);
  states.delete(panel);
}
