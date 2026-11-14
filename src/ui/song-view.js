// The song room's timeline: a time bar on top, rows below, clips as
// rectangles of equal height whose width is their time. Inside a clip: the
// waveform (원본), or bars whose height is the note's pitch (피아노), each
// named 도 레 미 when there is room.
//
// Touch: tap a clip to choose it; press and hold, then drag, to move it
// (sideways = time, up and down = row); drag without holding to scroll. Tap
// the time bar or an empty spot to move the playhead. Two fingers zoom.

import { h } from "./dom.js";
import { watchFingers } from "./fingers.js";
import { solfege } from "../audio/notes.js";
import { fromBase64, PEAKS_PER_SECOND } from "../audio/peaks.js";

const LONG_PRESS_MS = 380;
const SLOP_PX = 8;
export const MIN_PPS = 12;
export const MAX_PPS = 320;

const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

/** One pitch window per sound, so a clip's bars keep their heights however it is cut. */
function pitchWindow(notes) {
  const ps = notes.map((n) => n.p);
  const lo = ps.length ? Math.min(...ps) : 60;
  const hi = ps.length ? Math.max(...ps) : 60;
  const span = Math.max(10, hi - lo + 2);
  return { top: (lo + hi) / 2 + span / 2, span };
}

function peaksOf(source) {
  if (!source.peakBytes) source.peakBytes = fromBase64(source.peaks || "");
  return source.peakBytes;
}

function wavePath(bytes, fromMs, toMs) {
  const per = 1000 / PEAKS_PER_SECOND;
  const i0 = Math.floor(fromMs / per);
  const i1 = Math.min(bytes.length, Math.ceil(toMs / per));
  if (i1 <= i0) return null;
  const n = i1 - i0;
  let top = "";
  let bottom = "";
  for (let i = i0; i < i1; i++) {
    const v = ((bytes[i] / 255) * 0.92).toFixed(3);
    top += `${i === i0 ? "M" : "L"}${i - i0} ${-v} `;
    bottom = `L${i - i0} ${v} ` + bottom;
  }
  return { d: top + `L${n - 1} 0 ` + bottom + "Z", n };
}

export class Timeline {
  /**
   * handlers: seek(ms), tapEmpty(ms, row), select(clipId), move(clipId, startMs, row),
   * zoomed(pps)
   */
  constructor(handlers) {
    this.on = handlers;
    this.pps = 64;
    this.rowScale = 1; // two fingers up and down (or Alt+wheel) make rows taller for a closer look
    this.model = null;
    this.clipEls = new Map();
    this.drag = null;
    this.ruler = h("div", { class: "ruler", id: "ruler" });
    this.head = h("div", { class: "head", "aria-hidden": "true" });
    this.lanes = h("div", { class: "lanes", id: "lanes" });
    this.line = h("div", { class: "playline", "aria-hidden": "true" });
    this.empty = h("p", { class: "song-empty", id: "song-empty", hidden: true });
    this.content = h("div", { class: "song-content" }, this.ruler, this.lanes, this.line);
    this.ruler.append(this.head);
    this.el = h("div", { class: "timeline", id: "timeline" }, this.content, this.empty);
    this.wire();
  }

  get rowH() {
    return 5.25 * remPx() * this.rowScale;
  }

  get rulerH() {
    return 1.9 * remPx();
  }

  get pad() {
    return 0.9 * remPx();
  }

  /** Space above and below a clip inside its row. */
  get inset() {
    return 0.28 * remPx();
  }

  xOf(ms) {
    return this.pad + (ms / 1000) * this.pps;
  }

  msAt(clientX) {
    const box = this.el.getBoundingClientRect();
    return Math.max(0, ((clientX - box.left + this.el.scrollLeft - this.pad) / this.pps) * 1000);
  }

  rowAt(clientY) {
    const box = this.lanes.getBoundingClientRect();
    return Math.max(0, Math.floor((clientY - box.top) / this.rowH));
  }

  // ---- drawing -------------------------------------------------------------------

  render(model) {
    this.model = model;
    const rows = Math.max(model.rows, 1);
    const seconds = Math.max(model.end / 1000 + 8, this.el.clientWidth / this.pps + 2, 12);
    const width = this.xOf(seconds * 1000);
    this.content.style.width = width + "px";
    this.el.dataset.pps = String(this.pps);
    this.lanes.style.height = rows * this.rowH + "px";
    this.drawRuler(seconds);
    this.drawRows(rows, model.selectedRow);
    this.drawClips(model);
    this.empty.hidden = !model.empty;
    this.empty.textContent = model.empty || "";
    this.setPlayhead(model.playhead);
  }

