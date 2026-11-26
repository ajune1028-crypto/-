// Small helpers for building the screens. Text always goes in as text, never as markup.

import { decodeLabel } from "./motion.js";

const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  layers: '<path d="M12 4.2l8.2 4.4L12 13 3.8 8.6z"/><path d="M3.8 12.4L12 16.8l8.2-4.4"/><path d="M3.8 16.2L12 20.6l8.2-4.4"/>',
  save: '<path d="M12 4.5v10.3M7.8 10.6l4.2 4.2 4.2-4.2"/><path d="M5 14.4v4.1A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5v-4.1"/>',
  eye: '<path d="M2.8 12s3.4-6.2 9.2-6.2S21.2 12 21.2 12s-3.4 6.2-9.2 6.2S2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.6"/>',
  eyeOff: '<path d="M2.8 12s3.4-6.2 9.2-6.2c1.7 0 3.2.5 4.4 1.2M21.2 12s-1.1 2-3.2 3.7M9.6 17.8c.8.3 1.6.4 2.4.4 5.8 0 9.2-6.2 9.2-6.2"/><path d="M4 20L20 4"/>',
  kebab: '<circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  star: '<path d="M12 3.6l2.55 5.2 5.75.84-4.16 4.05.98 5.72L12 16.72l-5.12 2.69.98-5.72L3.7 9.64l5.75-.84z"/>',
  heart: '<path d="M12 19.6s-7.2-4.5-7.2-10.1A4 4 0 0112 7.1a4 4 0 017.2 2.4c0 5.6-7.2 10.1-7.2 10.1z"/>',
  home: '<path d="M4 11.2l8-6.7 8 6.7"/><path d="M6.4 9.6V19.2h11.2V9.6"/><path d="M10.2 19.2v-4.8h3.6v4.8"/>',
  leaf: '<path d="M5.2 18.8C5 10.6 10 5.6 19.2 4.8 19.4 13.6 14.4 18.8 5.2 18.8z"/><path d="M5.2 18.8c3-4.2 6.2-7 10-9"/>',
  people: '<circle cx="9" cy="8.4" r="3"/><path d="M3.4 19a5.6 5.6 0 0111.2 0"/><circle cx="16.6" cy="9.4" r="2.4"/><path d="M15.4 14.1A4.6 4.6 0 0120.6 19"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>',
  palette: '<circle cx="9" cy="10" r="5"/><circle cx="15" cy="14" r="5"/>',
  invite: '<circle cx="10" cy="8" r="3.6"/><path d="M3.5 19.5c.7-3.6 3.3-5.5 6.5-5.5 1.3 0 2.5.3 3.5.9"/><path d="M18 13.5v6M15 16.5h6"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.8" y="5.5" width="3.6" height="13" rx="1" fill="currentColor" stroke="none"/><rect x="13.6" y="5.5" width="3.6" height="13" rx="1" fill="currentColor" stroke="none"/>',
  record: '<circle cx="12" cy="12" r="6.3" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6.6" y="6.6" width="10.8" height="10.8" rx="2.4" fill="currentColor" stroke="none"/>',
  start: '<path d="M6.5 5.5v13"/><path d="M18 5.8v12.4L9.6 12z" fill="currentColor" stroke="none"/>',
  // 햇살 (the owner: "찾기와 집 … 햇살로, 아이콘은 안에 해 태양으로"): a sun in lines, its first size (the
  // owner, 26 November: "태양 크기 키운거 원래대로"; no yellow inside: "안을 노란색으로 하지 말고 원래대로").
  sunshine: '<circle cx="12" cy="12" r="4.3"/><path d="M12 1.9v2.9M12 19.2v2.9M1.9 12h2.9M19.2 12h2.9M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5l1.5 1.5M17 17l1.5 1.5M5.5 18.5L7 17M17 7l1.5-1.5"/>',
  moon: '<path d="M19.5 14.6A7.6 7.6 0 019.4 4.5a7.6 7.6 0 1010.1 10.1z"/>',
  upload: '<path d="M12 15V4.5M7.6 8.8L12 4.4l4.4 4.4"/><path d="M5 14.2v4.3A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5v-4.3"/>',
  zoomIn: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="M19.6 19.6l-4.3-4.3M8.3 10.8h5M10.8 8.3v5"/>',
  zoomOut: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="M19.6 19.6l-4.3-4.3M8.3 10.8h5"/>',
  muted: '<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
  solo: '<path d="M4.5 15.5v-3a7.5 7.5 0 0115 0v3"/><rect x="3.5" y="14" width="4" height="6" rx="1.6"/><rect x="16.5" y="14" width="4" height="6" rx="1.6"/>',
  side: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5"/>',
  pen: '<path d="M4.5 19.5l1.2-4.4L15.6 5.2a2.1 2.1 0 013 3l-9.9 9.9z"/><path d="M13.8 7l3 3"/>',
  eraser: '<path d="M8.6 19.5h10.9"/><path d="M4.9 15.3l8.4-8.4a2 2 0 012.8 0l2.9 2.9a2 2 0 010 2.8l-6.6 6.6H8.5z"/>',
  // 미니게임: a game pad.
  game: '<path d="M7.2 8.5h9.6a4.4 4.4 0 014.3 5.3l-.6 3a2.4 2.4 0 01-4.1 1.1l-1.7-1.9H9.3l-1.7 1.9a2.4 2.4 0 01-4.1-1.1l-.6-3A4.4 4.4 0 017.2 8.5z"/><path d="M7.6 11.6v2.6M6.3 12.9h2.6"/><circle cx="15.6" cy="12.2" r=".6" fill="currentColor"/><circle cx="17.2" cy="13.8" r=".6" fill="currentColor"/>',
  // 애니메이션: a strip of film.
  film: '<rect x="4" y="4.5" width="16" height="15" rx="2.4"/><path d="M8.2 4.5v15M15.8 4.5v15M4 9.5h4.2M4 14.5h4.2M15.8 9.5H20M15.8 14.5H20"/>',
  // 양파 껍질: frames behind frames.
  onion: '<rect x="3.5" y="6.5" width="11" height="11" rx="2.2" opacity="0.45"/><rect x="6.5" y="5" width="11" height="11" rx="2.2" opacity="0.7"/><rect x="9.5" y="3.5" width="11" height="11" rx="2.2"/>',
  // 가리키기: a pen whose tip gives light.
  laser: '<path d="M4.6 19.4l7.6-7.6"/><path d="M10.9 13.1l2-2"/><circle cx="16.4" cy="7.6" r="1.9"/><path d="M16.4 2.9v1.3M21.1 7.6h-1.3M19.7 4.3l-.9.9M19.7 10.9l-.9-.9M13.1 4.3l.9.9"/>',
  // Room kinds.
  lines: '<path d="M5 7h14M5 12h14M5 17h9"/>',
  note: '<path d="M9 17.5V6.5l10-2.2V15.5"/><circle cx="6.6" cy="17.6" r="2.4"/><circle cx="16.6" cy="15.6" r="2.4"/>',
  board: '<rect x="3.5" y="4.5" width="8" height="6.5" rx="1.6"/><rect x="12.5" y="13" width="8" height="6.5" rx="1.6"/><path d="M11.5 7.8c3.2 0 4.8 1.6 5 5.2"/>',
  photo: '<rect x="4" y="5.5" width="16" height="13" rx="2.6"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4.4-3.9 3.4 2.9 2.6-2.1 3.6 3.1"/>',
  mixed: '<path d="M4.5 7.5h7M4.5 11.5h7M4.5 15.5h4.5"/><rect x="14" y="7" width="6" height="9" rx="1.6"/>',
  // The whiteboard's tools.
  library: '<path d="M4 6.5h10M4 11h10M4 15.5h6"/><path d="M17.5 17.5V8l3.5-1"/><circle cx="15.8" cy="17.6" r="1.9"/>',
  fit: '<path d="M4 9V4.5h4.5M20 9V4.5h-4.5M4 15v4.5h4.5M20 15v4.5h-4.5"/>',
  slots: '<rect x="4" y="4.5" width="16" height="4" rx="1.3"/><rect x="4" y="10" width="16" height="4" rx="1.3"/><rect x="4" y="15.5" width="10" height="4" rx="1.3"/>',
  stretch: '<path d="M3.5 12h17M7.5 8l-4 4 4 4M16.5 8l4 4-4 4"/>',
  move: '<path d="M12 3.6v16.8M3.6 12h16.8"/><path d="M9.4 6.2L12 3.6l2.6 2.6M9.4 17.8l2.6 2.6 2.6-2.6M6.2 9.4L3.6 12l2.6 2.6M17.8 9.4l2.6 2.6-2.6 2.6"/>',
  lasso: '<path d="M7.6 15.4C5.3 14.4 3.8 12.7 3.8 10.6 3.8 7.3 7.5 4.8 12 4.8s8.2 2.5 8.2 5.8-3.7 5.8-8.2 5.8c-1.1 0-2.2-.1-3.2-.4" stroke-dasharray="2.6 2.4"/><path d="M8.8 15.9c-1.2.7-1.6 2.1-.7 3.3"/>',
  squeeze: '<path d="M3 12h6.5M14.5 12H21M6 8.5l3.5 3.5L6 15.5M18 8.5L14.5 12l3.5 3.5"/>',
  wave: '<path d="M3 12h2.2l2-5 3 10 3-12 3 9 1.8-2H21"/>',
  scissors: '<circle cx="6.5" cy="7" r="2.4"/><circle cx="6.5" cy="17" r="2.4"/><path d="M8.6 8.3L19.5 17M8.6 15.7L19.5 7"/>',
  roll: '<rect x="4" y="4.5" width="16" height="15" rx="2.2"/><path d="M7.5 9h4M10.5 12.5h5.5M13 16h3.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M5 15.5V6.4c0-.8.6-1.4 1.4-1.4h9.1"/>',
  book: '<path d="M5 4.5h9.5A2.5 2.5 0 0117 7v12.5H7.5A2.5 2.5 0 015 17z"/><path d="M5 17a2.5 2.5 0 012.5-2.5H17"/><path d="M9 8.5h5"/>',
  // A panel floating on its own (찾기와 집 like 레퍼런스).
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  dock: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M4 14.5h16"/><path d="M9.5 17h5"/>',
  replay: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v3.4h3.4"/><path d="M10.4 9.3v5.4l4.4-2.7z" fill="currentColor" stroke-width="1.2"/>',
  float: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M4 9.5h16"/><circle cx="7.2" cy="7.25" r="0.6" fill="currentColor" stroke="none"/><path d="M8 13.5h8M8 16h5"/>',
  textSize: '<path d="M4 18.5L9 6l5 12.5M5.8 14h6.4"/><path d="M15.5 18.5l3-7.5 3 7.5M16.4 16.3h4.2"/>',
  // The side panel's buttons (icon above, word below).
  trash: '<path d="M4.5 7h15M9.5 7V5h5v2"/><path d="M6.5 7l1 12.5h9l1-12.5"/><path d="M10 11v5M14 11v5"/>',
  paste: '<rect x="5.5" y="5" width="13" height="15" rx="2.2"/><path d="M9 5V3.8h6V5"/><path d="M9 11h6M9 14.5h4"/>',
  join: '<path d="M10 14l4-4"/><path d="M8.6 16.4l-1.2 1.2a3 3 0 01-4.2-4.2l3-3a3 3 0 014.2 0"/><path d="M15.4 7.6l1.2-1.2a3 3 0 014.2 4.2l-3 3a3 3 0 01-4.2 0"/>',
  speed: '<path d="M4 17.5a8 8 0 1116 0"/><path d="M12 17.5l4.2-5.2"/><circle cx="12" cy="17.5" r="1" fill="currentColor" stroke="none"/>',
  fork: '<path d="M9 3.5v7.5a3 3 0 006 0V3.5"/><path d="M12 14v6.5"/>',
  chords: '<circle cx="8" cy="17.5" r="2.3"/><circle cx="8" cy="11" r="2.3"/><path d="M10.3 17.5V5h6.2M10.3 11V8.5"/>',
  send: '<path d="M4.5 12l15-7-4.5 15-3-6z"/><path d="M12 14l7.5-9"/>',
  hideRight: '<path d="M9 6l6 6-6 6"/>',
  showLeft: '<path d="M15 6l-6 6 6 6"/>',
};

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "data") Object.assign(el.dataset, value);
    // Custom properties ("--c") need setProperty; the rest are plain style fields.
    else if (key === "style") for (const [k, v] of Object.entries(value)) k.startsWith("--") ? el.style.setProperty(k, String(v)) : (el.style[k] = v);
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key in el && !key.startsWith("aria")) el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) el.append(child);
  }
  return el;
}

