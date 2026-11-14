// The whiteboard room: a big surface for cards, and 잇기 lines that set the
// order song cards play in.
//
// Modes (top): 전체 (move, open and edit cards), 이동 (only move), 잇기 (tap
// cards one after another to chain them 1, 2, 3…; tap a line's number to
// remove it). Drag empty space to look around; two fingers or the wheel
// zoom. ▶ plays the song cards in order: chains where their first card
// stands, other cards from the leftmost. Song cards come from a song room
// (보내기 there, or 복사 there and + 노래 here).

import { h, icon, iconButton, segmented, openSheet, toast } from "./dom.js";
import { watchFingers } from "./fingers.js";
import { currentTheme, onThemeChange } from "./theme.js";
import { memberColor, INK } from "../core/paint.js";
import { UndoStack } from "../core/undo.js";
import { addItemOps, setItemOps, removeItemOps, linkOps, unlinkOps, invertBoardOps, playOrder, boardSong, cardFromClip } from "../core/board.js";
import { clipboardItem } from "../clipboard.js";
import { solfege } from "../audio/notes.js";
import { audioContext, SongPlayer } from "../audio/engine.js";
import { decodeWav } from "../audio/wav.js";
import { toMono } from "../audio/dsp.js";
import { bufferFromSamples } from "../audio/decode.js";
import { getSettings } from "../identity.js";

const SVG = "http://www.w3.org/2000/svg";

