// One day's sheet: a drawn layer under a transparent input box.
//
// The drawn layer always shows the merged, latest text, with colours and
// carets. The input box takes the keyboard exactly as the browser delivers it
// (한글 composition, selection handles, paste). The box may lag behind while a
// syllable is being composed, so every character it shows is tracked by id.

import { h } from "./dom.js";
import { currentTheme, reducedMotion } from "./theme.js";
import { ROOT } from "../core/crdt.js";
import { diffText, spliceOps, mixOps } from "../core/edit.js";
import { memberColor, INK, splitWords, paintFor, paintCss } from "../core/paint.js";
import { dayKey, dayLabel, hourLabel, lineStamps } from "../core/time.js";
import { getSettings } from "../identity.js";

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 24;

export class SheetEditor {
  constructor({ app, session, day, isToday, zone, record, onCaret, tell }) {
    this.app = app;
    this.session = session;
    this.day = day;
    this.doc = "s:" + day;
    this.sheet = session.sheet(day);
    this.zone = zone;
    this.record = record;
    this.onCaret = onCaret;
    this.tell = tell;
    this.snap = { text: "", ids: [] };
    this.composing = false;
    this.lines = [];
    this.lineKeys = [];
    this.lineEls = [];
    this.authorCounts = new Map();
    this.caretEls = new Map();
    this.lastTap = null;

    this.draw = h("div", { class: "draw", "aria-hidden": "true" });
    this.carets = h("div", { class: "carets", "aria-hidden": "true" });
    this.stamps = h("div", { class: "stamps" });
    this.input = h("textarea", {
      class: "input", id: "sheet-" + day, spellcheck: false, autocomplete: "off", autocapitalize: "off",
      "aria-label": dayLabel(day) + "에 쓴 글", placeholder: isToday ? "오늘의 첫 글을 써 보세요" : "",
    });
    this.input.setAttribute("autocorrect", "off");
    this.layers = h("div", { class: "layers" }, this.draw, this.carets, this.input);
    this.el = h("section", { class: "sheet" + (isToday ? " today" : ""), data: { day } },
      h("h2", { class: "day", text: dayLabel(day) }),
      h("div", { class: "paper" }, this.stamps, this.layers));

    const ta = this.input;
    ta.addEventListener("compositionstart", () => { this.composing = true; });
    ta.addEventListener("compositionend", () => {
      this.composing = false;
      queueMicrotask(() => { this.onInput(false); this.syncInput(); });
    });
    ta.addEventListener("input", (event) => this.onInput(event.isComposing || this.composing));
    for (const type of ["keyup", "focus", "blur", "select"]) ta.addEventListener(type, () => this.caretMoved());
    ta.addEventListener("pointerup", (event) => { this.onTap(event); this.caretMoved(); });
    ta.addEventListener("mousedown", (event) => { if (event.detail >= 2 && this.canMix()) event.preventDefault(); });
    this.onSelection = () => { if (document.activeElement === ta) this.caretMoved(); };
    document.addEventListener("selectionchange", this.onSelection);
  }

  destroy() {
    document.removeEventListener("selectionchange", this.onSelection);
    this.el.remove();
  }

  setReadOnly(readOnly) {
    this.input.readOnly = readOnly;
  }

  // ---- typing ----------------------------------------------------------------

  onInput(composing) {
    const next = this.input.value;
    if (next === this.snap.text) return;
    const { index, del, ins } = diffText(this.snap.text, next, this.input.selectionEnd);
    const now = Date.now();
    const { ops, atoms, ids } = spliceOps(this.sheet, this.session.clock, { by: this.session.memberId, now }, this.snap.ids, index, del, ins, composing);
    this.snap = { text: next, ids };
    if (!ops.length) return;
    this.session.commit(this.doc, ops);
    this.record(atoms.map((atom) => ({ ...atom, doc: this.doc })), true);
  }

  /** Brings the input box up to date with the sheet, unless a syllable is mid-composition. */
  syncInput() {
    if (this.composing) return;
    const text = this.sheet.text();
    const ids = this.sheet.ids();
    const ta = this.input;
    if (text === this.snap.text && ids.length === this.snap.ids.length && ids.every((id, i) => id === this.snap.ids[i])) return;
    const focused = document.activeElement === ta;
    const start = focused ? this.mapIndex(ta.selectionStart) : 0;
    const end = focused ? this.mapIndex(ta.selectionEnd) : 0;
    if (ta.value !== text) ta.value = text;
    this.snap = { text, ids: ids.slice() };
    if (focused) ta.setSelectionRange(start, end);
  }

