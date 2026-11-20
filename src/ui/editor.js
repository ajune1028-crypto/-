// One day's sheet: a drawn layer under a transparent input box.
//
// The drawn layer always shows the merged, latest text, with colours and
// carets. The input box takes the keyboard exactly as the browser delivers it
// (한글 composition, selection handles, paste). The box may lag behind while a
// syllable is being composed, so every character it shows is tracked by id.

import { chime, buzz } from "./chime.js";
import { h, icon, nextFrame } from "./dom.js";
import { MOTTO } from "./motto.js";
import { currentTheme, reducedMotion } from "./theme.js";
import { ROOT } from "../core/crdt.js";
import { diffText, spliceOps, mixOps, lockedEdit } from "../core/edit.js";
import { memberColor, personColor, INK, splitWords, paintFor, paintCss } from "../core/paint.js";
import { dayKey, dayLabel } from "../core/time.js";
import { getSettings } from "../identity.js";

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 24;
// A press held this long, without moving, asks who wrote the words under it (before the
// phone's own long press at about 500 ms, which goes on to select the word as usual).
const HOLD_MS = 450;
// Holding a sparkling word this long brings out the photo hidden in it.
const REVEAL_MS = 2000;
const HOLD_SLOP_PX = 10;

export class SheetEditor {
  constructor({ app, session, day, isToday, zone, record, onCaret, tell, onReveal = () => {}, onSelect = () => {}, onDay = null }) {
    this.onReveal = onReveal;
    this.onDay = onDay;
    this.onSelect = onSelect;
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
    this.unshaped = [];
    this.lastTap = null;

    this.draw = h("div", { class: "draw", "aria-hidden": "true" });
    this.carets = h("div", { class: "carets", "aria-hidden": "true" });
    this.input = h("textarea", {
      class: "typing", id: "sheet-" + day, spellcheck: false, autocomplete: "off", autocapitalize: "off",
      "aria-label": dayLabel(day) + "에 쓴 글", placeholder: isToday ? MOTTO : "",
    });
    this.input.setAttribute("autocorrect", "off");
    this.layers = h("div", { class: "layers" }, this.draw, this.carets, this.input);
    this.paper = h("div", { class: "paper" }, this.layers);
    // The day's name; pressed, the day's own things (이 날 잠그기). A locked day shows its lock there.
    this.dayLock = h("span", { class: "day-lock", hidden: true });
    this.dayHead = h("h2", { class: "day" + (onDay ? " pressable" : ""), role: onDay ? "button" : null, tabindex: onDay ? "0" : null,
      onclick: (e) => { if (onDay) { e.stopPropagation(); onDay(this, this.dayHead); } } },
      h("span", { class: "day-name", text: dayLabel(day) }), this.dayLock);
    this.el = h("section", { class: "sheet" + (isToday ? " today" : ""), data: { day } },
      this.dayHead,
      this.paper);

    const ta = this.input;
    ta.addEventListener("compositionstart", () => { this.composing = true; });
    ta.addEventListener("compositionend", () => {
      this.composing = false;
      queueMicrotask(() => { this.onInput(false); this.syncInput(); });
    });
    ta.addEventListener("input", (event) => this.onInput(event.isComposing || this.composing));
    for (const type of ["keyup", "focus", "blur", "select"]) ta.addEventListener(type, () => this.caretMoved());
    ta.addEventListener("pointerup", (event) => { this.onTap(event); this.caretMoved(); });
    // Written words carry no time labels; a press held on them tells who wrote them and when
    // (and, on locked words, who locked them). On a sparkling word, a 2-second hold glows
    // brighter and brings out its photo or its recording.
    let hold = null;
    const letGo = () => {
      clearTimeout(hold?.timer);
      hold?.glow?.classList.remove("charging");
      hold = null;
    };
    ta.addEventListener("pointerdown", (event) => {
      letGo();
      const { clientX: x, clientY: y } = event;
      const glow = this.sparkleAt(x, y);
      if (glow) {
        glow.classList.add("charging");
        hold = { id: event.pointerId, x, y, glow, timer: setTimeout(() => {
          letGo();
          const att = this.sheet.attachments().find((a) => a.id === glow.dataset.att);
          if (att) this.onReveal(att, glow.getBoundingClientRect());
        }, REVEAL_MS) };
      } else hold = { id: event.pointerId, x, y, timer: setTimeout(() => { hold = null; this.whoWrote(x, y); }, HOLD_MS) };
      this.tellLock(x, y);
    });
    ta.addEventListener("pointermove", (event) => {
      if (hold && event.pointerId === hold.id && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > HOLD_SLOP_PX) letGo();
    });
    ta.addEventListener("pointerup", letGo);
    ta.addEventListener("pointercancel", letGo);
    ta.addEventListener("mousedown", (event) => { if (event.detail >= 2 && this.canMix()) event.preventDefault(); });
    this.onSelection = () => { if (document.activeElement === ta) this.caretMoved(); };
    document.addEventListener("selectionchange", this.onSelection);
  }

