// Small helpers for building the screens. Text always goes in as text, never as markup.

const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
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
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5l1.5 1.5M17 17l1.5 1.5M5.5 18.5L7 17M17 7l1.5-1.5"/>',
  moon: '<path d="M19.5 14.6A7.6 7.6 0 019.4 4.5a7.6 7.6 0 1010.1 10.1z"/>',
  upload: '<path d="M12 15V4.5M7.6 8.8L12 4.4l4.4 4.4"/><path d="M5 14.2v4.3A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5v-4.3"/>',
  zoomIn: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="M19.6 19.6l-4.3-4.3M8.3 10.8h5M10.8 8.3v5"/>',
  zoomOut: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="M19.6 19.6l-4.3-4.3M8.3 10.8h5"/>',
  muted: '<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
  solo: '<path d="M4.5 15.5v-3a7.5 7.5 0 0115 0v3"/><rect x="3.5" y="14" width="4" height="6" rx="1.6"/><rect x="16.5" y="14" width="4" height="6" rx="1.6"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5"/>',
  pen: '<path d="M4.5 19.5l1.2-4.4L15.6 5.2a2.1 2.1 0 013 3l-9.9 9.9z"/><path d="M13.8 7l3 3"/>',
  eraser: '<path d="M8.6 19.5h10.9"/><path d="M4.9 15.3l8.4-8.4a2 2 0 012.8 0l2.9 2.9a2 2 0 010 2.8l-6.6 6.6H8.5z"/>',
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
  lasso: '<path d="M7.6 15.4C5.3 14.4 3.8 12.7 3.8 10.6 3.8 7.3 7.5 4.8 12 4.8s8.2 2.5 8.2 5.8-3.7 5.8-8.2 5.8c-1.1 0-2.2-.1-3.2-.4" stroke-dasharray="2.6 2.4"/><path d="M8.8 15.9c-1.2.7-1.6 2.1-.7 3.3"/>',
  squeeze: '<path d="M3 12h6.5M14.5 12H21M6 8.5l3.5 3.5L6 15.5M18 8.5L14.5 12l3.5 3.5"/>',
  wave: '<path d="M3 12h2.2l2-5 3 10 3-12 3 9 1.8-2H21"/>',
  scissors: '<circle cx="6.5" cy="7" r="2.4"/><circle cx="6.5" cy="17" r="2.4"/><path d="M8.6 8.3L19.5 17M8.6 15.7L19.5 7"/>',
  roll: '<rect x="4" y="4.5" width="16" height="15" rx="2.2"/><path d="M7.5 9h4M10.5 12.5h5.5M13 16h3.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M5 15.5V6.4c0-.8.6-1.4 1.4-1.4h9.1"/>',
  book: '<path d="M5 4.5h9.5A2.5 2.5 0 0117 7v12.5H7.5A2.5 2.5 0 015 17z"/><path d="M5 17a2.5 2.5 0 012.5-2.5H17"/><path d="M9 8.5h5"/>',
  textSize: '<path d="M4 18.5L9 6l5 12.5M5.8 14h6.4"/><path d="M15.5 18.5l3-7.5 3 7.5M16.4 16.3h4.2"/>',
};

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "data") Object.assign(el.dataset, value);
    else if (key === "style") Object.assign(el.style, value);
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
  const held = new Set([e.pointerId]);
  const touch = e.pointerType === "touch";
  let lifted = 0;
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
    for (const b of el.children) b.setAttribute("aria-pressed", String(b.dataset.value === value));
  };
  for (const [value, label, id] of options) {
    const data = { value };
    if (attr) data[attr] = value;
    el.append(h("button", { type: "button", id, data, text: label, onclick: () => { paint(value); onPick(value); } }));
  }
  paint(current);
  return el;
}

export function toggle(id, label, checked, onChange) {
  const input = h("input", { id, type: "checkbox", checked, onchange: () => onChange(input.checked) });
  return h("div", { class: "row inline" }, h("label", { class: "label", for: id, text: label }), h("span", { class: "switch" }, input, h("span")));
}

/** Bottom sheet inside the app column. Returns a function that closes it. */
export function openSheet(root, title, build) {
  // A close button in the head: one tap, always (the owner: "한 번 누르면 안 나가지고").
  const shut = h("button", { class: "icon-btn sheet-close", type: "button", "aria-label": "닫기", onclick: () => close() }, icon("back"));
  const panel = h("section", { class: "panel", role: "dialog", "aria-modal": "true", "aria-label": title }, h("div", { class: "sheet-head" }, h("h2", { text: title }), shut));
  const scrim = h("div", { class: "scrim" }, panel);
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
    pull = panel.scrollTop <= 0 && !inField ? { y: t.clientY, at: performance.now(), dy: 0, on: false } : null;
  }, { passive: true });
  panel.addEventListener("touchmove", (e) => {
    if (!pull || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - pull.y;
    if (!pull.on && (dy < 6 || panel.scrollTop > 0)) {
      if (dy < -4) pull = null; // a push up scrolls the content as usual
      return;
    }
    pull.on = true;
    pull.dy = Math.max(0, dy);
    e.preventDefault();
    panel.style.transition = "none";
    panel.style.transform = `translateY(${pull.dy}px)`;
    scrim.style.setProperty("--pull", String(Math.min(1, pull.dy / Math.max(1, panel.offsetHeight))));
  }, { passive: false });
  const letGo = () => {
    if (!pull?.on) return void (pull = null);
    const speed = pull.dy / Math.max(1, performance.now() - pull.at);
    const far = pull.dy > panel.offsetHeight * 0.28 || speed > 0.6;
    pull = null;
    panel.style.transition = "";
    if (far) {
      panel.style.transform = "translateY(105%)";
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
  return close;
}

/**
 * A floating panel: no dark around it, so the room stays in reach while it is open (to look at
 * one and work in the other). It opens where it was last left (top left at first) and moves by
 * its head. pos: { get(), set({ x, y }) } keeps where it stands. Returns close().
 */
export function openFloat(root, { id, title, pos }, build) {
  document.getElementById(id)?.close?.();
  const closers = [];
  const head = h("div", { class: "float-head" },
    h("span", { class: "float-grip", "aria-hidden": "true" }),
    h("h2", { class: "float-title", text: title }),
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
  // Moved by its head, with any one finger or the mouse.
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
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
  }
  panel.close = close;
  document.addEventListener("keydown", onKey);
  build(body, close, (fn) => closers.push(fn));
  root.append(panel);
  const at = pos?.get();
  place(at?.x ?? 10, at?.y ?? 64);
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