  /** Where a position in the input box sits in the sheet's current text. */
  mapIndex(i) {
    return i <= 0 ? 0 : this.sheet.indexAfter(this.snap.ids[i - 1] ?? ROOT);
  }

  // ---- colour mixing ----------------------------------------------------------

  canMix() {
    const settings = getSettings(this.app.store);
    return settings.colors && settings.mixing && !this.input.readOnly && String(this.session.room.meta("kind") || "").startsWith("daily");
  }

  onTap(event) {
    const now = performance.now();
    const last = this.lastTap;
    this.lastTap = { t: now, x: event.clientX, y: event.clientY };
    if (!last || now - last.t > DOUBLE_TAP_MS || Math.hypot(event.clientX - last.x, event.clientY - last.y) > DOUBLE_TAP_PX) return;
    this.lastTap = null;
    if (!this.canMix()) return;
    const word = document.elementsFromPoint(event.clientX, event.clientY).find((el) => el.classList?.contains("w") && this.draw.contains(el));
    if (!word) return;
    const { ops, atoms } = mixOps(this.sheet, this.session.clock, word.dataset.anchor);
    this.session.commit(this.doc, ops);
    this.record(atoms.map((atom) => ({ ...atom, doc: this.doc })), false);
    // A double tap normally selects the word; here it mixes instead.
    const at = this.input.selectionStart;
    this.input.setSelectionRange(at, at);
  }

  // ---- drawing ----------------------------------------------------------------

  render() {
    const settings = getSettings(this.app.store);
    const theme = currentTheme();
    const room = this.session.room;
    const chars = this.sheet.chars();
    const texts = this.sheet.text().split("\n");
    const words = splitWords(chars);
    const options = {
      color: (by) => { const m = room.member(by); return m ? memberColor(m.color, theme) : INK[theme]; },
      colors: settings.colors, mixing: settings.mixing, ink: INK[theme], theme,
    };

    const lines = [];
    const counts = new Map();
    let start = 0;
    let w = 0;
    for (let li = 0; li < texts.length; li++) {
      const text = texts[li];
      const mine = [];
      while (w < words.length && words[w].line === li) mine.push(words[w++]);
      const paints = mine.map((word, k) => paintFor(word, mine[k - 1] || null, mine[k + 1] || null, { ...options, level: this.sheet.mixLevel(word.anchor) }));
      const key = text + "\u0001" + mine.map((word, k) => (word.start - start) + ":" + word.anchor + ":" + JSON.stringify(paints[k])).join("|");
      let el = this.lineKeys[li] === key ? this.lineEls[li] : null;
      if (!el) el = this.buildLine(text, start, mine, paints);
      for (const word of mine) counts.set(word.anchor, word.authors.length);
      let at = null;
      for (let i = start; i < start + text.length; i++) if (at === null || chars[i].at < at) at = chars[i].at;
      lines.push({ start, len: text.length, el, key, at });
      start += text.length + 1;
    }
    this.authorCounts = counts;
    this.lines = lines;
    this.lineKeys = lines.map((l) => l.key);
    this.lineEls = lines.map((l) => l.el);
    const same = this.draw.children.length === lines.length && lines.every((l, i) => this.draw.children[i] === l.el);
    if (!same) this.draw.replaceChildren(...this.lineEls);

    const zone = this.zone();
    const labels = lineStamps(lines, zone, this.day);
    this.stamps.replaceChildren(...labels.flatMap((label, i) => (label ? [this.stamp(label, lines[i], zone)] : [])));
    this.drawCarets();
  }

  buildLine(text, lineStart, words, paints) {
    const el = h("div", { class: "ln" });
    const segs = [];
    let at = 0;
    const plain = (upTo) => {
      if (upTo <= at) return;
      const node = document.createTextNode(text.slice(at, upTo));
      el.append(node);
      segs.push({ node, start: at, len: upTo - at });
      at = upTo;
    };
    words.forEach((word, k) => {
      const from = word.start - lineStart;
      const to = word.end - lineStart;
      plain(from);
      const paint = paints[k];
      const span = h("span", { class: "w", data: { paint: paint.k, level: String(this.sheet.mixLevel(word.anchor)), anchor: word.anchor } });
      const css = paintCss(paint);
      if (css.color) span.style.color = css.color;
      if (css.background) {
        span.classList.add("grad");
        span.style.backgroundImage = css.background;
      }
      const before = this.authorCounts.get(word.anchor);
      if (paint.k === "wheel" && before !== undefined && before < 3 && !reducedMotion()) span.classList.add("spin");
      const node = document.createTextNode(text.slice(from, to));
      span.append(node);
      el.append(span);
      segs.push({ node, start: from, len: to - from });
      at = to;
    });
    plain(text.length);
    if (!text.length) el.append(h("span", { class: "z", text: "​" }));
    el.segs = segs;
    return el;
  }