export function icon(name) {
  const span = document.createElement("span");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstChild;
}

/**
 * A word that shows for a moment at the top middle and goes (what a gesture did: "되돌리기"), as
 * Procreate says what a two-finger tap did. Again soon, the same pill says the new word.
 */
export function flashHint(text) {
  let el = document.getElementById("gesture-hint");
  if (!el) {
    el = h("div", { class: "gesture-hint", id: "gesture-hint", role: "status", "aria-live": "polite" });
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.remove("on");
  void el.offsetWidth;
  el.classList.add("on");
  clearTimeout(el.timer);
  el.timer = setTimeout(() => el.remove(), 900);
}

/** cap: a short word shown under the icon (bottom toolbars say what each button does). */
export function iconButton(id, name, label, onclick, cap = null) {
  return h("button", { class: "icon-btn", id, type: "button", "aria-label": label, data: cap ? { cap } : undefined, onclick }, icon(name));
}

/**
 * The rest of a press goes nowhere: its lift, the mouse events copied from it and the click
 * it makes (and, for a touch, fingers that join it). For a press that closed something.
 */
export function swallowPress(e) {
  const swallow = (ev) => {
    ev.stopImmediatePropagation();
    if (ev.cancelable) ev.preventDefault();
  };
  swallow(e);
  // Called from the press itself, the pointer is still down; called from its lift (a held thing let
  // go), it is already up — and the next touch is a new press to let through (it was eaten for 4 s).
  const up = e.type === "pointerup" || e.type === "pointercancel";
  const held = new Set(up ? [] : [e.pointerId]);
  const touch = e.pointerType === "touch";
  let lifted = up ? Date.now() : 0;
  const lift = (ev) => {
    if (!held.has(ev.pointerId)) return;
    swallow(ev);
    held.delete(ev.pointerId);
    if (!held.size) lifted = Date.now();
  };
  const copy = (ev) => { if (!lifted || Date.now() - lifted < 60) swallow(ev); };
  const click = (ev) => {
    if (lifted && Date.now() - lifted < 400) swallow(ev);
    if (lifted) end();
  };
  const next = (ev) => {
    if (touch && held.size && ev.pointerType === "touch") {
      swallow(ev);
      held.add(ev.pointerId);
    } else end();
  };
  const types = [["pointerup", lift], ["pointercancel", lift], ["mousedown", copy], ["mouseup", copy], ["click", click], ["pointerdown", next]];
  const end = () => {
    for (const [t, fn] of types) window.removeEventListener(t, fn, true);
    clearTimeout(timer);
  };
  // (Listeners added while this press is being dispatched never hear the press itself.)
  for (const [t, fn] of types) window.addEventListener(t, fn, true);
  const timer = setTimeout(end, 4000);
}

/** The screen's frame: bars, tool rows and sheets work as usual while a menu is open. */
const FRAME = ".room > .bar, .room-top, .toolbar, .board-rail, .ink-tools, .sel-tools, .scrim, .panel, .drawer, .home-top, .home-foot";

/**
 * While a menu is open, a press on the content outside it (another card, another clip, the
 * empty board) only puts the menu away: that press, its lift and its click never reach what
 * lies underneath, so nothing there is chosen or pressed. inside(target): what still counts
 * as the menu's own (the menu, what it belongs to); the frame always does. A second finger
 * (a pinch) passes. Returns stop().
 */
export function closeOnOutside(inside, close, menu = null) {
  const down = (e) => {
    // A menu whose screen has gone (another room, home) keeps no hold on the page.
    if (menu && !menu.isConnected) return void stop();
    if (e.pointerType === "touch" && !e.isPrimary) return;
    if (inside(e.target) || e.target.closest?.(FRAME)) return;
    stop();
    swallowPress(e);
    close();
  };
  window.addEventListener("pointerdown", down, true);
  const stop = () => window.removeEventListener("pointerdown", down, true);
  return stop;
}

export function mount(root, ...nodes) {
  root.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
}

/** A labelled input. */
export function inputRow(id, label, attrs = {}) {
  const input = h("input", { class: "input", id, type: "text", autocomplete: "off", ...attrs });
  return { input, row: h("div", { class: "row" }, h("label", { for: id, text: label }), input) };
}

/**
 * A group of fields with one action. Not a <form>: the trial page runs in a
 * sandboxed frame where forms never fire their submit event, so the action is
 * wired to the button's click and to the Enter key.
 */
export function formBox(onSubmit, ...children) {
  const el = h("div", { class: "form", role: "group" }, ...children);
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || event.target.tagName !== "INPUT") return;
    event.preventDefault();
    onSubmit();
  });
  return el;
}