  destroy() {
    this.caretFrame?.();
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
    // 잠금: locked words stay as they are; the box goes back to the sheet.
    if (lockedEdit(this.sheet, this.snap.ids, index, del)) {
      const caret = Math.min(index, this.snap.text.length);
      this.input.value = this.snap.text;
      this.input.setSelectionRange(caret, caret);
      this.tell(this.sheet.dayLock() ? "잠긴 날이라 쓸 수 없어요" : "잠긴 글이라 고칠 수 없어요");
      return;
    }
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
    const anchor = word.dataset.anchor;
    const { ops, atoms } = mixOps(this.sheet, this.session.clock, anchor);
    this.session.commit(this.doc, ops);
    this.record(atoms.map((atom) => ({ ...atom, doc: this.doc })), false);
    // 띠리링, a little buzz, and the colours swirl once in the word (the owner's "색이 섞이는 띠리링").
    if (ops.length) {
      chime(this.app);
      buzz(this.app, 10);
      requestAnimationFrame(() => {
        const el = this.draw.querySelector(`.w[data-anchor="${CSS.escape(anchor)}"]`);
        if (!el) return;
        el.classList.add("swirl");
        setTimeout(() => el.classList.remove("swirl"), 750);
      });
    }
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
      color: (by) => { const m = room.member(by); return m ? personColor(m, theme) : INK[theme]; },
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
    // Touch only the lines that changed; re-inserting a long unchanged line makes the browser lay it out again.
    const kids = this.draw.children;
    for (let i = 0; i < lines.length; i++) {
      if (kids[i] !== lines[i].el) this.draw.insertBefore(lines[i].el, kids[i] || null);
    }
    while (kids.length > lines.length) kids[kids.length - 1].remove();
    this.shapeWheels();

    this.markRanges();
    this.drawCarets();
  }