  stamp(label, line, zone) {
    return h("button", {
      class: "stamp", type: "button", text: label, style: { top: line.el.offsetTop + "px" },
      onclick: () => {
        const first = this.sheet.chars().slice(line.start, line.start + line.len).reduce((a, c) => (!a || c.at < a.at ? c : a), null);
        if (!first) return;
        const who = this.session.room.member(first.by)?.name || "누군가";
        const minutes = new Intl.DateTimeFormat("ko-KR", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(first.at);
        const day = dayKey(first.at, zone);
        this.tell(`${who} 님이 ${day === this.day ? "" : dayLabel(day).split(" ").slice(0, 2).join(" ") + " "}${minutes}에 썼어요`);
      },
    });
  }

  // ---- carets -----------------------------------------------------------------

  caretMoved() {
    const ta = this.input;
    const focused = document.activeElement === ta;
    this.onCaret(this, focused ? (ta.selectionStart > 0 ? this.snap.ids[ta.selectionStart - 1] ?? ROOT : ROOT) : null);
    this.drawCarets();
  }

  /** Pixel position of the caret at `index`, relative to the layers box. */
  caretRect(index) {
    const lines = this.lines;
    if (!lines.length) return null;
    let li = lines.length - 1;
    while (li > 0 && lines[li].start > index) li--;
    const line = lines[li];
    const offset = Math.min(Math.max(index - line.start, 0), line.len);
    const base = this.layers.getBoundingClientRect();
    if (!line.len) {
      const r = line.el.getBoundingClientRect();
      return { x: r.left - base.left, y: r.top - base.top, h: r.height };
    }
    const atEnd = offset >= line.len;
    const target = atEnd ? line.len - 1 : offset;
    const seg = line.el.segs.find((s) => target >= s.start && target < s.start + s.len);
    if (!seg) return null;
    const range = document.createRange();
    range.setStart(seg.node, target - seg.start);
    range.setEnd(seg.node, target - seg.start + 1);
    const rects = range.getClientRects();
    const r = rects[atEnd ? rects.length - 1 : 0] || range.getBoundingClientRect();
    return { x: (atEnd ? r.right : r.left) - base.left, y: r.top - base.top, h: r.height };
  }

  drawCarets() {
    const theme = currentTheme();
    const ta = this.input;
    const wanted = new Map();
    if (document.activeElement === ta && ta.selectionStart === ta.selectionEnd && !ta.readOnly) {
      wanted.set("mine", { index: this.mapIndex(ta.selectionStart), color: "", mine: true });
    }
    for (const peer of this.session.peers) {
      const s = peer.state;
      if (peer.isMe || !s || s.d !== this.day || typeof s.i !== "string") continue;
      const member = this.session.room.member(s.m);
      if (!member) continue;
      wanted.set(peer.key, { index: this.sheet.indexAfter(s.i), color: memberColor(member.color, theme), name: member.name });
    }
    for (const [key, el] of this.caretEls) {
      if (wanted.has(key)) continue;
      el.remove();
      this.caretEls.delete(key);
    }
    for (const [key, caret] of wanted) {
      const rect = this.caretRect(caret.index);
      if (!rect) continue;
      let el = this.caretEls.get(key);
      if (!el) {
        el = h("span", { class: "caret " + (caret.mine ? "mine" : "remote") }, !caret.mine && h("span", { class: "caret-name" }));
        this.caretEls.set(key, el);
        this.carets.append(el);
      }
      if (!caret.mine) {
        el.style.background = caret.color;
        el.firstChild.textContent = caret.name;
        if (el.dataset.index !== String(caret.index)) {
          el.classList.remove("moved");
          void el.offsetWidth;
          el.classList.add("moved");
        }
      }
      el.dataset.index = String(caret.index);
      el.style.left = rect.x + "px";
      el.style.top = rect.y + "px";
      el.style.height = rect.h + "px";
    }
  }
}