export function mountBoardRoom(body, app, session, frame) {
  const board = session.doc("board");
  const root = app.root;
  const undo = new UndoStack(100, 0);
  let zoom = 1;
  let panX = 24;
  let panY = 24;
  let mode = "all";
  let selected = null;
  let linkFrom = null;
  let player = null;
  let playing = null;
  let frameReq = 0;
  let alive = true;

  body.classList.add("board-body");
  const lines = document.createElementNS(SVG, "svg");
  lines.setAttribute("class", "board-lines");
  const content = h("div", { class: "board-content", id: "board-content" }, lines);
  const surface = h("div", { class: "board", id: "board" }, content);
  const hint = h("p", { class: "board-hint", id: "board-hint" });
  body.append(surface, hint);

  const modes = segmented([["all", "전체", "mode-all"], ["move", "이동", "mode-move"], ["link", "잇기", "mode-link"]], mode, (m) => { mode = m; linkFrom = null; draw(); }, "boardMode");
  modes.classList.add("board-modes");
  frame.top.append(h("div", { class: "board-top" }, modes,
    h("div", { class: "song-top-left" },
      iconButton("board-zoom-out", "zoomOut", "작게 보기", () => zoomAt(1 / 1.25)),
      iconButton("board-zoom-in", "zoomIn", "크게 보기", () => zoomAt(1.25)))));

  const playButton = iconButton("board-play", "play", "순서대로 재생", () => togglePlay());
  const toolbar = h("div", { class: "toolbar board-tools", id: "board-tools" },
    h("button", { class: "icon-btn text-btn", id: "add-note", type: "button", text: "+ 글", onclick: () => addNote() }),
    h("button", { class: "icon-btn text-btn", id: "add-song", type: "button", text: "+ 노래", onclick: () => addSong() }),
    playButton,
    iconButton("board-undo", "undo", "실행취소", () => step("undo")),
    iconButton("board-redo", "redo", "다시실행", () => step("redo")),
    iconButton("board-delete", "eraser", "고른 카드 지우기", () => removeSelected()));
  body.after(toolbar);

  const readOnly = () => !!session.transport.readOnly;
  const colorOf = (by) => { const m = session.room.member(by); return m ? memberColor(m.color, currentTheme()) : INK[currentTheme()]; };

  // ---- drawing -------------------------------------------------------------------

  function place() {
    content.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }

  function draw() {
    if (!alive) return;
    place();
    const items = board.items();
    const order = playOrder(board).map((i) => i.id);
    const keep = new Set();
    for (const item of items) {
      keep.add(item.id);
      let el = content.querySelector(`.card[data-id="${item.id}"]`);
      if (!el) {
        el = h("div", { class: "card " + item.kind, data: { id: item.id } });
        wireCard(el, item.id);
        content.append(el);
      }
      el.style.left = item.x + "px";
      el.style.top = item.y + "px";
      el.style.width = item.w + "px";
      el.style.setProperty("--c", colorOf(item.by));
      el.classList.toggle("chosen", item.id === selected);
      el.classList.toggle("link-from", item.id === linkFrom);
      el.classList.toggle("playing", item.id === playing);
      const key = item.kind + "|" + (item.text ?? "") + "|" + order.indexOf(item.id);
      if (el.dataset.key !== key) {
        el.dataset.key = key;
        el.replaceChildren(...cardInside(item, order.indexOf(item.id)));
      }
    }
    for (const el of [...content.querySelectorAll(".card")]) if (!keep.has(el.dataset.id)) el.remove();
    drawLines();
    hint.textContent = items.length ? (mode === "link" ? (linkFrom ? "다음에 올 카드를 누르세요. 번호를 누르면 그 줄이 지워져요." : "먼저 재생할 카드부터 차례로 누르세요.") : "")
      : "노래 방에서 클립을 '보내기' 하거나, 아래 + 노래 / + 글로 카드를 놓아 보세요.";
    hint.hidden = !hint.textContent;
    toolbar.querySelector("#board-undo").disabled = !undo.canUndo;
    toolbar.querySelector("#board-redo").disabled = !undo.canRedo;
    toolbar.querySelector("#board-delete").disabled = !selected || readOnly();
    playButton.replaceChildren(icon(player?.playing ? "pause" : "play"));
    for (const b of modes.children) b.setAttribute("aria-pressed", String(b.dataset.value === mode));
  }

  function cardInside(item, place) {
    if (item.kind === "note") return [h("p", { class: "card-text", text: item.text || "빈 메모" })];
    const d = item.data;
    const ps = d.notes.map((n) => n[2]);
    const lo = ps.length ? Math.min(...ps) : 60;
    const hi = ps.length ? Math.max(...ps) : 60;
    const span = Math.max(10, hi - lo + 2);
    const bars = h("div", { class: "card-notes" }, d.notes.map((n) => h("i", {
      class: "note",
      text: (n[1] / d.dur) * item.w >= 16 ? solfege(n[2]) : "",
      style: { left: (n[0] / d.dur) * 100 + "%", width: `max(3px, ${(n[1] / d.dur) * 100}%)`, top: `calc(${((hi + (span - (hi - lo)) / 2 - n[2]) / span) * 100}% - 0.4rem)`, height: "0.8rem" },
    })));
    return [
      h("div", { class: "card-head" },
        place >= 0 && h("span", { class: "card-order", text: String(place + 1) }),
        h("span", { class: "card-name", text: d.name || "노래" }),
        h("span", { class: "card-len", text: (d.dur / 1000).toFixed(1) + "초" })),
      bars,
    ];
  }

  function drawLines() {
    const items = new Map(board.items().map((i) => [i.id, i]));
    const parts = [];
    for (const l of board.links()) {
      const a = items.get(l.a);
      const b = items.get(l.b);
      const ea = content.querySelector(`.card[data-id="${l.a}"]`);
      const eb = content.querySelector(`.card[data-id="${l.b}"]`);
      if (!a || !b || !ea || !eb) continue;
      const x1 = a.x + a.w;
      const y1 = a.y + ea.offsetHeight / 2;
      const x2 = b.x;
      const y2 = b.y + eb.offsetHeight / 2;
      const bend = Math.max(60, Math.abs(x2 - x1) / 2);
      parts.push(`<path d="M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}" stroke="${l.color}" />`);
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      parts.push(`<g class="badge" data-link="${l.id}" transform="translate(${mx} ${my})"><circle r="13" fill="${l.color}" /><text text-anchor="middle" dy="4.5">${l.n}</text></g>`);
    }
    lines.innerHTML = parts.join("");
    for (const g of lines.querySelectorAll(".badge")) {
      g.addEventListener("pointerdown", (e) => {
        if (mode !== "link" || readOnly()) return;
        e.stopPropagation();
        apply(unlinkOps(session.clock, board, g.dataset.link));
      });
    }
  }

  // ---- touch --------------------------------------------------------------------------

  const toContent = (cx, cy) => {
    const r = surface.getBoundingClientRect();
    return { x: (cx - r.left - panX) / zoom, y: (cy - r.top - panY) / zoom };
  };

  function zoomAt(f, cx, cy) {
    const r = surface.getBoundingClientRect();
    const ax = cx ?? r.left + r.width / 2;
    const ay = cy ?? r.top + r.height / 2;
    const before = toContent(ax, ay);
    zoom = Math.min(2.5, Math.max(0.3, zoom * f));
    panX = ax - r.left - before.x * zoom;
    panY = ay - r.top - before.y * zoom;
    place();
  }

  // A second finger means zoom: a card the first finger was dragging goes back,
  // nothing is saved, and the lifts that end the pinch are no taps.
  let gesture = null;
  const fingers = watchFingers(surface, () => {
    gesture?.();
    pan = null;
  });

  function wireCard(el, id) {
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (fingers.pinching) return;
      const item = board.item(id);
      if (!item) return;
      el.setPointerCapture?.(e.pointerId);
      const linking = mode === "link";
      const start = { x: e.clientX, y: e.clientY, ix: item.x, iy: item.y, moved: false };
      const mine = (ev) => ev.pointerId === e.pointerId;
      const move = (ev) => {
        if (!mine(ev)) return;
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4 * zoom) start.moved = true;
        if (linking || readOnly()) return;
        el.style.left = start.ix + (ev.clientX - start.x) / zoom + "px";
        el.style.top = start.iy + (ev.clientY - start.y) / zoom + "px";
      };
      const stop = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", cancel);
        gesture = null;
      };
      const up = (ev) => {
        if (!mine(ev)) return;
        stop();
        // 잇기 counts a tap, not a touch, so a pinch that starts on a card joins nothing.
        if (linking) return void (start.moved || tapToLink(id));
        if (start.moved && !readOnly()) {
          apply(setItemOps(session.clock, board, id, { x: start.ix + (ev.clientX - start.x) / zoom, y: start.iy + (ev.clientY - start.y) / zoom }));
          return;
        }
        if (selected === id && mode === "all" && item.kind === "note") return void editNote(id);
        selected = id;
        draw();
      };
      const cancel = (ev) => {
        if (ev && !mine(ev)) return;
        stop();
        el.style.left = start.ix + "px";
        el.style.top = start.iy + "px";
      };
      gesture = cancel;
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", cancel);
    });
  }

  function tapToLink(id) {
    if (readOnly()) return;
    if (!linkFrom || linkFrom === id) {
      linkFrom = id;
      return void draw();
    }
    const made = linkOps(session.clock, board, linkFrom, id, session.memberId);
    if (!made.ops.length) toast(root, "그 카드는 이미 다른 줄에 이어져 있어요");
    else apply(made);
    linkFrom = id;
    draw();
  }

  let pan = null;
  surface.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".card") || e.target.closest(".badge") || fingers.pinching) return;
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY, px: panX, py: panY, moved: false };
    surface.setPointerCapture?.(e.pointerId);
  });
  surface.addEventListener("pointermove", (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    if (Math.hypot(e.clientX - pan.x, e.clientY - pan.y) > 4) pan.moved = true;
    panX = pan.px + e.clientX - pan.x;
    panY = pan.py + e.clientY - pan.y;
    place();
  });
  surface.addEventListener("pointerup", (e) => {
    if (pan && e.pointerId !== pan.id) return;
    if (pan && !pan.moved) {
      selected = null;
      linkFrom = null;
      draw();
    }
    pan = null;
  });
  let pinch = null;
  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  surface.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) { pinch = { d: spread(e.touches), zoom }; pan = null; }
  }, { passive: true });
  surface.addEventListener("touchmove", (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    zoomAt((pinch.zoom * (spread(e.touches) / pinch.d)) / zoom, cx, cy);
  }, { passive: false });
  surface.addEventListener("touchend", (e) => { if (e.touches.length < 2) pinch = null; });
  surface.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.shiftKey) { panX -= e.deltaY; place(); return; }
    zoomAt(Math.exp(-e.deltaY / 400), e.clientX, e.clientY);
  }, { passive: false });

  // ---- editing --------------------------------------------------------------------

  function record(atoms) {
    if (atoms.length) undo.record(atoms, { now: Date.now(), typing: false });
  }

  function apply(made) {
    if (!made?.ops?.length) return false;
    session.commit("board", made.ops);
    record(made.atoms);
    draw();
    return true;
  }

  function step(dir) {
    const atoms = dir === "undo" ? undo.undo() : undo.redo();
    if (!atoms) return;
    session.commit("board", invertBoardOps(board, session.clock, atoms, dir));
    draw();
  }

  /** Where a new card goes: right of the rightmost card, in view. */
  function freeSpot() {
    const items = board.items();
    if (!items.length) return toContent(surface.getBoundingClientRect().left + 30, surface.getBoundingClientRect().top + 30);
    const right = items.reduce((a, b) => (b.x + b.w > a.x + a.w ? b : a));
    return { x: right.x + right.w + 60, y: right.y };
  }

  function addNote() {
    if (readOnly()) return;
    const at = freeSpot();
    const made = addItemOps(session.clock, board, { kind: "note", x: at.x, y: at.y, data: { text: "" }, by: session.memberId });
    apply(made);
    selected = made.id;
    editNote(made.id);
  }

  function editNote(id) {
    const item = board.item(id);
    if (!item || readOnly()) return;
    openSheet(root, "메모", (panel, close) => {
      const area = h("textarea", { class: "input note-area", id: "note-text", rows: 5, value: item.text || "" });
      panel.append(h("div", { class: "form" }, area,
        h("button", { class: "btn", id: "note-save", type: "button", text: "저장", onclick: () => { apply(setItemOps(session.clock, board, id, { text: area.value })); close(); } })));
      setTimeout(() => area.focus(), 50);
    });
  }

  function addSong() {
    if (readOnly()) return;
    const item = clipboardItem(app.store, "song-clip");
    if (!item) return void toast(root, "노래 방에서 클립을 '복사'하면 여기에 붙일 수 있어요. '보내기'로 바로 보낼 수도 있어요.", 4200);
    const at = freeSpot();
    const made = addItemOps(session.clock, board, { kind: "song", x: at.x, y: at.y, data: cardFromClip(item), by: session.memberId });
    apply(made);
    selected = made.id;
    draw();
  }

  function removeSelected() {
    if (!selected || readOnly()) return;
    apply(removeItemOps(session.clock, board, selected));
    selected = null;
    draw();
  }

  // ---- playing ----------------------------------------------------------------------

  async function togglePlay() {
    if (player?.playing) {
      player.stop();
      playing = null;
      cancelAnimationFrame(frameReq);
      return void draw();
    }
    const order = playOrder(board);
    if (!order.length) return void toast(root, "재생할 노래 카드가 없어요");
    const ctx = await audioContext();
    if (!ctx) return;
    const song = boardSong(board);
    const audio = new Map();
    for (const src of song.sources.values()) {
      if (!src.blob) continue;
      const kept = await app.blobs.get(src.blob);
      const wav = kept && decodeWav(kept.data);
      if (wav) audio.set(src.id, bufferFromSamples(ctx, toMono(wav.channels), wav.rate));
    }
    player?.close();
    const s = getSettings(app.store);
    player = new SongPlayer(ctx, { song: () => song, audioFor: (id) => audio.get(id) || null, onEnd: () => { playing = null; draw(); } });
    player.setMode(s.songMode);
    player.setTone(s.pianoTone);
    player.setSpeed(s.songSpeed || 1);
    player.play(0);
    const ends = [];
    let at = 0;
    for (const card of order) ends.push([card.id, (at += card.data.dur)]);
    const tick = () => {
      if (!alive || !player?.playing) return;
      const pos = player.position;
      const now = ends.find(([, end]) => pos < end);
      if (now && now[0] !== playing) {
        playing = now[0];
        draw();
      }
      frameReq = requestAnimationFrame(tick);
    };
    frameReq = requestAnimationFrame(tick);
    draw();
  }

  const offs = [
    session.on("change", ({ doc }) => { if (doc === "board" || doc === "room") draw(); }),
    onThemeChange(draw),
  ];
  session.load("board").then(draw);
  draw();

  return {
    /** 레퍼런스 → 이 방에 붙이기: a memo card. */
    insertText(text) {
      const at = freeSpot();
      apply(addItemOps(session.clock, board, { kind: "note", x: at.x, y: at.y, data: { text }, by: session.memberId }));
    },
    close() {
      alive = false;
      cancelAnimationFrame(frameReq);
      player?.close();
      for (const off of offs) off();
      toolbar.remove();
      frame.top.replaceChildren();
      body.classList.remove("board-body");
    },
  };
}