/** A two-or-more way choice. `options` is [[value, label, id?]]. */
export function segmented(options, current, onPick, attr) {
  const el = h("div", { class: "seg", role: "group" });
  const paint = (value) => {
    for (const b of el.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.value === value));
  };
  for (const [value, label, id] of options) {
    const data = { value };
    if (attr) data[attr] = value;
    el.append(h("button", { type: "button", id, data, text: label, onclick: (e) => {
      const changed = e.currentTarget.getAttribute("aria-pressed") !== "true";
      paint(value);
      onPick(value);
      if (changed) decodeLabel(e.currentTarget);
    } }));
  }
  paint(current);
  flowingPill(el);
  return el;
}

/**
 * The mark of what is chosen moves like water (the owner: "그냥 단지 그 모드로 가는 게 아니라… 물처럼
 * 작아졌다가 거기까지 가는"): it gathers into a drop where it was, runs to the new choice and
 * spreads out there. Whoever sets aria-pressed (this control or its screen) moves it.
 */
function flowingPill(seg) {
  const pill = h("span", { class: "seg-pill", "aria-hidden": "true" });
  seg.prepend(pill);
  let box = null;
  let run = null;
  const place = (animate) => {
    const on = seg.querySelector('button[aria-pressed="true"]');
    if (!on || !on.offsetWidth) {
      seg.classList.remove("has-pill");
      box = null;
      return;
    }
    const to = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
    const from = box;
    box = to;
    Object.assign(pill.style, { left: to.x + "px", top: to.y + "px", width: to.w + "px", height: to.h + "px" });
    seg.classList.add("has-pill");
    if (!animate || !from || (from.x === to.x && from.y === to.y) || !pill.animate || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const dx = from.x + from.w / 2 - (to.x + to.w / 2);
    const dy = from.y + from.h / 2 - (to.y + to.h / 2);
    const sx = from.w / to.w;
    const sy = from.h / to.h;
    // Drawn out along the way it runs, as a drop is.
    const along = Math.abs(dx) >= Math.abs(dy);
    const drop = (k, wide, tall) => `translate(${dx * k}px, ${dy * k}px) scale(${(along ? wide : tall) * (1 + (sx - 1) * k)}, ${(along ? tall : wide) * (1 + (sy - 1) * k)})`;
    run?.cancel();
    run = pill.animate([
      { transform: drop(1, 1, 1), offset: 0 },
      { transform: drop(0.96, 0.62, 0.7), offset: 0.26, easing: "cubic-bezier(0.5, 0, 0.3, 1)" },
      { transform: drop(0.12, 0.8, 0.66), offset: 0.7, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" },
      { transform: "translate(0, 0) scale(1.05, 1.06)", offset: 0.88 },
      { transform: "none", offset: 1 },
    ], { duration: 460, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
  };
  let queued = false;
  const soon = (animate) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; place(animate); });
  };
  new MutationObserver(() => soon(true)).observe(seg, { attributes: true, attributeFilter: ["aria-pressed"], subtree: true });
  if (typeof ResizeObserver === "function") new ResizeObserver(() => { box = null; soon(false); }).observe(seg);
  soon(false);
}

export function toggle(id, label, checked, onChange) {
  const input = h("input", { id, type: "checkbox", checked, onchange: () => onChange(input.checked) });
  return h("div", { class: "row inline" }, h("label", { class: "label", for: id, text: label }), h("span", { class: "switch" }, input, h("span")));
}

/**
 * Runs fn at the next frame, or after 50 ms where frames do not come (a page in the background):
 * work that may be asked for many times a frame is done once. Returns a function that cancels it.
 */
export function nextFrame(fn) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    fn();
  };
  const frame = requestAnimationFrame(run);
  const timer = setTimeout(run, 50);
  return () => {
    done = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}