  drawRuler(seconds) {
    const step = this.pps < 24 ? 10 : this.pps < 40 ? 5 : this.pps < 90 ? 1 : 0.5;
    const label = this.pps < 24 ? 10 : this.pps < 40 ? 5 : this.pps < 60 ? 2 : 1;
    const key = this.pps + ":" + Math.ceil(seconds);
    if (this.rulerKey === key) return;
    this.rulerKey = key;
    const ticks = [];
    for (let s = 0; s <= seconds + 1e-9; s += step) {
      const whole = Math.abs(s - Math.round(s)) < 1e-9;
      const named = whole && Math.round(s) % label === 0;
      ticks.push(h("span", { class: "tick" + (named ? " named" : whole ? "" : " half"), style: { left: this.xOf(s * 1000) + "px" }, text: named ? timeText(s * 1000, true) : "" }));
    }
    this.ruler.replaceChildren(...ticks, this.head);
  }

  drawRows(rows, selected) {
    const want = [];
    for (let r = 0; r < rows; r++) {
      let el = this.lanes.querySelector(`.row-bg[data-row="${r}"]`);
      if (!el) el = h("div", { class: "row-bg", data: { row: String(r) } });
      el.style.top = r * this.rowH + "px";
      el.style.height = this.rowH + "px";
      el.classList.toggle("chosen", r === selected);
      want.push(el);
    }
    for (const el of [...this.lanes.querySelectorAll(".row-bg")]) if (!want.includes(el)) el.remove();
    for (const el of want) if (!el.isConnected) this.lanes.prepend(el);
  }

  drawClips(model) {
    const seen = new Set();
    for (const clip of model.clips) {
      seen.add(clip.id);
      let entry = this.clipEls.get(clip.id);
      if (!entry) {
        const el = h("div", { class: "clip", data: { id: clip.id }, role: "button", tabindex: "0" });
        this.wireClip(el, clip.id);
        entry = { el, key: "" };
        this.clipEls.set(clip.id, entry);
        this.lanes.append(el);
      }
      this.placeClip(entry, clip, model);
    }
    for (const [id, entry] of this.clipEls) {
      if (seen.has(id)) continue;
      entry.el.remove();
      this.clipEls.delete(id);
    }
    this.drawRecording(model.recording);
    this.drawOthers(model.others || []);
  }

  /** Friends recording right now: a growing outline on their row, with their name. */
  drawOthers(list) {
    const old = [...this.lanes.querySelectorAll(".clip.other-rec")];
    old.slice(list.length).forEach((el) => el.remove());
    list.forEach((r, i) => {
      let el = old[i];
      if (!el) {
        el = h("div", { class: "clip other-rec", "aria-label": "친구가 녹음 중" }, h("span", { class: "rec-name" }));
        this.lanes.append(el);
      }
      el.style.left = this.xOf(r.start) + "px";
      el.style.top = r.row * this.rowH + this.inset + "px";
      el.style.width = Math.max(4, (r.ms / 1000) * this.pps) + "px";
      el.style.height = this.rowH - 2 * this.inset + "px";
      el.style.setProperty("--c", r.color);
      el.firstChild.textContent = r.name + " 녹음 중";
    });
  }

  placeClip(entry, clip, model) {
    const el = entry.el;
    const source = model.source(clip.src);
    if (this.drag?.id === clip.id && this.drag.lifted) return;
    el.style.left = this.xOf(clip.start) + "px";
    el.style.top = clip.lane * this.rowH + this.inset + "px";
    el.style.width = Math.max(4, (clip.length / 1000) * this.pps) + "px";
    el.style.height = this.rowH - 2 * this.inset + "px";
    el.style.setProperty("--c", model.color(clip.by));
    const peer = model.peers.get(clip.id);
    el.style.setProperty("--peer", peer || "transparent");
    el.classList.toggle("selected", clip.id === model.selected);
    el.classList.toggle("peer", !!peer);
    el.classList.toggle("muted", clip.muted);
    const notes = source ? model.notesOf(clip.src) : [];
    el.setAttribute("aria-label", clipLabel(clip, notes));
    const hasAudio = model.hasAudio(clip.src);
    const key = [clip.offset, clip.length, model.mode, model.showWave, this.pps, this.rowScale, hasAudio, clip.muted, clip.locked, model.color(clip.by), notes.length, notes.map((n) => n.t + ":" + n.d + ":" + n.p).join(",")].join("|");
    if (entry.key === key) return;
    entry.key = key;
    el.replaceChildren(...this.clipInside(clip, source, model, hasAudio, notes));
    el.classList.toggle("no-notes", model.mode === "piano" && !!source && !notes.some((n) => n.t < clip.offset + clip.length && n.t + n.d > clip.offset));
  }