  /** A wheel is fitted to its word's shape, which is only known once the word is on the page. */
  shapeWheels() {
    for (const span of this.unshaped) {
      const box = span.getClientRects()[0];
      if (box && box.height > 0) span.style.backgroundImage = paintCss(span.paint, box.width / box.height).background;
    }
    this.unshaped = [];
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
        if (paint.k === "wheel" || paint.base?.k === "wheel") {
          span.paint = paint;
          this.unshaped.push(span);
        }
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

  /** A touch on locked words says who locked them (once per lock until another is touched). */
  tellLock(x, y) {
    const span = document.elementsFromPoint(x, y).find((el) => el.classList?.contains("locked") && this.draw.contains(el));
    if (!span || this.toldLock === span.dataset.lock) return;
    this.toldLock = span.dataset.lock;
    const lock = this.sheet.locks().find((l) => l.id === span.dataset.lock);
    if (lock) this.tell(`${this.session.room.member(lock.by)?.name || "누군가"} 님이 잠근 글이에요`);
  }

  /** Who wrote the word at (x, y), and on which day and at what time (its first letter). */
  whoWrote(x, y) {
    const span = document.elementsFromPoint(x, y).find((el) => el.classList?.contains("w") && this.draw.contains(el));
    if (!span) return;
    const chars = this.sheet.chars();
    const word = splitWords(chars).find((w) => w.anchor === span.dataset.anchor);
    if (!word) return;
    const letters = chars.slice(word.start, word.end);
    const first = letters.reduce((a, c) => (!a || c.at < a.at ? c : a), null);
    if (!first) return;
    const names = [...new Set(letters.map((c) => this.session.room.member(c.by)?.name || "누군가"))];
    const zone = this.zone();
    const date = dayLabel(dayKey(first.at, zone)).split(" ").slice(0, 2).join(" ");
    const time = new Intl.DateTimeFormat("ko-KR", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(first.at);
    this.tell(`${names.join("·")} 님이 ${date} ${time}에 썼어요`);
  }

  // ---- carets -----------------------------------------------------------------

  caretMoved() {
    const ta = this.input;
    const focused = document.activeElement === ta;
    this.onCaret(this, focused ? (ta.selectionStart > 0 ? this.snap.ids[ta.selectionStart - 1] ?? ROOT : ROOT) : null);
    // Carets are placed once a frame: a handle dragged through the words moves the selection many
    // times between two frames, and each placing measures the page.
    if (!this.caretFrame) this.caretFrame = nextFrame(() => { this.caretFrame = null; this.drawCarets(); });
    if (focused) this.onSelect(this);
  }

  /** The chosen words as { ch, to } (first and last letter ids), or null when nothing is chosen. */
  selectionRange() {
    const ta = this.input;
    const a = Math.min(ta.selectionStart, ta.selectionEnd);
    const b = Math.max(ta.selectionStart, ta.selectionEnd);
    if (a === b) return null;
    const ch = this.snap.ids[a];
    const to = this.snap.ids[b - 1];
    return ch && to ? { ch, to } : null;
  }

  /**
   * The word at the caret (or just before it) as { ch, to }; `at` past the end gives the
   * last word. Null on a sheet with no words.
   */
  wordAround(at = this.input.selectionStart) {
    const text = this.snap.text;
    let end = Math.min(Math.max(0, at), text.length);
    if (end < text.length && /\S/.test(text[end])) while (end < text.length && /\S/.test(text[end])) end++;
    else while (end > 0 && /\s/.test(text[end - 1])) end--;
    let start = end;
    while (start > 0 && /\S/.test(text[start - 1])) start--;
    if (start === end) return null;
    const ch = this.snap.ids[start];
    const to = this.snap.ids[end - 1];
    return ch && to ? { ch, to } : null;
  }

  /** The sparkling word under a point, if any. */
  sparkleAt(x, y) {
    return document.elementsFromPoint(x, y).find((el) => el.classList?.contains("sparkle") && this.draw.contains(el)) || null;
  }

  /**
   * What lies on the words: a hidden photo or recording makes them sparkle, a 표시 colours
   * them like a highlighter, a 잠금 greys them and puts a small lock after the last one.
   * Only classes and data change (and absolutely placed marks), so the drawn words keep
   * exactly the input box's layout.
   */
  /** The day's lock in its heading: who locked the whole day (or nothing). */
  drawDayLock() {
    const lock = this.sheet.dayLock();
    this.el.classList.toggle("day-locked", !!lock);
    this.dayLock.hidden = !lock;
    if (!lock) return;
    const name = this.session.room.member(lock.by)?.name || "누군가";
    const key = lock.id + ":" + name;
    if (this.dayLock.dataset.key === key) return;
    this.dayLock.dataset.key = key;
    this.dayLock.replaceChildren(icon("lock"), h("span", { text: `${name} 님이 잠근 날` }));
  }

  markRanges() {
    this.drawDayLock();
    for (const el of this.draw.querySelectorAll(".w.sparkle, .w.hl, .w.locked")) {
      el.classList.remove("sparkle", "sound", "hl", "locked", "lock-end");
      for (const k of ["att", "hl", "lock"]) delete el.dataset[k];
    }
    const atts = this.sheet.attachments();
    const marks = this.sheet.marks();
    const locks = this.sheet.locks();
    if (!atts.length && !marks.length && !locks.length) return;
    const chars = this.sheet.chars();
    const at = new Map(chars.map((c, i) => [c.id, i]));
    const words = splitWords(chars);
    const span = (w) => this.draw.querySelector(`.w[data-anchor="${w.anchor}"]`);
    const covered = (r) => {
      const i0 = at.get(r.ch);
      const i1 = at.get(r.to);
      if (i0 === undefined || i1 === undefined) return [];
      const lo = Math.min(i0, i1);
      const hi = Math.max(i0, i1);
      return words.filter((w) => w.end > lo && w.start <= hi).map(span).filter(Boolean);
    };
    for (const m of marks) for (const el of covered(m)) { el.classList.add("hl"); el.dataset.hl = m.c; }
    for (const l of locks) {
      const els = covered(l);
      for (const el of els) { el.classList.add("locked"); el.dataset.lock = l.id; }
      els[els.length - 1]?.classList.add("lock-end");
    }
    for (const a of atts) {
      for (const el of covered(a)) {
        el.classList.add("sparkle");
        el.classList.toggle("sound", a.kind === "sound");
        el.dataset.att = a.id;
      }
    }
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
    // On-screen distances, back in the page's own units when the page is zoomed.
    const z = this.layers.offsetWidth ? base.width / this.layers.offsetWidth : 1;
    if (!line.len) {
      const r = line.el.getBoundingClientRect();
      return { x: (r.left - base.left) / z, y: (r.top - base.top) / z, h: r.height / z };
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
    return { x: ((atEnd ? r.right : r.left) - base.left) / z, y: (r.top - base.top) / z, h: r.height / z };
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
      wanted.set(peer.key, { index: this.sheet.indexAfter(s.i), color: personColor(member, theme), name: member.name });
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