/** Bottom sheet inside the app column. Returns a function that closes it. */
export function openSheet(root, title, build, { side = false } = {}) {
  // A close button in the head: one tap, always (the owner: "한 번 누르면 안 나가지고").
  const shut = h("button", { class: "icon-btn sheet-close", type: "button", "aria-label": "닫기", onclick: () => close() }, icon("back"));
  const panel = h("section", { class: "panel", role: "dialog", "aria-modal": "true", "aria-label": title }, h("div", { class: "sheet-head" }, h("h2", { text: title }), shut));
  // From the side (a room's details, the owner, 22 November: "드로어처럼 옆에서… 잘 볼 수 있게"): it
  // slides in from the right edge over the whole height and is pushed back the same way.
  const scrim = h("div", { class: "scrim" + (side ? " side-sheet" : "") }, panel);
  const onKey = (event) => { if (event.key === "Escape") close(); };
  const closers = [];
  let closing = false;
  function close() {
    if (!scrim.isConnected || closing) return;
    closing = true;
    for (const fn of closers) fn();
    document.removeEventListener("keydown", onKey);
    // It slides back down (and the dark fades) before it goes; it takes no more touches meanwhile.
    scrim.classList.add("closing");
    scrim.inert = true;
    const gone = () => scrim.remove();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return gone();
    setTimeout(gone, 260);
  }
  // Pulled down from the top of its content, it follows the finger and goes (a short pull springs
  // back). Content scrolled down is scrolled up first; only a pull that starts at the top closes it
  // (the owner: "조금이라도 아래로 스크롤 된 상태이면… 한 번 더 아래로 내리면 내려가는 식").
  let pull = null;
  panel.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || closing) return void (pull = null);
    const t = e.touches[0];
    // Caught while still sliding in: it stops where it is and follows the finger from there.
    for (const a of panel.getAnimations()) a.finish();
    const inField = !!e.target.closest?.("input, textarea, select, [contenteditable='true']");
    pull = (side || panel.scrollTop <= 0) && !inField ? { x: t.clientX, y: t.clientY, at: performance.now(), dy: 0, on: false } : null;
  }, { passive: true });
  panel.addEventListener("touchmove", (e) => {
    if (!pull || e.touches.length !== 1) return;
    // A drawer goes back to its side; a sheet goes down.
    const dx = e.touches[0].clientX - pull.x;
    const dy = side ? dx : e.touches[0].clientY - pull.y;
    const across = side ? Math.abs(e.touches[0].clientY - pull.y) : Math.abs(dx);
    if (!pull.on && (dy < 6 || (!side && panel.scrollTop > 0) || (side && across > dy))) {
      if (dy < -4 || (side && across > 10)) pull = null; // the other way scrolls the content as usual
      return;
    }
    pull.on = true;
    pull.dy = Math.max(0, dy);
    e.preventDefault();
    panel.style.transition = "none";
    panel.style.transform = side ? `translateX(${pull.dy}px)` : `translateY(${pull.dy}px)`;
    scrim.style.setProperty("--pull", String(Math.min(1, pull.dy / Math.max(1, side ? panel.offsetWidth : panel.offsetHeight))));
  }, { passive: false });
  const letGo = () => {
    if (!pull?.on) return void (pull = null);
    const speed = pull.dy / Math.max(1, performance.now() - pull.at);
    const far = pull.dy > (side ? panel.offsetWidth : panel.offsetHeight) * 0.28 || speed > 0.6;
    pull = null;
    panel.style.transition = "";
    if (far) {
      panel.style.transform = side ? "translateX(105%)" : "translateY(105%)";
      close();
    } else {
      panel.style.transform = "";
      scrim.style.removeProperty("--pull");
    }
  };
  panel.addEventListener("touchend", letGo);
  panel.addEventListener("touchcancel", letGo);
  // A press on the dark around the sheet only closes it: nothing underneath is pressed.
  scrim.addEventListener("pointerdown", (event) => {
    if (event.target !== scrim) return;
    swallowPress(event);
    close();
  });
  document.addEventListener("keydown", onKey);
  build(panel, close, (fn) => closers.push(fn));
  root.append(scrim);
  // Whatever lies over the screen and is not a sheet steps aside (찾기와 집 out of an edge).
  document.dispatchEvent(new CustomEvent("sheet-open"));
  return close;
}