  clipInside(clip, source, model, hasAudio, notes) {
    if (!source) return [];
    const parts = [];
    const piano = model.mode === "piano";
    const lo = clip.offset;
    const hi = clip.offset + clip.length;
    if (!piano || model.showWave) {
      const wave = wavePath(peaksOf(source), lo, hi);
      if (wave) {
        parts.push(h("span", { class: "wave" + (piano ? " faint" : "") }));
        parts[parts.length - 1].innerHTML = `<svg viewBox="0 -1 ${Math.max(1, wave.n - 1)} 2" preserveAspectRatio="none" aria-hidden="true"><path d="${wave.d}"/></svg>`;
      }
    }
    if (piano) {
      const win = pitchWindow(notes);
      const pxPerMs = this.pps / 1000;
      const barH = this.barHeight(win.span);
      const bars = h("span", { class: "notes" });
      let any = false;
      for (const n of notes) {
        const s = Math.max(n.t, lo);
        const e = Math.min(n.t + n.d, hi);
        if (e - s < 20) continue;
        any = true;
        const widthPx = (e - s) * pxPerMs;
        const bar = h("i", {
          class: "note",
          data: { p: String(n.p) },
          style: {
            left: ((s - lo) / clip.length) * 100 + "%",
            width: `max(3px, ${((e - s) / clip.length) * 100}%)`,
            top: `calc(${(win.top - n.p - 1) / (win.span - 2)} * (100% - ${barH}px))`,
            height: barH + "px",
            opacity: String(0.6 + 0.4 * n.v),
          },
        });
        if (widthPx >= 14) bar.textContent = solfege(n.p);
        bars.append(bar);
      }
      parts.push(bars);
      if (!any) parts.push(h("span", { class: "clip-note", text: "음을 찾지 못했어요" }));
    } else if (!hasAudio) {
      parts.push(h("span", { class: "clip-note", text: "원본은 이 기기에 없어요" }));
    }
    const flags = h("span", { class: "flags" });
    if (clip.muted) flags.append(iconSvg("muted"));
    if (clip.locked) flags.append(iconSvg("lock"));
    if (flags.childNodes.length) parts.push(flags);
    return parts;
  }

  drawRecording(rec) {
    let el = this.lanes.querySelector(".clip.rec");
    if (!rec) return void el?.remove();
    if (!el) {
      el = h("div", { class: "clip rec", id: "rec-clip", "aria-label": "녹음 중" }, h("span", { class: "notes" }), h("span", { class: "rec-time" }));
      this.lanes.append(el);
    }
    el.style.left = this.xOf(rec.start) + "px";
    el.style.top = rec.row * this.rowH + this.inset + "px";
    el.style.width = Math.max(4, (rec.ms / 1000) * this.pps) + "px";
    el.style.height = this.rowH - 2 * this.inset + "px";
    el.querySelector(".rec-time").textContent = timeText(rec.ms);
    const notes = el.querySelector(".notes");
    if (notes.dataset.n === String(rec.notes.length) && notes.dataset.w === String(Math.round(rec.ms / 200))) return;
    notes.dataset.n = String(rec.notes.length);
    notes.dataset.w = String(Math.round(rec.ms / 200));
    const ps = rec.notes.map((n) => n.p);
    const lo = ps.length ? Math.min(...ps) : 60;
    const hi = ps.length ? Math.max(...ps) : 60;
    const span = Math.max(10, hi - lo + 2);
    const top = (lo + hi) / 2 + span / 2;
    const barH = this.barHeight(span);
    notes.replaceChildren(...rec.notes.map((n) => h("i", {
      class: "note",
      text: n.d * this.pps >= 14 ? solfege(n.p) : "",
      style: {
        left: (n.t * 1000 / Math.max(1, rec.ms)) * 100 + "%",
        width: `max(3px, ${(n.d * 1000 / Math.max(1, rec.ms)) * 100}%)`,
        top: `calc(${(top - n.p - 1) / (span - 2)} * (100% - ${barH}px))`,
        height: barH + "px",
      },
    })));
  }

