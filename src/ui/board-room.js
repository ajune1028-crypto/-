// The whiteboard room: a big surface for cards, and 잇기 lines that set the
// order song cards play in.
//
// Big modes sit on top: 전체 (everything), 이동 (only move), 잇기 (tap cards one
// after another to chain them 1, 2, 3…; tap a line's number to remove it), 노래
// (song cards: as long as their songs; two fingers sideways stretch them in time,
// up and down zoom). Each mode's own tools stand as small icons on the right:
// 내 노래 slides in from the right with the clips of my song rooms; 소리 넣기
// records or imports straight onto the board; a chosen song card can be cut
// where it is tapped, muted, note-edited and copied; 잇기 keeps orders in slots
// 1, 2, 3… to switch between. ▶ plays the song cards in order: chains where their
// first card stands, other cards from the leftmost.

import { h, icon, iconButton, segmented, openSheet, toast } from "./dom.js";
import { watchFingers } from "./fingers.js";
import { currentTheme, onThemeChange } from "./theme.js";
import { openNoteEditor } from "./note-editor.js";
import { timeText } from "./song-view.js";
import { SPEEDS } from "./song-room.js";
import { KEEP_RATE, soundPickers, waysIn, pickerHelp } from "./sound-in.js";
import { memberColor, INK } from "../core/paint.js";
import { UndoStack } from "../core/undo.js";
import { Clock } from "../core/crdt.js";
import { SongDoc, MAX_TAKE_MS } from "../core/song.js";
import {
  addItemOps, setItemOps, removeItemOps, linkOps, unlinkOps, invertBoardOps, playOrder, boardSong, cardsSong,
  cardFromClip, songCardData, splitCardOps, saveSlotOps, useSlotOps, songWidth,
} from "../core/board.js";
import { clipboardItem, copyItem } from "../clipboard.js";
import { solfege } from "../audio/notes.js";
import { audioContext, SongPlayer } from "../audio/engine.js";
import { decodeWav, encodeWav } from "../audio/wav.js";
import { toMono, resample } from "../audio/dsp.js";
import { bufferFromSamples, decodeAudioFile } from "../audio/decode.js";
import { analyzeSamples } from "../audio/analyze.js";
import { MicRecorder, micSupport, micProblem } from "../audio/recorder.js";
import { toBase64 } from "../audio/peaks.js";
import { newBlobId } from "../sync/blobs.js";
import { RoomSession } from "../sync/session.js";
import { getSettings, setSetting } from "../identity.js";