/**
 * A floating panel: no dark around it, so the room stays in reach while it is open (to look at
 * one and work in the other). It opens where it was last left (top left at first) and moves by
 * its head. pos: { get(), set({ x, y }) } keeps where it stands. Returns close().
 */
export function openFloat(root, { id, title, pos, dock = null }, build) {
  document.getElementById(id)?.close?.();
  const closers = [];
  // dock: { get, set } - on a wide screen lying down it can stand at the right edge instead
  // (the owner chose 옆 패널): the app narrows beside it, so it covers nothing.
  const wide = matchMedia("(min-width: 1000px) and (min-height: 600px) and (orientation: landscape)");
  const pin = dock && h("button", { class: "icon-btn float-pin", type: "button", id: id + "-pin", "aria-label": "옆에 고정", title: "옆에 고정", onclick: () => { dock.set(!dock.get()); fit(); } }, icon("side"));
  const head = h("div", { class: "float-head" },
    h("span", { class: "float-grip", "aria-hidden": "true" }),
    h("h2", { class: "float-title", text: title }),
    pin,
    h("button", { class: "icon-btn float-close", type: "button", id: id + "-close", "aria-label": "닫기", onclick: () => close() }, icon("back")));
  const body = h("div", { class: "float-body" });
  const panel = h("section", { class: "float", id, role: "dialog", "aria-label": title }, head, body);
  const place = (x, y) => {
    const w = panel.offsetWidth || 320;
    const hgt = panel.offsetHeight || 200;
    const nx = Math.max(4, Math.min(innerWidth - w - 4, x));
    const ny = Math.max(4, Math.min(innerHeight - Math.min(hgt, 120), y));
    panel.style.left = nx + "px";
    panel.style.top = ny + "px";
    return { x: nx, y: ny };
  };
  const docked = () => !!dock && !!dock.get() && wide.matches;
  /** Docked or floating, as the setting and the screen say. */
  function fit() {
    const on = docked();
    panel.classList.toggle("docked", on);
    document.documentElement.toggleAttribute("data-side-dock", on);
    if (pin) {
      pin.hidden = !wide.matches;
      pin.setAttribute("aria-pressed", String(on));
      pin.setAttribute("aria-label", on ? "떼어서 띄우기" : "옆에 고정");
    }
    if (!on) {
      panel.style.right = "";
      const at = pos?.get();
      const p = place(at?.x ?? 10, at?.y ?? 64);
      // It never lies over the buttons at home's top right (레퍼런스 is under the ⋮ there): pressed
      // again, its own button closes it.
      const keep = document.querySelector(".home-top")?.getBoundingClientRect();
      if (keep && keep.height) {
        const w = panel.offsetWidth || 320;
        const overlaps = p.x < keep.right && p.x + w > keep.left && p.y < keep.bottom;
        if (overlaps) place(p.x, keep.bottom + 8);
      }
    }
  }
  wide.addEventListener?.("change", fit);
  closers.push(() => wide.removeEventListener?.("change", fit));
  // Moved by its head, with any one finger or the mouse (docked, it stays where it stands).
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button") || docked()) return;
    const r = panel.getBoundingClientRect();
    const grab = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture?.(e.pointerId);
    const move = (ev) => { if (ev.pointerId === grab.id) place(ev.clientX - grab.dx, ev.clientY - grab.dy); };
    const up = (ev) => {
      if (ev.pointerId !== grab.id) return;
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", up);
      const r2 = panel.getBoundingClientRect();
      pos?.set({ x: Math.round(r2.left), y: Math.round(r2.top) });
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", up);
  });
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    if (!panel.isConnected) return;
    for (const fn of closers) fn();
    panel.remove();
    document.removeEventListener("keydown", onKey);
    if (panel.classList.contains("docked")) document.documentElement.removeAttribute("data-side-dock");
  }
  panel.close = close;
  document.addEventListener("keydown", onKey);
  build(body, close, (fn) => closers.push(fn));
  root.append(panel);
  fit();
  return close;
}

let toastTimer = null;
export function toast(root, text, ms = 2600) {
  root.querySelector(".toast")?.remove();
  clearTimeout(toastTimer);
  const el = h("div", { class: "toast", role: "status", text });
  root.append(el);
  toastTimer = setTimeout(() => el.remove(), ms);
}