  /**
   * Height of a note bar. One voice sings one note at a time, so bars never sit
   * side by side and may be taller than a semitone's step: tall enough for a name.
   */
  barHeight(span) {
    const inner = this.rowH - 2 * this.inset - 0.5 * remPx();
    return Math.round(Math.max(0.62 * remPx(), Math.min(0.95 * remPx(), (inner / span) * 2.2)));
  }

  setPlayhead(ms) {
    const x = this.xOf(ms) + "px";
    this.head.style.left = x;
    this.line.style.left = x;
  }

  /** Keeps the playhead in view while playing: when it nears the right edge, the view turns a page. */
  follow(ms) {
    const x = this.xOf(ms);
    const left = this.el.scrollLeft;
    const width = this.el.clientWidth;
    if (x > left + width * 0.85 || x < left) this.el.scrollLeft = Math.max(0, x - width * 0.25);
  }

  clipBox(id) {
    return this.clipEls.get(id)?.el.getBoundingClientRect() || null;
  }

  setZoom(pps, anchorMs) {
    const before = anchorMs !== undefined ? this.xOf(anchorMs) - this.el.scrollLeft : 0;
    this.pps = Math.min(MAX_PPS, Math.max(MIN_PPS, pps));
    if (this.model) this.render(this.model);
    if (anchorMs !== undefined) this.el.scrollLeft = Math.max(0, this.xOf(anchorMs) - before);
    this.on.zoomed?.(this.pps);
  }

  // ---- touch -----------------------------------------------------------------------

