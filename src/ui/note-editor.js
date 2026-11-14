// 음 편집: one clip's notes as a piano roll.
//
// Drag a note to move it (sideways = time, up and down = pitch); drag its right
// end to change its length; double-tap an empty spot to add a note; tap a note
// to hear it and choose it, then 삭제. Two fingers zoom (sideways = time, up
// and down = row height); on a computer the wheel zooms time and Shift+wheel
// zooms the rows. Edits lie over the recording's notes, so they reach every
// clip cut from the same recording, and each one can be undone.

import { h, openSheet } from "./dom.js";
import { noteLabel, solfege } from "../audio/notes.js";
import { noteSetOps, noteAddOps } from "../core/song.js";
import { timeText } from "./song-view.js";

const BLACK = new Set([1, 3, 6, 8, 10]);
const EDGE_PX = 12;
const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

/**
 * song and clock make the edits; commit(made) applies { ops, atoms };
 * preview(p, seconds) sounds a note; canEdit() false makes it read-only;
 * color paints the notes. Returns { refresh, close }.
 */
export function openNoteEditor(root, { song, clipId, clock, commit, preview, canEdit, color }) {
  let pps = 140;
  let rowRem = 1.3;
  let chosen = null;
  let refresh = () => {};
  const close = openSheet(root, "음 편집", (panel, closeSheet, onClose) => {
    panel.classList.add("editor-panel");
    const roll = h("div", { class: "roll", id: "roll" });
    const keys = h("div", { class: "keys" });
    const grid = h("div", { class: "grid", id: "roll-grid" });
    const playline = h("div", { class: "roll-line", hidden: true });
    roll.append(keys, grid);
    grid.append(playline);
    const info = h("p", { class: "help", id: "note-info" });
    const list = h("ol", { class: "note-list", id: "note-list" });
    const zoom = (dx, dy) => { pps = Math.min(900, Math.max(30, pps * dx)); rowRem = Math.min(3, Math.max(0.7, rowRem * dy)); draw(); };
    const del = h("button", { type: "button", class: "btn small quiet", id: "note-delete", text: "음 삭제", onclick: () => removeChosen() });
    panel.append(
      h("p", { class: "help", text: "끌면 옮겨지고, 오른쪽 끝을 끌면 길이가 바뀌어요. 빈 곳을 두 번 누르면 음이 생겨요. 같은 녹음에서 나온 클립에 모두 적용돼요." }),
      h("div", { class: "roll-tools" },
        h("button", { type: "button", class: "chip", id: "roll-time-out", text: "시간 −", onclick: () => zoom(1 / 1.4, 1) }),
        h("button", { type: "button", class: "chip", id: "roll-time-in", text: "시간 +", onclick: () => zoom(1.4, 1) }),
        h("button", { type: "button", class: "chip", id: "roll-row-out", text: "높이 −", onclick: () => zoom(1, 1 / 1.25) }),
        h("button", { type: "button", class: "chip", id: "roll-row-in", text: "높이 +", onclick: () => zoom(1, 1.25) }),
        del),
      roll, info, list);

    function clip() {
      return song.layout().find((c) => c.id === clipId) || null;
    }

    function visibleNotes(c) {
      return song.notesOf(c.src)
        .map((n) => ({ ...n, s: Math.max(n.t, c.offset), e: Math.min(n.t + n.d, c.offset + c.length) }))
        .filter((n) => n.e - n.s >= 20);
    }

    function range(notes) {
      const ps = notes.map((n) => n.p);
      let lo = ps.length ? Math.min(...ps) - 4 : 55;
      let hi = ps.length ? Math.max(...ps) + 4 : 72;
      while (hi - lo < 18) { lo--; hi++; }
      return { lo: Math.max(21, lo), hi: Math.min(108, hi) };
    }

    let layout = null;
    function draw() {
      const c = clip();
      if (!c) return closeSheet();
      const notes = visibleNotes(c);
      const { lo, hi } = range(notes);
      const rowH = rowRem * remPx();
      const keyW = 2.6 * remPx();
      const width = Math.max(roll.clientWidth - keyW, (c.length / 1000) * pps + 40);
      layout = { c, lo, hi, rowH, keyW, notes };
      grid.style.width = width + "px";
      grid.style.height = (hi - lo + 1) * rowH + "px";
      keys.style.height = grid.style.height;
      // Rows: one per key, the black keys a shade darker, every 도 named.
      keys.replaceChildren(...range2(hi, lo).map((p) => h("span", { class: "key" + (BLACK.has(p % 12) ? " black" : "") + (p % 12 === 0 ? " c" : ""), style: { height: rowH + "px" }, text: rowH >= 14 || p % 12 === 0 ? (p % 12 === 0 ? noteLabel(p) : solfege(p)) : "" })));
      grid.replaceChildren(playline, ...range2(hi, lo).map((p, i) => h("span", { class: "lane-row" + (BLACK.has(p % 12) ? " black" : ""), style: { top: i * rowH + "px", height: rowH + "px" } })),
        ...notes.map((n) => {
          const el = h("i", {
            class: "rnote" + (n.key === chosen ? " chosen" : ""),
            data: { key: n.key, p: String(n.p) },
            style: { left: ((n.s - c.offset) / 1000) * pps + "px", width: Math.max(6, ((n.e - n.s) / 1000) * pps) + "px", top: (hi - n.p) * rowH + 1 + "px", height: rowH - 2 + "px", background: color },
            text: ((n.e - n.s) / 1000) * pps >= 22 ? solfege(n.p) : "",
          });
          wireNote(el, n);
          return el;
        }));
      list.replaceChildren(...notes.map((n) => h("li", {},
        h("button", { type: "button", class: "note-row" + (n.key === chosen ? " chosen" : ""), data: { key: n.key }, onclick: () => choose(n) },
          h("span", { class: "note-name", text: noteLabel(n.p) }),
          h("span", { class: "note-at", text: timeText(c.start + n.s - c.offset) }),
          h("span", { class: "note-len", text: ((n.e - n.s) / 1000).toFixed(2) + "초" })))));
      const pick = notes.find((n) => n.key === chosen);
      info.textContent = pick ? `${noteLabel(pick.p)} · ${((pick.e - pick.s) / 1000).toFixed(2)}초` : `음 ${notes.length}개`;
      del.disabled = !pick || !canEdit();
    }
    refresh = draw;

    function choose(n) {
      chosen = n.key;
      preview(n.p, Math.min(1.2, (n.e - n.s) / 1000));
      draw();
    }

    function removeChosen() {
      if (!chosen || !canEdit()) return;
      commit(noteSetOps(...ctx(), chosen, { gone: true }));
      chosen = null;
      draw();
    }

    const ctx = () => [clock, song, layout.c.src];

    function wireNote(el, n) {
      el.addEventListener("pointerdown", (e) => {
        if (!canEdit()) return void choose(n);
        e.preventDefault();
        el.setPointerCapture?.(e.pointerId);
        const box = el.getBoundingClientRect();
        const resize = box.right - e.clientX <= EDGE_PX;
        const start = { x: e.clientX, y: e.clientY, moved: false };
        const move = (ev) => {
          const dx = ev.clientX - start.x;
          const dy = ev.clientY - start.y;
          if (Math.hypot(dx, dy) > 4) start.moved = true;
          if (resize) el.style.width = Math.max(6, box.width + dx) + "px";
          else el.style.transform = `translate(${dx}px, ${Math.round(dy / layout.rowH) * layout.rowH}px)`;
        };
        const up = (ev) => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", cancel);
          if (!start.moved) return choose(n);
          const dx = ev.clientX - start.x;
          const dy = ev.clientY - start.y;
          chosen = n.key;
          if (resize) {
            const d = Math.max(40, Math.round((((n.e - n.s) / 1000) * pps + dx) / pps * 1000 / 10) * 10);
            commit(noteSetOps(...ctx(), n.key, { d: d + (n.s - n.t) }));
          } else {
            const t = Math.max(0, Math.round((n.t + (dx / pps) * 1000) / 10) * 10);
            const p = Math.min(108, Math.max(21, n.p - Math.round(dy / layout.rowH)));
            commit(noteSetOps(...ctx(), n.key, { t, p }));
            if (p !== n.p) preview(p, 0.5);
          }
          draw();
        };
        const cancel = () => draw();
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", cancel);
      });
    }

    // A double tap (or double click) on an empty spot adds a note there.
    let lastTap = null;
    grid.addEventListener("pointerup", (e) => {
      if (e.target.closest(".rnote") || !canEdit() || !layout) return;
      const now = performance.now();
      const near = lastTap && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24;
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      if (!near) return;
      lastTap = null;
      const r = grid.getBoundingClientRect();
      const t = layout.c.offset + Math.round((((e.clientX - r.left) / pps) * 1000) / 10) * 10;
      const p = layout.hi - Math.floor((e.clientY - r.top) / layout.rowH);
      const made = noteAddOps(clock, song, layout.c.src, { t, d: 300, p, v: 0.8 });
      commit(made);
      chosen = made.key;
      preview(p, 0.3);
      draw();
    });

    // Two fingers: sideways spreads time, up and down spreads the rows.
    let pinch = null;
    const spread = (t) => ({ x: Math.abs(t[0].clientX - t[1].clientX), y: Math.abs(t[0].clientY - t[1].clientY) });
    roll.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) pinch = { ...spread(e.touches), pps, rowRem };
    }, { passive: true });
    roll.addEventListener("touchmove", (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const now = spread(e.touches);
      if (pinch.x > 40) pps = Math.min(900, Math.max(30, pinch.pps * (now.x / pinch.x)));
      if (pinch.y > 40) rowRem = Math.min(3, Math.max(0.7, pinch.rowRem * (now.y / pinch.y)));
      draw();
    }, { passive: false });
    roll.addEventListener("touchend", (e) => { if (e.touches.length < 2) pinch = null; });
    roll.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      const f = Math.exp(-e.deltaY / 300);
      if (e.shiftKey) zoom(1, f);
      else zoom(f, 1);
    }, { passive: false });

    requestAnimationFrame(draw);
    onClose(() => { refresh = () => {}; });
  });
  return { refresh: () => refresh(), close };
}

/** hi down to lo. */
function range2(hi, lo) {
  const out = [];
  for (let p = hi; p >= lo; p--) out.push(p);
  return out;
}
