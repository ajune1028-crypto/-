// 색 원판: any colour for drawing, from a small wheel — a hue ring round a square of saturation
// (left to right) and brightness (top to bottom) — and the last eight colours chosen. As
// Procreate's colour disc and Krita's ring-and-square selector are laid out (no code taken).
// It floats above the drawing tools, covers little, and a press outside only puts it away.

import { h, closeOnOutside } from "./dom.js";
import { hsvToHex, hexToHsv, rememberColor } from "../core/paint.js";

const RING = 172; // the ring's outer size, CSS px
const BAND = 22; // the ring's thickness
const SQUARE = 84; // the square inside it

let current = null;

/** Puts the wheel away if it is out. */
export function closeColorWheel() {
  current?.close();
}

export function colorWheelOpen() {
  return !!current;
}

/**
 * Opens the wheel above `anchor` showing `color` (#rrggbb). onPick(hex, done): while a finger moves
 * on it (done false) and when it lifts or a recent colour is tapped (done true). recent: the last
 * colours; onRecent(list) keeps the new list. alive(): false once the tools it belongs to are gone.
 */
export function openColorWheel({ anchor, color, recent = [], onPick, onRecent = () => {}, alive = () => true }) {
  closeColorWheel();
  let { h: hue, s: sat, v: val } = hexToHsv(/^#[0-9a-f]{6}$/i.test(color || "") ? color : "#2f7bf0");
  // A grey or black keeps the hue it was last turned to (its own hue is no hue).
  const ring = h("div", { class: "cw-ring" });
  const ringKnob = h("span", { class: "cw-knob cw-ring-knob" });
  const square = h("div", { class: "cw-square" });
  const squareKnob = h("span", { class: "cw-knob cw-sq-knob" });
  const disc = h("div", { class: "cw-disc", id: "cw-disc", role: "group", "aria-label": "색 원판: 바깥 고리는 색, 가운데 네모는 진하기와 밝기",
    style: { width: RING + "px", height: RING + "px" } }, ring, ringKnob, square, squareKnob);
  const now = h("span", { class: "cw-now", id: "cw-now", "aria-hidden": "true" });
  const recentRow = h("div", { class: "cw-recent", id: "cw-recent", role: "group", "aria-label": "최근 색" });
  const box = h("div", { class: "color-wheel", id: "color-wheel" }, disc, h("div", { class: "cw-foot" }, now, recentRow));
  const hex = () => hsvToHex(hue, sat, val);

  function paint() {
    const mid = RING / 2 - BAND / 2;
    const a = (hue * Math.PI) / 180;
    ringKnob.style.left = RING / 2 + mid * Math.sin(a) + "px";
    ringKnob.style.top = RING / 2 - mid * Math.cos(a) + "px";
    ringKnob.style.background = hsvToHex(hue, 1, 1);
    square.style.setProperty("--hue", hsvToHex(hue, 1, 1));
    const left = (RING - SQUARE) / 2;
    squareKnob.style.left = left + sat * SQUARE + "px";
    squareKnob.style.top = left + (1 - val) * SQUARE + "px";
    squareKnob.style.background = hex();
    now.style.background = hex();
    box.dataset.color = hex();
  }

  function paintRecent() {
    recentRow.replaceChildren(...recent.map((c) => h("button", { class: "cw-swatch", type: "button", data: { color: c }, "aria-label": "최근 색 " + c, style: { background: c },
      onclick: () => {
        const k = hexToHsv(c);
        if (k.s) hue = k.h;
        sat = k.s;
        val = k.v;
        paint();
        done();
      } })));
  }

  function done() {
    onPick(hex(), true);
  }

  // One finger turns the ring or moves in the square (whichever it pressed first), to the lift.
  let drag = null;
  const where = (e) => {
    const r = disc.getBoundingClientRect();
    return [e.clientX - r.left - RING / 2, e.clientY - r.top - RING / 2];
  };
  const move = (e) => {
    const [x, y] = where(e);
    if (drag.part === "ring") {
      hue = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
    } else {
      sat = Math.max(0, Math.min(1, (x + SQUARE / 2) / SQUARE));
      val = Math.max(0, Math.min(1, 1 - (y + SQUARE / 2) / SQUARE));
    }
    paint();
    onPick(hex(), false);
  };
  disc.addEventListener("pointerdown", (e) => {
    if (drag || (e.pointerType === "mouse" && e.button !== 0)) return;
    const [x, y] = where(e);
    const r = Math.hypot(x, y);
    const part = r >= RING / 2 - BAND - 8 ? "ring" : Math.abs(x) <= SQUARE / 2 + 10 && Math.abs(y) <= SQUARE / 2 + 10 ? "square" : null;
    if (!part) return;
    e.preventDefault();
    drag = { id: e.pointerId, part };
    disc.setPointerCapture?.(e.pointerId);
    move(e);
  });
  disc.addEventListener("pointermove", (e) => {
    if (drag && e.pointerId === drag.id) move(e);
  });
  const lift = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    done();
  };
  disc.addEventListener("pointerup", lift);
  disc.addEventListener("pointercancel", lift);

  document.body.append(box);
  paint();
  paintRecent();
  // Above the tools it came from, over the button (below them when there is no room above), inside
  // the screen: the brushes and colours stay in view beneath it.
  const a = anchor.getBoundingClientRect();
  const toolsEl = anchor.closest(".ink-tools");
  const tools = toolsEl?.getBoundingClientRect() || a;
  const w = box.offsetWidth;
  const ht = box.offsetHeight;
  if (toolsEl?.classList.contains("rail")) {
    // Beside the tools' rail, at the colour's height.
    box.style.left = Math.min(innerWidth - w - 8, tools.right + 8) + "px";
    box.style.top = Math.max(8, Math.min(innerHeight - ht - 8, a.top + a.height / 2 - ht / 2)) + "px";
  } else {
    box.style.left = Math.max(8, Math.min(innerWidth - w - 8, a.left + a.width / 2 - w / 2)) + "px";
    box.style.top = (tools.top - ht - 10 >= 8 ? tools.top - ht - 10 : Math.min(innerHeight - ht - 8, tools.bottom + 10)) + "px";
  }

  const stop = closeOnOutside((t) => box.contains(t) || !!t.closest?.("#ink-more, #ink-color-now"), () => close(), box);
  // Its tools gone (the pen put away, another room) take it away too.
  const watch = setInterval(() => { if (!alive()) close(); }, 400);
  // The colour it was put away with joins the last colours (not each turn of the ring on the way).
  const first = hex();
  function close() {
    stop();
    clearInterval(watch);
    box.remove();
    if (current === handle) current = null;
    if (hex() !== first || recent[0] !== hex()) onRecent(rememberColor(recent, hex()));
  }
  const handle = { close, box };
  current = handle;
  return handle;
}