  wire() {
    // One-finger gestures follow their own pointer and give way to a second
    // finger, which always means zoom (see fingers.js).
    let scrub = null; // the pointer moving the playhead
    let down = null; // a press on an empty spot that may be a tap
    this.fingers = watchFingers(this.el, () => {
      scrub = null;
      down = null;
      this.dropDrag();
    });

    // The time bar: press or drag to move the playhead.
    this.ruler.addEventListener("pointerdown", (e) => {
      if (this.fingers.pinching) return;
      scrub = e.pointerId;
      this.ruler.setPointerCapture?.(e.pointerId);
      this.on.seek(this.msAt(e.clientX));
    });
    this.ruler.addEventListener("pointermove", (e) => { if (e.pointerId === scrub) this.on.seek(this.msAt(e.clientX)); });
    const endScrub = () => { scrub = null; };
    this.ruler.addEventListener("pointerup", endScrub);
    this.ruler.addEventListener("pointercancel", endScrub);

    // An empty spot: a tap moves the playhead there and picks that row.
    this.lanes.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".clip") || this.fingers.pinching) return;
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now() };
    });
    this.lanes.addEventListener("pointerup", (e) => {
      if (!down || e.pointerId !== down.id || e.target.closest(".clip")) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > SLOP_PX) return;
      this.on.tapEmpty(this.msAt(e.clientX), this.rowAt(e.clientY));
    });
    this.lanes.addEventListener("pointercancel", () => { down = null; });

    // Two fingers: spreading sideways zooms time, spreading up and down makes rows taller.
    let pinch = null;
    const spread = (t) => ({ x: Math.abs(t[0].clientX - t[1].clientX), y: Math.abs(t[0].clientY - t[1].clientY) });
    this.el.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) pinch = { ...spread(e.touches), pps: this.pps, rows: this.rowScale, at: this.msAt((e.touches[0].clientX + e.touches[1].clientX) / 2) };
    }, { passive: true });
    this.el.addEventListener("touchmove", (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const now = spread(e.touches);
      if (pinch.y > 40) this.rowScale = Math.min(2.6, Math.max(0.7, pinch.rows * (now.y / pinch.y)));
      this.setZoom(pinch.x > 40 ? pinch.pps * (now.x / pinch.x) : this.pps, pinch.at);
    }, { passive: false });
    this.el.addEventListener("touchend", (e) => { if (e.touches.length < 2) pinch = null; });

    // A computer's wheel zooms time where the pointer is; Shift+wheel moves sideways,
    // Alt+wheel makes rows taller. Sideways swipes on a touchpad scroll as usual.
    this.el.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (e.shiftKey) {
        this.el.scrollLeft += e.deltaY;
        return;
      }
      const f = Math.exp(-e.deltaY / 300);
      if (e.altKey) {
        this.rowScale = Math.min(2.6, Math.max(0.7, this.rowScale * f));
        this.setZoom(this.pps);
      } else this.setZoom(this.pps * f, this.msAt(e.clientX));
    }, { passive: false });

    // A mouse dragged across empty space moves the view, like a finger does.
    let pan = null;
    this.lanes.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.target.closest(".clip")) return;
      pan = { x: e.clientX, y: e.clientY, sl: this.el.scrollLeft, st: this.el.scrollTop };
    });
    window.addEventListener("pointermove", (e) => {
      if (!pan || e.pointerType !== "mouse") return;
      this.el.scrollLeft = pan.sl - (e.clientX - pan.x);
      this.el.scrollTop = pan.st - (e.clientY - pan.y);
    });
    window.addEventListener("pointerup", () => { pan = null; });
  }

  wireClip(el, id) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button > 0) return;
      if (this.fingers.pinching) return;
      el.setPointerCapture?.(e.pointerId);
      const box = el.getBoundingClientRect();
      const lanes = this.lanes.getBoundingClientRect();
      this.drag = {
        id, pointer: e.pointerId, x: e.clientX, y: e.clientY, sl: this.el.scrollLeft, st: this.el.scrollTop, lifted: false, panning: false,
        grabX: e.clientX - box.left, grabY: e.clientY - box.top, lanesTop: lanes.top,
        timer: setTimeout(() => this.lift(el), LONG_PRESS_MS),
      };
    });
    el.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d || d.id !== id || d.pointer !== e.pointerId) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (d.lifted) {
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        return;
      }
      if (!d.panning && Math.hypot(dx, dy) > SLOP_PX) {
        d.panning = true;
        clearTimeout(d.timer);
      }
      // Not held long enough: the finger scrolls the timeline instead.
      if (d.panning) {
        this.el.scrollLeft = d.sl - dx;
        this.el.scrollTop = d.st - dy;
      }
    });
    const end = (e, cancelled) => {
      const d = this.drag;
      if (!d || d.id !== id || d.pointer !== e.pointerId) return;
      clearTimeout(d.timer);
      this.drag = null;
      el.classList.remove("lifted");
      el.style.transform = "";
      if (cancelled) return;
      if (d.lifted) {
        const box = this.lanes.getBoundingClientRect();
        const left = e.clientX - d.grabX - box.left - this.pad;
        const start = Math.max(0, Math.round((left / this.pps) * 1000 / 10) * 10);
        const row = Math.max(0, Math.round((e.clientY - d.grabY - this.inset - box.top) / this.rowH));
        this.on.move(id, start, row);
      } else if (!d.panning) this.on.select(id);
      if (this.model) this.render(this.model);
    };
    el.addEventListener("pointerup", (e) => end(e, false));
    el.addEventListener("pointercancel", (e) => end(e, true));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.on.select(id);
      }
    });
  }

  /** A second finger landed: the clip under the first one is let go, back where it was. */
  dropDrag() {
    const d = this.drag;
    if (!d) return;
    clearTimeout(d.timer);
    this.drag = null;
    const el = this.clipEls.get(d.id)?.el;
    if (!el) return;
    el.classList.remove("lifted");
    el.style.transform = "";
    if (this.model) this.render(this.model);
  }

  lift(el) {
    const d = this.drag;
    if (!d || d.panning || !this.on.canMove?.(d.id)) return;
    d.lifted = true;
    el.classList.add("lifted");
    try {
      navigator.vibrate?.(12);
    } catch {
      // Not every device can buzz.
    }
  }
}

function iconSvg(name) {
  const paths = {
    muted: '<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
    lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5"/>',
  };
  const span = document.createElement("span");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
  return span.firstChild;
}

function clipLabel(clip, notes) {
  const n = notes.filter((x) => x.t < clip.offset + clip.length && x.t + x.d > clip.offset).length;
  return `클립 ${timeText(clip.start)}부터 ${(clip.length / 1000).toFixed(1)}초, 음 ${n}개${clip.muted ? ", 음소거" : ""}`;
}

/** "0:03.4", or "0:03" with `whole`. */
export function timeText(ms, whole = false) {
  const t = Math.max(0, ms) / 1000;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return whole ? `${m}:${String(Math.floor(s + 1e-6)).padStart(2, "0")}` : `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