const SVG = "http://www.w3.org/2000/svg";
const MIN_SX = 0.4;
const MAX_SX = 8;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;
const SLOTS_SHOWN = 5;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function mountBoardRoom(body, app, session, frame) {
  const board = session.doc("board");
  const root = app.root;
  const undo = new UndoStack(100, 0);
  const mic = micSupport();
  let zoom = 1;
  let panX = 24;
  let panY = 24;
  let sx = 1; // 노래: song cards (and where cards stand) stretched sideways in time
  let mode = "all";
  let selected = null;
  let linkFrom = null;
  let cutting = false; // 분할: the next tap on a song card cuts it there
  let player = null;
  let playing = null; // the card sounding now
  let solo = null; // a card played alone (▶ 듣기)
  let menu = null; // the chosen card's menu, by the card
  let frameReq = 0;
  let busy = null;
  let editor = null;
  let closeExtra = null; // this screen's open drawer, menu or sheet
  let alive = true;

  body.classList.add("board-body");
  const lines = document.createElementNS(SVG, "svg");
  lines.setAttribute("class", "board-lines");
  const content = h("div", { class: "board-content", id: "board-content" }, lines);
  const surface = h("div", { class: "board", id: "board" }, content);
  const rail = h("div", { class: "board-rail", id: "board-rail" });
  const hint = h("p", { class: "board-hint", id: "board-hint" });
  const status = h("p", { class: "board-status", id: "board-status", role: "status", hidden: true });
  body.append(surface, rail, hint, status);

  const { inputs: pickers, stop: stopPickers } = soundPickers("board", {
    onFile: (file) => { closeExtra?.(); importFile(file); },
    onSilent: () => { if (alive) { closeExtra?.(); pickerHelp({ app, roomId: session.roomId, root, mic }); } },
  });
  body.append(...pickers);

  const modes = segmented([["all", "전체", "mode-all"], ["move", "이동", "mode-move"], ["link", "잇기", "mode-link"], ["song", "노래", "mode-song"]], mode, (m) => setMode(m), "boardMode");
  modes.classList.add("board-modes");
  frame.top.append(h("div", { class: "board-top" }, modes,
    h("div", { class: "song-top-left" },
      iconButton("board-zoom-out", "zoomOut", "작게 보기", () => zoomAt(1 / 1.25)),
      iconButton("board-zoom-in", "zoomIn", "크게 보기", () => zoomAt(1.25)))));

  const playButton = iconButton("board-play", "play", "순서대로 재생", () => togglePlay());
  const toolbar = h("div", { class: "toolbar board-tools", id: "board-tools" },
    playButton,
    iconButton("board-undo", "undo", "실행취소", () => step("undo")),
    iconButton("board-redo", "redo", "다시실행", () => step("redo")),
    iconButton("board-delete", "eraser", "고른 카드 지우기", () => removeSelected()));
  body.after(toolbar);

  const readOnly = () => !!session.transport.readOnly;
  const colorOf = (by) => { const m = session.room.member(by); return m ? memberColor(m.color, currentTheme()) : INK[currentTheme()]; };
  const settings = () => getSettings(app.store);
  /** A card's width on the board: song cards stretch with sx. */
  const widthOf = (item) => (item.kind === "song" ? item.w * sx : item.w);

  function setMode(m) {
    mode = m;
    linkFrom = null;
    cutting = false;
    closeExtra?.();
    draw();
  }

  // ---- drawing -------------------------------------------------------------------

  function place() {
    content.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    if (menu) placeMenu(false);
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
      el.style.left = item.x * sx + "px";
      el.style.top = item.y + "px";
      el.style.width = widthOf(item) + "px";
      el.style.setProperty("--c", colorOf(item.by));
      el.classList.toggle("chosen", item.id === selected);
      el.classList.toggle("link-from", item.id === linkFrom);
      el.classList.toggle("playing", item.id === playing);
      el.classList.toggle("muted", !!item.muted);
      el.classList.toggle("cut-ready", cutting && item.kind === "song");
      // The inside is built again only when what it shows changes; never for a stretch,
      // so a finger resting on a card keeps its touch through a pinch.
      const key = item.kind + "|" + (item.text ?? "") + "|" + order.indexOf(item.id) + "|" + !!item.muted;
      if (el.dataset.key !== key || el.shownData !== item.data) {
        el.dataset.key = key;
        el.shownData = item.data;
        el.replaceChildren(...cardInside(item, order.indexOf(item.id)));
      }
      if (item.kind === "song") nameNotes(el, item);
    }
    for (const el of [...content.querySelectorAll(".card")]) if (!keep.has(el.dataset.id)) el.remove();
    drawLines();
    drawRail();
    placeMenu(true);
    hint.textContent = hintText(items);
    hint.hidden = !hint.textContent;
    toolbar.querySelector("#board-undo").disabled = !undo.canUndo;
    toolbar.querySelector("#board-redo").disabled = !undo.canRedo;
    toolbar.querySelector("#board-delete").disabled = !selected || readOnly();
    playButton.replaceChildren(icon(player?.playing ? "pause" : "play"));
    for (const b of modes.children) b.setAttribute("aria-pressed", String(b.dataset.value === mode));
  }

  function hintText(items) {
    if (cutting) return "자를 곳을 노래 카드 위에서 누르세요";
    if (!items.length) return mode === "song" ? "오른쪽 '내 노래'나 '소리 넣기'로 노래 카드를 놓아 보세요." : "오른쪽 아이콘으로 글이나 노래 카드를 놓아 보세요. 노래 방에서 '보내기'로 보낼 수도 있어요.";
    if (mode === "link") return linkFrom ? "다음에 올 카드를 누르세요. 번호를 누르면 그 줄이 지워져요." : "먼저 재생할 카드부터 차례로 누르세요.";
    return "";
  }

  function cardInside(item, place) {
    if (item.kind === "note") return [h("p", { class: "card-text", text: item.text || "빈 메모" })];
    const d = item.data;
    return [
      h("div", { class: "card-head" },
        place >= 0 && h("span", { class: "card-order", text: String(place + 1) }),
        item.muted && h("span", { class: "card-muted", "aria-label": "음소거" }, icon("muted")),
        h("span", { class: "card-name", text: d.name || "노래" }),
        h("span", { class: "card-len", text: (d.dur / 1000).toFixed(1) + "초" })),
      noteBars(d, "card-notes"),
    ];
  }

  /** Note bars by pitch inside a box, as in the song room (also for 내 노래's previews). */
  function noteBars(d, cls) {
    const ps = d.notes.map((n) => n[2]);
    const lo = ps.length ? Math.min(...ps) : 60;
    const hi = ps.length ? Math.max(...ps) : 60;
    const span = Math.max(10, hi - lo + 2);
    return h("div", { class: cls }, d.notes.map((n) => h("i", {
      class: "note",
      data: { p: String(n[2]) },
      style: { left: (n[0] / d.dur) * 100 + "%", width: `max(3px, ${(n[1] / d.dur) * 100}%)`, top: `calc(${((hi + (span - (hi - lo)) / 2 - n[2]) / span) * 100}% - 0.4rem)`, height: "0.8rem" },
    })));
  }

  /** 도 레 미 on the bars wide enough for them (they change with a stretch; the bars stay). */
  function nameNotes(el, item) {
    const bars = el.querySelectorAll(".card-notes .note");
    const width = widthOf(item);
    item.data.notes.forEach((n, i) => {
      const text = (n[1] / item.data.dur) * width >= 16 ? solfege(n[2]) : "";
      if (bars[i] && bars[i].textContent !== text) bars[i].textContent = text;
    });
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
      const x1 = a.x * sx + widthOf(a);
      const y1 = a.y + ea.offsetHeight / 2;
      const x2 = b.x * sx;
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

  // ---- the tools on the right ------------------------------------------------------

  function railButton(id, iconName, label, onclick, { text, pressed } = {}) {
    const b = h("button", { class: "rail-btn", id, type: "button", "aria-label": label, title: label, onclick },
      text ? h("span", { class: "rail-text", text }) : icon(iconName),
      h("span", { class: "rail-cap", text: label }));
    if (pressed !== undefined) b.setAttribute("aria-pressed", String(pressed));
    return b;
  }

  function drawRail() {
    const s = settings();
    const can = !readOnly();
    const chosen = selected ? board.item(selected) : null;
    const song = chosen && !chosen.removed && chosen.kind === "song" ? chosen : null;
    const tools = {
      all: [
        can && railButton("add-note", null, "글", () => addNote(), { text: "+글" }),
        can && railButton("add-song", null, "붙이기", () => addSong(), { text: "+♪" }),
        can && railButton("my-songs", "library", "내 노래", () => openSongDrawer()),
      ],
      move: [railButton("board-fit", "fit", "모두 보기", () => fitAll())],
      link: [
        railButton("order-slots", "slots", "순서 칸", () => openSlots()),
        can && railButton("unlink-all", "eraser", "줄 지우기", () => unlinkAll()),
      ],
      song: [
        can && railButton("my-songs", "library", "내 노래", () => openSongDrawer()),
        can && railButton("board-add-sound", "upload", "소리 넣기", () => openAddSound()),
        railButton("stretch-in", "stretch", "늘이기", () => stretchAt(1.4)),
        railButton("stretch-out", "squeeze", "줄이기", () => stretchAt(1 / 1.4)),
        railButton("board-speed", null, "빠르기", () => nextSpeed(), { text: (s.songSpeed || 1) + "×" }),
        railButton("board-sound-mode", s.songMode === "original" ? "wave" : "note", s.songMode === "original" ? "원본" : "피아노", () => toggleSoundMode()),
      ],
    }[mode];
    rail.replaceChildren(...tools.filter(Boolean));
  }

  // ---- a card's menu: tap a card, act on it right there (as in the song room) ----------

  /** Builds (when asked) and places the chosen card's menu above the card, or below it near the top. */
  function placeMenu(build) {
    const item = selected ? board.item(selected) : null;
    const el = item && !item.removed && !cutting && mode !== "link" ? content.querySelector(`.card[data-id="${item.id}"]`) : null;
    if (!el) {
      menu?.remove();
      menu = null;
      return;
    }
    if (!menu) {
      menu = h("div", { class: "clip-menu card-menu", id: "card-menu", role: "toolbar", "aria-label": "카드 메뉴" });
      body.append(menu);
      build = true;
    }
    if (build) {
      const can = !readOnly();
      const one = (id, text, onclick) => h("button", { type: "button", id, text, onclick: (e) => { e.stopPropagation(); onclick(); } });
      menu.replaceChildren(...(item.kind === "song" ? [
        one("card-play", solo === item.id && player?.playing ? "■ 멈춤" : "▶ 듣기", () => playCard(item.id)),
        can && one("card-cut", "분할", () => { cutting = true; draw(); }),
        one("card-notes", "음 편집", () => editCardNotes(item.id)),
        can && one("card-mute", item.muted ? "소리 켜기" : "음소거", () => apply(setItemOps(session.clock, board, item.id, { muted: !item.muted }))),
        one("card-copy", "복사", () => copyCard(item.id)),
        can && one("card-delete", "지우기", () => removeSelected()),
      ] : [
        can && one("card-edit", "고치기", () => editNote(item.id)),
        can && one("card-delete", "지우기", () => removeSelected()),
      ]).filter(Boolean));
    }
    const area = body.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const w = menu.offsetWidth;
    const hgt = menu.offsetHeight;
    const left = Math.max(6, Math.min(area.width - w - 6, box.left - area.left + box.width / 2 - w / 2));
    let top = box.top - area.top - hgt - 8;
    if (top < 4) top = box.bottom - area.top + 8;
    menu.style.left = left + "px";
    menu.style.top = Math.max(4, Math.min(top, area.height - hgt - 4)) + "px";
  }

  // ---- looking around ----------------------------------------------------------------

  /** Board coordinates (before sx) under a point on screen. */
  const toBoard = (cx, cy) => {
    const r = surface.getBoundingClientRect();
    return { x: (cx - r.left - panX) / zoom / sx, y: (cy - r.top - panY) / zoom };
  };

  /** Keeps the board point under (cx, cy) where it is while zoom and sx change. */
  function keepUnder(cx, cy, at) {
    const r = surface.getBoundingClientRect();
    panX = cx - r.left - at.x * sx * zoom;
    panY = cy - r.top - at.y * zoom;
  }

  function zoomAt(f, cx, cy) {
    const r = surface.getBoundingClientRect();
    const ax = cx ?? r.left + r.width / 2;
    const ay = cy ?? r.top + r.height / 2;
    const at = toBoard(ax, ay);
    zoom = clamp(zoom * f, MIN_ZOOM, MAX_ZOOM);
    keepUnder(ax, ay, at);
    place();
  }

  /** 노래: song cards longer or shorter in time, around a point (the middle by default). */
  function stretchAt(f, cx) {
    const r = surface.getBoundingClientRect();
    const ax = cx ?? r.left + r.width / 2;
    const ay = r.top + r.height / 2;
    const at = toBoard(ax, ay);
    sx = clamp(sx * f, MIN_SX, MAX_SX);
    keepUnder(ax, ay, at);
    draw();
  }

  /** 이동: every card in view. */
  function fitAll() {
    const els = [...content.querySelectorAll(".card")];
    if (!els.length) return;
    const r = surface.getBoundingClientRect();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of els) {
      const x = parseFloat(el.style.left), y = parseFloat(el.style.top);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + el.offsetWidth); y1 = Math.max(y1, y + el.offsetHeight);
    }
    zoom = clamp(Math.min((r.width - 48) / Math.max(1, x1 - x0), (r.height - 64) / Math.max(1, y1 - y0)), MIN_ZOOM, MAX_ZOOM);
    panX = (r.width - (x1 - x0) * zoom) / 2 - x0 * zoom;
    panY = 24 - y0 * zoom;
    place();
  }

  /** Moves the view just enough to show a card that stands outside it. */
  function reveal(id) {
    const el = content.querySelector(`.card[data-id="${id}"]`);
    if (!el) return;
    const r = surface.getBoundingClientRect();
    const c = el.getBoundingClientRect();
    const right = r.right - rail.offsetWidth - 24;
    if (c.right > right) panX -= Math.min(c.right - right, c.left - r.left - 16);
    else if (c.left < r.left + 16) panX += r.left + 16 - c.left;
    if (c.bottom > r.bottom - 48) panY -= Math.min(c.bottom - (r.bottom - 48), c.top - r.top - 16);
    else if (c.top < r.top + 16) panY += r.top + 16 - c.top;
    place();
  }

  // ---- touch --------------------------------------------------------------------------

  // A second finger means zoom: a card the first finger was dragging goes back,
  // nothing is saved, and the lifts that end the pinch are no taps.
  let gesture = null;
  let pan = null;
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
      const at = (ev) => ({ x: start.ix + (ev.clientX - start.x) / (zoom * sx), y: start.iy + (ev.clientY - start.y) / zoom });
      const move = (ev) => {
        if (!mine(ev)) return;
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4 * zoom) start.moved = true;
        if (linking || readOnly() || !start.moved) return;
        const p = at(ev);
        el.style.left = p.x * sx + "px";
        el.style.top = p.y + "px";
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
        if (start.moved && !readOnly()) return void apply(setItemOps(session.clock, board, id, at(ev)));
        if (cutting && item.kind === "song" && !readOnly()) return void cutAt(id, el, ev.clientX);
        if (selected === id && mode === "all" && item.kind === "note") return void editNote(id);
        selected = id;
        draw();
      };
      const cancel = (ev) => {
        if (ev && !mine(ev)) return;
        stop();
        el.style.left = start.ix * sx + "px";
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
      cutting = false;
      draw();
    }
    pan = null;
  });

  // Two fingers. In 노래, as in the song room: sideways stretches the songs in time,
  // up and down zooms. Elsewhere they zoom the board.
  let pinch = null;
  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const middle = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
  surface.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 2) return;
    const [mx, my] = middle(e.touches);
    pinch = {
      d: spread(e.touches), dx: Math.abs(e.touches[0].clientX - e.touches[1].clientX), dy: Math.abs(e.touches[0].clientY - e.touches[1].clientY),
      zoom, sx, at: toBoard(mx, my),
    };
    pan = null;
  }, { passive: true });
  surface.addEventListener("touchmove", (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [mx, my] = middle(e.touches);
    if (mode === "song") {
      const dx = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
      const dy = Math.abs(e.touches[0].clientY - e.touches[1].clientY);
      if (pinch.dx > 40) sx = clamp(pinch.sx * (dx / pinch.dx), MIN_SX, MAX_SX);
      if (pinch.dy > 40) zoom = clamp(pinch.zoom * (dy / pinch.dy), MIN_ZOOM, MAX_ZOOM);
      keepUnder(mx, my, pinch.at);
      draw();
    } else {
      zoom = clamp(pinch.zoom * (spread(e.touches) / pinch.d), MIN_ZOOM, MAX_ZOOM);
      keepUnder(mx, my, pinch.at);
      place();
    }
  }, { passive: false });
  surface.addEventListener("touchend", (e) => { if (e.touches.length < 2) pinch = null; });
  // A computer's wheel: zoom (in 노래, stretch in time; Alt zooms there); Shift moves sideways.
  surface.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.shiftKey) { panX -= e.deltaY; place(); return; }
    const f = Math.exp(-e.deltaY / 400);
    if (mode === "song" && !e.altKey) stretchAt(f, e.clientX);
    else zoomAt(f, e.clientX, e.clientY);
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

  /**
   * Where a new card goes: the first free spot in view, row by row, clear of the
   * other cards and of the tools on the right; when the view is full, right of the
   * rightmost card.
   */
  function spotFor(kind, data) {
    const r = surface.getBoundingClientRect();
    const from = toBoard(r.left + 16, r.top + 16);
    const to = toBoard(r.right - rail.offsetWidth - 28, r.bottom - 56);
    const w = kind === "song" ? songWidth(data.dur) : 200 / sx;
    const tall = kind === "song" ? 100 : 84;
    const boxes = [...content.querySelectorAll(".card")].map((el) => {
      const it = board.item(el.dataset.id);
      return it && { x: it.x, y: it.y, w: el.offsetWidth / sx, h: el.offsetHeight };
    }).filter(Boolean);
    const gapX = 20 / sx;
    const free = (x, y) => boxes.every((o) => x + w + gapX <= o.x || x >= o.x + o.w + gapX || y + tall + 16 <= o.y || y >= o.y + o.h + 16);
    for (let y = from.y; y === from.y || y + tall <= to.y; y += tall + 16) {
      for (let x = from.x; x === from.x || x + w <= to.x; x += w + gapX) if (free(x, y)) return { x, y, seen: true };
    }
    return { ...freeSpot(), seen: false };
  }

  /** Right of the rightmost card. */
  function freeSpot() {
    const items = board.items();
    if (!items.length) {
      const r = surface.getBoundingClientRect();
      return toBoard(r.left + 30, r.top + 30);
    }
    const right = items.reduce((a, b) => (b.x * sx + widthOf(b) > a.x * sx + widthOf(a) ? b : a));
    return { x: (right.x * sx + widthOf(right) + 60) / sx, y: right.y };
  }

  function placeCard(data) {
    if (readOnly()) return null;
    const at = spotFor("song", data);
    const made = addItemOps(session.clock, board, { kind: "song", x: at.x, y: at.y, data, by: session.memberId });
    apply(made);
    selected = made.id;
    draw();
    if (!at.seen) reveal(made.id);
    return made.id;
  }

  function addNote() {
    if (readOnly()) return;
    const at = spotFor("note");
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
    const item = clipboardItem(app.store, "song-clip");
    if (!item) return void toast(root, "노래 방에서 클립을 '복사'하면 여기에 붙일 수 있어요. '내 노래'에서 골라도 돼요.", 4200);
    placeCard(cardFromClip(item));
  }

  function removeSelected() {
    if (!selected || readOnly()) return;
    apply(removeItemOps(session.clock, board, selected));
    selected = null;
    draw();
  }

  function cutAt(id, el, clientX) {
    const item = board.item(id);
    const r = el.getBoundingClientRect();
    const made = splitCardOps(session.clock, board, id, ((clientX - r.left) / r.width) * item.data.dur, session.memberId);
    cutting = false;
    if (!made.ops.length) {
      toast(root, "끝에 너무 가까워서 자를 수 없어요");
      return void draw();
    }
    apply(made);
    selected = made.ids[0];
    draw();
  }

  function copyCard(id) {
    const d = board.item(id)?.data;
    if (!d) return;
    copyItem(app.store, {
      kind: "song-clip", room: session.roomId, src: id, offset: 0, length: d.dur,
      source: { duration: d.dur / 1000, notes: d.notes.map(([t, len, p, v]) => ({ t: t / 1000, d: len / 1000, p, v: v / 100 })), peaks: d.peaks, blob: d.blob, name: d.name },
    });
    toast(root, "복사했어요. 노래 방이나 다른 화이트보드에 붙일 수 있어요", 2600);
  }

  /** 음 편집 for a song card: the piano roll over a one-card song; each edit sets the card's notes. */
  function editCardNotes(id) {
    const item = board.item(id);
    if (!item || item.kind !== "song") return;
    const d = item.data;
    const temp = new SongDoc();
    const clock = new Clock("edit");
    const src = { t: "src", id: clock.next(), dur: d.dur, notes: d.notes, peaks: d.peaks || "", by: item.by, at: 0 };
    const clip = { t: "clip", id: clock.next(), src: src.id, row: 0, start: 0, offset: 0, length: d.dur, by: item.by, at: 0 };
    temp.apply(src);
    temp.apply(clip);
    editor?.close();
    editor = openNoteEditor(root, {
      song: temp, clipId: clip.id, clock,
      commit: (made) => {
        for (const op of made.ops) temp.apply(op);
        const notes = temp.notesOf(src.id).map((n) => [Math.round(n.t), Math.max(1, Math.round(n.d)), n.p, Math.round(Math.min(1, Math.max(0, n.v)) * 100)]);
        const now = board.item(id);
        if (now) apply(setItemOps(session.clock, board, id, { data: { ...now.data, notes } }));
      },
      preview: (p, seconds) => preview(p, seconds),
      canEdit: () => !readOnly(),
      color: colorOf(item.by),
    });
  }

  function nextSpeed() {
    const now = settings().songSpeed || 1;
    const speed = SPEEDS[(SPEEDS.indexOf(now) + 1) % SPEEDS.length];
    setSetting(app.store, "songSpeed", speed);
    player?.setSpeed(speed);
    draw();
  }

  function toggleSoundMode() {
    const next = settings().songMode === "original" ? "piano" : "original";
    setSetting(app.store, "songMode", next);
    player?.setMode(next);
    draw();
  }

  // ---- 잇기: order slots --------------------------------------------------------------

  function unlinkAll() {
    const made = { ops: [], atoms: [] };
    for (const l of board.links()) {
      const one = unlinkOps(session.clock, board, l.id);
      made.ops.push(...one.ops);
      made.atoms.push(...one.atoms);
    }
    apply(made);
  }

  /** Slots 1, 2, 3…: keep the lines as they are now, or bring a kept order back. */
  function openSlots() {
    closeExtra?.();
    const menu = h("div", { class: "slot-menu", id: "slot-menu", role: "dialog", "aria-label": "순서 칸" });
    const anchor = rail.querySelector("#order-slots");
    let count = Math.max(SLOTS_SHOWN, ...board.slots().map((s) => s.n));
    const paint = () => {
      const saved = new Map(board.slots().map((s) => [s.n, s]));
      const now = JSON.stringify(board.links().map((l) => [l.a, l.b]));
      menu.replaceChildren(
        h("p", { class: "slot-title", text: "순서 칸" }),
        ...Array.from({ length: count }, (_, i) => {
          const n = i + 1;
          const s = saved.get(n);
          return h("div", { class: "slot-row" + (s && JSON.stringify(s.pairs) === now ? " current" : "") },
            h("span", { class: "slot-n", text: String(n) }),
            h("span", { class: "slot-what", text: s ? `줄 ${s.pairs.length}개` : "비어 있음" }),
            s && h("button", { type: "button", class: "chip", id: "slot-use-" + n, text: "불러오기", onclick: () => { apply(useSlotOps(session.clock, board, n, session.memberId)); close(); } }),
            !readOnly() && h("button", { type: "button", class: "chip", id: "slot-save-" + n, text: "저장", onclick: () => { apply(saveSlotOps(session.clock, board, n, session.memberId)); draw(); paint(); toast(root, n + "번 칸에 지금 순서를 담았어요"); } }));
        }),
        count < 9 && h("button", { type: "button", class: "chip slot-more", id: "slot-more", text: "+ 칸", onclick: () => { count++; paint(); } }));
    };
    paint();
    const top = anchor ? anchor.getBoundingClientRect().top - body.getBoundingClientRect().top : 8;
    menu.style.top = Math.max(8, top) + "px";
    body.append(menu);
    const away = (e) => { if (!menu.contains(e.target) && e.target !== anchor && !anchor?.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
    let open = true;
    function close() {
      if (!open) return;
      open = false;
      menu.remove();
      document.removeEventListener("pointerdown", away, true);
      if (closeExtra === close) closeExtra = null;
    }
    closeExtra = close;
  }

  // ---- 내 노래: my song rooms' clips, from the right ----------------------------------

  async function songsOf(room) {
    const transport = await app.transportFor(room.id);
    const other = new RoomSession({ transport, roomId: room.id, store: app.store });
    try {
      if ((await other.open()) !== "ok") return null;
      const song = await other.load("song");
      return song.layout().map((clip, i) => {
        const src = song.source(clip.src);
        const source = { duration: src.dur / 1000, notes: song.notesOf(src.id).map((n) => ({ t: n.t / 1000, d: n.d / 1000, p: n.p, v: n.v })), peaks: src.peaks, blob: src.blob, name: src.name };
        return { data: cardFromClip({ source, offset: clip.offset, length: clip.length }), label: src.name || "녹음 " + (i + 1) };
      });
    } finally {
      other.close();
    }
  }

  function openSongDrawer() {
    closeExtra?.();
    const list = h("div", { class: "drawer-list" });
    const panel = h("aside", { class: "drawer", id: "song-drawer", role: "dialog", "aria-label": "내 노래" },
      h("div", { class: "drawer-head" }, h("h2", { class: "drawer-title", text: "내 노래" }),
        h("button", { class: "icon-btn", id: "drawer-close", type: "button", "aria-label": "닫기", onclick: () => close() }, icon("back"))),
      h("p", { class: "help drawer-note", text: "누르면 화이트보드에 놓여요." }),
      list);
    const scrim = h("div", { class: "drawer-scrim", onclick: () => close() });
    root.append(scrim, panel);
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    let open = true;
    function close() {
      if (!open) return;
      open = false;
      scrim.remove();
      panel.remove();
      document.removeEventListener("keydown", onKey);
      if (closeExtra === close) closeExtra = null;
    }
    closeExtra = close;
    const pick = (data, label) => h("button", { type: "button", class: "song-pick", onclick: () => { close(); placeCard(data); } },
      h("span", { class: "pick-head" }, h("span", { class: "pick-name", text: label }), h("span", { class: "pick-len", text: (data.dur / 1000).toFixed(1) + "초" })),
      noteBars(data, "pick-notes"));
    const copied = clipboardItem(app.store, "song-clip");
    if (copied) list.append(h("div", { class: "drawer-section" }, h("p", { class: "drawer-group", text: "복사한 클립" }), pick(cardFromClip(copied), copied.source?.name || "복사한 클립")));
    const rooms = app.store.get("rooms", []).filter((r) => r.kind === "creative-song").sort((a, b) => b.at - a.at);
    if (!rooms.length && !copied) list.append(h("p", { class: "help", text: "아직 노래 방이 없어요. 오른쪽 '소리 넣기'로 여기에 바로 넣어도 돼요." }));
    (async () => {
      for (const room of rooms) {
        const wait = h("p", { class: "help", text: "불러오는 중…" });
        const box = h("div", { class: "drawer-section" }, h("p", { class: "drawer-room", text: room.name }), wait);
        list.append(box);
        const found = await songsOf(room).catch(() => null);
        if (!open) return;
        wait.replaceWith(found === null ? h("p", { class: "help", text: "이 방을 열지 못했어요" })
          : found.length ? h("div", { class: "drawer-picks" }, found.map(({ data, label }) => pick(data, label)))
            : h("p", { class: "help", text: "아직 소리가 없어요" }));
      }
    })();
  }

  // ---- 소리 넣기: record or import straight onto the board ---------------------------------

  function openAddSound() {
    if (readOnly() || busy) return;
    closeExtra?.();
    const close = openSheet(root, "소리 넣기", (panel, closeSheet, onClose) => {
      panel.append(h("div", { class: "form", id: "board-add" },
        ...waysIn({ app, roomId: session.roomId, root, name: "board", prefix: "board-add-", mic, canRecord: !readOnly(), onRecord: () => { closeSheet(); startRecording(); } })));
      onClose(() => { if (closeExtra === close) closeExtra = null; });
    });
    closeExtra = close;
  }

  function showStatus(text) {
    status.textContent = text || "";
    status.hidden = !text;
  }

  async function importFile(file) {
    if (busy || readOnly()) return;
    busy = "import";
    showStatus("소리를 읽는 중…");
    try {
      const ctx = await audioContext({ wake: false });
      if (!ctx) throw new Error("no audio");
      let { samples, rate } = await decodeAudioFile(ctx, file);
      if (samples.length > (rate * MAX_TAKE_MS) / 1000) samples = samples.subarray(0, Math.round((rate * MAX_TAKE_MS) / 1000));
      await analyzeAndPlace(samples, rate, file.name);
    } catch (err) {
      console.warn(err);
      toast(root, "이 파일은 읽을 수 없어요", 3600);
    } finally {
      busy = null;
      showStatus(null);
    }
  }

  async function startRecording() {
    if (busy || readOnly() || !mic.ok) return;
    const ctx = await audioContext();
    if (!ctx) return;
    const recorder = new MicRecorder(ctx);
    try {
      await recorder.start();
    } catch (err) {
      return void toast(root, micProblem(err), 3600);
    }
    busy = "record";
    let timer = 0;
    const close = openSheet(root, "녹음 중", (panel, closeSheet, onClose) => {
      const time = h("p", { class: "rec-time", id: "board-rec-time", text: "0:00.0" });
      panel.append(h("div", { class: "form" }, time,
        h("button", { class: "btn", id: "board-rec-stop", type: "button", text: "멈추고 화이트보드에 놓기", onclick: () => closeSheet() })));
      timer = setInterval(() => {
        time.textContent = timeText(recorder.seconds * 1000);
        if (recorder.seconds * 1000 >= MAX_TAKE_MS) closeSheet();
      }, 200);
      onClose(async () => {
        clearInterval(timer);
        if (closeExtra === close) closeExtra = null;
        const take = await recorder.stop();
        busy = null;
        if (take.samples.length < take.rate * 0.25) return void toast(root, "녹음이 너무 짧아요");
        busy = "import";
        showStatus("음을 찾는 중…");
        try {
          await analyzeAndPlace(take.samples, take.rate, null);
        } finally {
          busy = null;
          showStatus(null);
        }
      });
    });
    closeExtra = close;
  }

  /** Notes from the sound; the recording kept on this device; a song card on the board. */
  async function analyzeAndPlace(samples, rate, name) {
    const result = await analyzeSamples(samples, rate, { onProgress: (p) => showStatus(`음을 찾는 중… ${Math.round(p * 100)}%`) });
    const kept = rate === KEEP_RATE ? samples : resample(samples, rate, KEEP_RATE);
    const blob = newBlobId();
    await app.blobs.put(blob, encodeWav(kept, KEEP_RATE), "audio/wav");
    placeCard(songCardData({ duration: result.duration, notes: result.notes, peaks: toBase64(result.peaks), name: name || undefined, blob }));
    if (!result.notes.length) toast(root, "음을 찾지 못했어요. 원본으로 들을 수 있어요", 3600);
  }

  // ---- playing ----------------------------------------------------------------------

  async function makePlayer(song, audio) {
    const ctx = await audioContext();
    if (!ctx) return null;
    player?.close();
    const s = settings();
    player = new SongPlayer(ctx, { song: () => song, audioFor: (id) => audio.get(id) || null, onEnd: () => { playing = null; solo = null; draw(); } });
    player.setMode(s.songMode);
    player.setTone(s.pianoTone);
    player.setSpeed(s.songSpeed || 1);
    return player;
  }

  async function preview(p, seconds) {
    if (!player) await makePlayer(new SongDoc(), new Map());
    player?.preview(p, seconds);
  }

  /** This device's recordings for the song's sounds, for 원본. */
  async function recordingsOf(song, ctx) {
    const audio = new Map();
    for (const src of song.sources.values()) {
      if (!src.blob) continue;
      const kept = await app.blobs.get(src.blob);
      const wav = kept && decodeWav(kept.data);
      if (wav) audio.set(src.id, bufferFromSamples(ctx, toMono(wav.channels), wav.rate));
    }
    return audio;
  }

  function stopPlaying() {
    player?.stop();
    playing = null;
    solo = null;
    cancelAnimationFrame(frameReq);
    for (const line of content.querySelectorAll(".card-line")) line.remove();
    draw();
  }

  /**
   * Shows what sounds: the card glows and a line runs through its notes.
   * ends: [[card id, end ms on the song]] in playing order.
   */
  function follow(ends) {
    const tick = () => {
      if (!alive || !player?.playing) {
        for (const line of content.querySelectorAll(".card-line")) line.remove();
        return;
      }
      const pos = player.position;
      let from = 0;
      for (const [id, end] of ends) {
        if (pos < end) {
          if (id !== playing) {
            for (const line of content.querySelectorAll(".card-line")) line.remove();
            playing = id;
            draw();
          }
          const notes = content.querySelector(`.card[data-id="${id}"] .card-notes`);
          if (notes) {
            let line = notes.querySelector(".card-line");
            if (!line) notes.append(line = h("i", { class: "card-line", "aria-hidden": "true" }));
            line.style.left = Math.min(100, ((pos - from) / (end - from)) * 100) + "%";
          }
          break;
        }
        from = end;
      }
      frameReq = requestAnimationFrame(tick);
    };
    frameReq = requestAnimationFrame(tick);
  }

  /** ▶ in the toolbar: every song card in order. */
  async function togglePlay() {
    if (player?.playing) return stopPlaying();
    const order = playOrder(board);
    if (!order.length) return void toast(root, "재생할 노래 카드가 없어요");
    const ctx = await audioContext();
    if (!ctx) return;
    const song = boardSong(board);
    if (!(await makePlayer(song, await recordingsOf(song, ctx)))) return;
    player.play(0);
    const ends = [];
    let at = 0;
    for (const card of order) ends.push([card.id, (at += card.data.dur)]);
    follow(ends);
    draw();
  }

  /** ▶ 듣기 in a card's menu: just that card. Again stops it. */
  async function playCard(id) {
    if (player?.playing) {
      const was = solo;
      stopPlaying();
      if (was === id) return;
    }
    const card = board.item(id);
    if (!card || card.kind !== "song") return;
    const ctx = await audioContext();
    if (!ctx) return;
    const song = cardsSong([card]);
    if (!(await makePlayer(song, await recordingsOf(song, ctx)))) return;
    solo = id;
    player.play(0);
    follow([[id, card.data.dur]]);
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
      const at = spotFor("note");
      apply(addItemOps(session.clock, board, { kind: "note", x: at.x, y: at.y, data: { text }, by: session.memberId }));
    },
    close() {
      alive = false;
      cancelAnimationFrame(frameReq);
      closeExtra?.();
      menu?.remove();
      editor?.close();
      stopPickers();
      fingers.stop();
      player?.close();
      for (const off of offs) off();
      toolbar.remove();
      frame.top.replaceChildren();
      body.classList.remove("board-body");
    },
  };
}
