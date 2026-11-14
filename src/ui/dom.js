// Small helpers for building the screens. Text always goes in as text, never as markup.

const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>',
  palette: '<circle cx="9" cy="10" r="5"/><circle cx="15" cy="14" r="5"/>',
  invite: '<circle cx="10" cy="8" r="3.6"/><path d="M3.5 19.5c.7-3.6 3.3-5.5 6.5-5.5 1.3 0 2.5.3 3.5.9"/><path d="M18 13.5v6M15 16.5h6"/>',
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

export function iconButton(id, name, label, onclick) {
  return h("button", { class: "icon-btn", id, type: "button", "aria-label": label, onclick }, icon(name));
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
  const panel = h("section", { class: "panel", role: "dialog", "aria-modal": "true", "aria-label": title }, h("h2", { text: title }));
  const scrim = h("div", { class: "scrim" }, panel);
  const onKey = (event) => { if (event.key === "Escape") close(); };
  const closers = [];
  function close() {
    if (!scrim.isConnected) return;
    for (const fn of closers) fn();
    scrim.remove();
    document.removeEventListener("keydown", onKey);
  }
  scrim.addEventListener("pointerdown", (event) => { if (event.target === scrim) close(); });
  document.addEventListener("keydown", onKey);
  build(panel, close, (fn) => closers.push(fn));
  root.append(scrim);
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
