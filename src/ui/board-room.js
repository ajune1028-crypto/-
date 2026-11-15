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
// first card stands, other cards from the leftmost. 올가미 (its own mode, next to 노래):
// a loop drawn round some cards stays on the board; its ▶ plays only the cards inside,
// a drag inside it moves it with its cards, its chip drags just the loop, ✕ takes it
// off, and it closes itself the shortest way when the end does not reach the start.

import { h, icon, iconButton, segmented, openSheet, toast, closeOnOutside, swallowPress } from "./dom.js";
import { watchFingers } from "./fingers.js";
import { currentTheme, onThemeChange } from "./theme.js";
import { openNoteEditor } from "./note-editor.js";
import { timeText } from "./song-view.js";
import { SPEEDS } from "./song-room.js";
import { KEEP_RATE, soundPickers, waysIn, pickerHelp, micRefused } from "./sound-in.js";
import { shrinkPhoto } from "./photo.js";
import { watchPickers } from "./picker-watch.js";
import { memberColor, INK, contrast, PALETTE } from "../core/paint.js";
import { UndoStack } from "../core/undo.js";
import { Clock } from "../core/crdt.js";
import { SongDoc, MAX_TAKE_MS, CLIP_SPEEDS } from "../core/song.js";
import {
  addItemOps, setItemOps, removeItemOps, linkOps, unlinkOps, invertBoardOps, playOrder, boardSong, cardsSong,
  cardFromClip, songCardData, splitCardOps, saveSlotOps, useSlotOps, songWidth, keepOf, keptFields, slotOrder, orderOps, nameSlotOps,
  lassoOps, moveLassoOps, removeLassoOps, lassoOrder, orderColor, MAX_PHOTO_CHARS, itemsInLoop, insideLoop,
  tintLassoOps, rowLayout, boxLoop, strokesInLoop,
} from "../core/board.js";
import { INK_COLORS, strokeOps, eraseOps, invertInkOps, moveStrokesOps, recolorStrokesOps } from "../core/ink.js";
import { InkLayer, inkColor, drawInkTools } from "./ink.js";
import { addRefNote, addRefSound } from "../reference.js";
import { clipboardItem, copyItem } from "../clipboard.js";
import { solfege } from "../audio/notes.js";
import { audioContext, SongPlayer } from "../audio/engine.js";
import { decodeWav, encodeWav } from "../audio/wav.js";
import { toMono, resample, louder } from "../audio/dsp.js";
import { keepTake, takeWhere } from "./keep-take.js";
import { soundTitle } from "./names.js";
import { buzz as buzzOnce } from "./chime.js";
import { reachableRooms, putCardsIntoSong } from "./room-actions.js";
import { bufferFromSamples, decodeAudioFile } from "../audio/decode.js";
import { analyzeSamples } from "../audio/analyze.js";
import { MicRecorder, micSupport, micProblem } from "../audio/recorder.js";
import { toBase64 } from "../audio/peaks.js";
import { newBlobId } from "../sync/blobs.js";
import { RoomSession } from "../sync/session.js";
import { getSettings, setSetting } from "../identity.js";

const SVG = "http://www.w3.org/2000/svg";
// Far out to see a big board whole, near in to draw small (the owner: "축소를 완전 많이").
const MIN_ZOOM = 0.04;
const MAX_ZOOM = 5;
const SLOTS_SHOWN = 5;
const LINE_STYLES = { rainbow: "무지개", pastel: "파스텔", mine: "내 색" };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function mountBoardRoom(body, app, session, frame) {
  const board = session.doc("board");
  const root = app.root;
  const undo = new UndoStack(100, 0);
  const mic = micSupport();
  let zoom = 1;
  let panX = 24;
  let panY = 24;
  let sx = 1; // 노래: song cards (and where cards stand) stretched sideways in time; 1 in every other mode
  let cursor = null; // { id, ms }: where the chosen song card was tapped again (its position line)
  let mode = "all";
  let selected = null;
  let writer = null; // words being written in place: { id, ta, el, fresh, before, made, timer, stop }
  let boardInk = null; // 그리기: the drawings' layer (made once the board is in place)
  let inkQueued = false;
  let linkFrom = null;
  let cutting = false; // 분할: the next tap on a song card cuts it there
  const lassoing = () => mode === "lasso"; // 올가미 (its own mode): one finger draws loops
  let soloLasso = null; // the loop whose cards are playing
  const repeating = new Set(); // loops whose ▶ goes round again (반복; this device)
  // What a loop's actions take (the owner: "곡, 텍스트, 그림, 전체"): "all", "song", "note" (글) or
  // "draw" (그림: drawings and photos); this device, 전체 at first.
  const loopKinds = new Map();
  let focusLoop = null; // the loop last used: in 노래 only its part is played and worked on
  let focusOff = false; // 노래's 올가미 부분만 turned off
  let loopDrag = null; // a loop being dragged by its chip: { id, dx, dy } on the board
  let chipDragged = false;
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
  // 올가미 loops lie under the cards (the cards inside stay tappable).
  const loops = document.createElementNS(SVG, "svg");
  loops.setAttribute("class", "board-loops");
  const loopGroup = document.createElementNS(SVG, "g");
  loops.append(loopGroup);
  const content = h("div", { class: "board-content", id: "board-content" }, loops, lines);
  const surface = h("div", { class: "board", id: "board" }, content);
  // A pen or a long press on the board never starts a text selection or the phone's menu
  // (they broke strokes on an iPad); the words being written keep theirs.
  const ownText = (t) => !!t?.closest?.("textarea, input, [contenteditable='true']");
  surface.addEventListener("selectstart", (e) => { if (!ownText(e.target)) e.preventDefault(); });
  surface.addEventListener("contextmenu", (e) => { if (!ownText(e.target)) e.preventDefault(); });
  const rail = h("div", { class: "board-rail", id: "board-rail" });
  const hint = h("p", { class: "board-hint", id: "board-hint" });
  const status = h("p", { class: "board-status", id: "board-status", role: "status", hidden: true });
  body.append(surface, rail, hint, status);

  const { inputs: pickers, stop: stopPickers } = soundPickers("board", {
    onFile: (file) => { closeExtra?.(); importFile(file); },
    onSilent: () => { if (alive) { closeExtra?.(); pickerHelp({ app, roomId: session.roomId, root, mic }); } },
  });
  body.append(...pickers);
  // 사진: a picture card, picked by a label as every picker is.
  const photoInput = h("input", { type: "file", accept: "image/*", id: "board-photo-file", class: "vh", tabindex: "-1" });
  body.append(photoInput);
  photoInput.addEventListener("change", async () => {
    const file = photoInput.files?.[0];
    photoInput.value = "";
    if (!file || readOnly()) return;
    const photo = await shrinkPhoto(file, MAX_PHOTO_CHARS).catch(() => null);
    if (!photo) return void toast(root, "이 사진은 읽을 수 없어요", 3200);
    placePhoto(photo);
  });
  const stopPhotoWatch = watchPickers([photoInput], () => { if (alive) toast(root, "사진 고르는 창이 열리지 않았어요. Claude 앱이라면 크롬에서 같은 방을 열어 주세요.", 4200); });

  // The big modes on top: the owner's 전체·이동·글쓰기·잇기·노래, and 올가미 beside 노래. Each mode's
  // small tools stand on the right. Zoom is two fingers or the wheel, and 이동's tools.
  // The bar can stand on any edge (a long press lifts it; let go near an edge), and is set up as one
  // likes: order, which modes show, size, words or icons; the tools on the right move with it (the
  // owner: "꾹 누르고서… 위 아래 오른쪽 왼쪽 어디든", "커스텀 기능"). All of it per device.
  const MODE_LIST = [["all", "전체", "mode-all", "board"], ["move", "이동", "mode-move", "fit"], ["write", "글쓰기", "mode-write", "textSize"], ["link", "잇기", "mode-link", "lines"], ["song", "노래", "mode-song", "note"], ["lasso", "올가미", "mode-lasso", "lasso"]];
  const barLook = () => {
    const s = settings();
    const order = Array.isArray(s.boardModesOrder) ? s.boardModesOrder.filter((k) => MODE_LIST.some(([m]) => m === k)) : [];
    for (const [m] of MODE_LIST) if (!order.includes(m)) order.push(m);
    const hidden = new Set((Array.isArray(s.boardModesHidden) ? s.boardModesHidden : []).filter((k) => k !== "all"));
    return { order, hidden, at: ["top", "bottom", "left", "right"].includes(s.boardModesAt) ? s.boardModesAt : "top", size: [1, 2, 3].includes(s.boardBarSize) ? s.boardBarSize : 2, icons: !!s.boardModesIcons, rail: ["auto", "left", "right"].includes(s.boardRailAt) ? s.boardRailAt : "auto" };
  };
  const boardTop = h("div", { class: "board-top" });
  let modes = null;
  function buildModes() {
    const look = barLook();
    const list = look.order.filter((k) => !look.hidden.has(k)).map((k) => MODE_LIST.find(([m]) => m === k));
    modes = segmented(list.map(([m, name, id]) => [m, name, id]), mode, (m) => setMode(m), "boardMode");
    modes.classList.add("board-modes");
    if (look.icons) for (const b of modes.children) {
      const [, name, , iconName] = MODE_LIST.find(([m]) => m === b.dataset.value);
      b.replaceChildren(icon(iconName));
      b.setAttribute("aria-label", name);
      b.title = name;
    }
    wireBarMove(modes);
    boardTop.replaceChildren(modes);
    const room = body.closest(".room") || roomShell();
    if (room) {
      room.dataset.modesAt = look.at;
      room.dataset.barSize = String(look.size);
      room.dataset.modesIcons = String(look.icons);
      room.dataset.railAt = look.rail === "auto" ? (look.at === "right" ? "left" : "right") : look.rail;
    }
  }
  const roomShell = () => frame.top.closest?.(".room");
  frame.top.append(boardTop);

  const playButton = iconButton("board-play", "play", "전체 재생 (왼쪽부터, 잇기 순서대로)", () => togglePlay(), "전체 재생");
  const penButton = iconButton("board-pen", "pen", "그리기", () => setPen(pen.tool ? null : "pen"), "그리기");
  penButton.setAttribute("aria-pressed", "false"); // off reads as off, as in the text room
  const toolbar = h("div", { class: "toolbar board-tools", id: "board-tools" },
    playButton,
    penButton,
    iconButton("board-undo", "undo", "실행취소", () => step("undo"), "되돌리기"),
    iconButton("board-redo", "redo", "다시실행", () => step("redo"), "다시하기"),
    iconButton("board-delete", "eraser", "고른 카드 지우기", () => removeSelected(), "지우기"));
  body.after(toolbar);

  // The board runs under the bars to every edge of the screen (the owner: "엄청 크게… 무한적으로");
  // the bars float over it. The room body stays the part in view: new cards, 모두 보기, menus,
  // loop chips and the tools keep to it. insets: how far the board reaches past it, up and down.
  const roomEl = body.closest(".room");
  let insets = { top: 0, bottom: 0 };
  function measureInsets() {
    if (!alive || !roomEl) return;
    const room = roomEl.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    const next = { top: Math.max(0, Math.round(b.top - room.top)), bottom: Math.max(0, Math.round(room.bottom - b.bottom)) };
    if (next.top === insets.top && next.bottom === insets.bottom) return;
    // What was in view stays where it was on screen.
    panY += next.top - insets.top;
    insets = next;
    roomEl.style.setProperty("--top-inset", next.top + "px");
    roomEl.style.setProperty("--bottom-inset", next.bottom + "px");
    place();
  }
  const insetWatch = new ResizeObserver(() => measureInsets());
  insetWatch.observe(body);
  if (roomEl) insetWatch.observe(roomEl);

  // ---- 그리기 (the owner: "브러쉬도 있고 필기도 가능하고"; 전체 is "다 할 수 있는" mode) ------
  // The text room's brushes, drawn on the board itself in its own frame (they pan, zoom and
  // stretch with it) on a screen-sized canvas beneath the cards: drawings never cover what is
  // written or sung. While the pen is on, one finger draws and two fingers zoom.
  const INK_DOC = "k:board";
  const INK_UNIT = 100 / 16; // stroke units per board pixel (as on a sheet: hundredths of a 16 px rem)
  const pen = { tool: null, color: "black", width: 2, brush: getSettings(app.store).inkBrush || "pen" };
  const inkTools = h("div", { class: "ink-tools", id: "board-ink-tools", hidden: true, role: "toolbar", "aria-label": "그리기 도구" });
  toolbar.before(inkTools);
  boardInk = new InkLayer({
    host: surface,
    ink: () => session.doc(INK_DOC),
    blocked: () => fingers.pinching,
    view: {
      point: (cx, cy) => { const p = toBoard(cx, cy); return [p.x * INK_UNIT, p.y * INK_UNIT]; },
      matrix: () => [(zoom * sx) / INK_UNIT, 0, 0, zoom / INK_UNIT, panX, panY],
    },
    onStroke: ({ pts, color, width, brush }) => {
      const made = strokeOps(session.clock, session.doc(INK_DOC), { pts, color, width, brush, by: session.memberId });
      session.commit(INK_DOC, made.ops);
      record(made.atoms.map((atom) => ({ ...atom, doc: INK_DOC })));
    },
    onErase: (id) => {
      const made = eraseOps(session.clock, session.doc(INK_DOC), id);
      session.commit(INK_DOC, made.ops);
      record(made.atoms.map((atom) => ({ ...atom, doc: INK_DOC })));
    },
  });
  surface.prepend(boardInk.canvas);
  // While the pen is on the board, the bars and tools step back (the owner chose "그릴 때 막대 옅어지기").
  const inkingNow = (on) => body.closest(".room")?.classList.toggle("inking-now", on);
  boardInk.canvas.addEventListener("pointerdown", () => { if (pen.tool) inkingNow(true); });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) boardInk.canvas.addEventListener(type, () => inkingNow(false));

  /** 그리기 on or off (null). The pen belongs to 전체: turning it on there from any mode. */
  function setPen(tool) {
    if (tool && mode !== "all") setMode("all");
    pen.tool = tool;
    boardInk.setTool(tool);
    boardInk.setStyle(pen);
    drawInkTools(inkTools, { pen, setTool: setPen, store: app.store });
    penButton.setAttribute("aria-pressed", String(!!tool));
    if (tool) {
      finishWriting();
      closeExtra?.();
      if (selected) {
        selected = null;
        draw();
      }
    }
    inkSoon();
  }

  function inkSoon() {
    if (!boardInk || inkQueued) return;
    inkQueued = true;
    requestAnimationFrame(() => {
      inkQueued = false;
      if (alive) boardInk?.render();
    });
  }

  const readOnly = () => !!session.transport.readOnly;
  const colorOf = (by) => { const m = session.room.member(by); return m ? memberColor(m.color, currentTheme()) : INK[currentTheme()]; };
  const settings = () => getSettings(app.store);
  const writeStyle = () => ({ color: "black", size: 2, ...(settings().boardText || {}) });
  // 노래's stretch is one card's own (the owner: "이 녹음된 것만 늘리려고 했는데 다른 것까지 다
  // 늘려주면"): the card under the wheel or the fingers gets longer in time, nothing else moves.
  // While it is being stretched its width is shown here; it is kept (one undo step) when it rests.
  let stretching = null; // { id, w, timer }
  /** A card's width on the board (a card being stretched: as it is now). */
  const widthOf = (item) => (stretching?.id === item.id ? stretching.w : item.w);

  function setMode(m) {
    finishWriting();
    if (m !== "all" && pen.tool) setPen(null);
    // The sideways stretch is 노래's way of looking at songs in time; the other modes show the
    // cards where they really stand. The middle of the view stays where it is.
    const want = 1;
    if (want !== sx) {
      const v = body.getBoundingClientRect();
      const cx = v.left + v.width / 2;
      const cy = v.top + v.height / 2;
      const at = toBoard(cx, cy);
      sx = want;
      keepUnder(cx, cy, at);
    }
    if (cursor && m === "link") cursor = null;
    mode = m;
    linkFrom = null;
    cutting = false;
    // A new mode starts clean: no card chosen, no menu standing over the board.
    selected = null;

    closeExtra?.();
    draw();
  }

  // ---- drawing -------------------------------------------------------------------

  function place() {
    content.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    // Loop chips keep their size when zoomed in and get smaller with the board when zoomed out;
    // too small to aim at, they take no taps (the board under them moves instead).
    content.style.setProperty("--unzoom", String(Math.min(1, 1 / zoom)));
    content.classList.toggle("far", zoom < 0.5);
    placeChips();
    if (menu) placeMenu(false);
    if (writer) placeWriter();
    inkSoon();
  }

  // Continuous gestures (a pinch, the wheel) ask for a draw once per frame at most.
  let drawQueued = false;
  function drawSoon() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
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
        // A memo is "memo" here: "note" is the small note bars' class, whose white words would ride along.
        el = h("div", { class: "card " + (item.kind === "note" ? "memo" : item.kind), data: { id: item.id } });
        wireCard(el, item.id);
        content.append(el);
      }
      el.style.left = item.x * sx + "px";
      el.style.top = item.y + "px";
      el.style.width = widthOf(item) + "px";
      el.style.setProperty("--c", item.tint != null ? memberColor(item.tint, currentTheme()) : colorOf(item.by));
      el.classList.toggle("chosen", item.id === selected);
      el.classList.toggle("link-from", item.id === linkFrom);
      el.classList.toggle("playing", item.id === playing);
      el.classList.toggle("muted", !!item.muted);
      el.classList.toggle("cut-ready", cutting && item.kind === "song");
      // The inside is built again only when what it shows changes; never for a stretch,
      // so a finger resting on a card keeps its touch through a pinch.
      if (item.kind === "note") {
        el.style.setProperty("--tc", item.tint != null ? memberColor(item.tint, currentTheme()) : inkColor(item.color || "black"));
        el.dataset.size = String(item.size || 2);
      }
      const key = item.kind + "|" + (item.text ?? "") + "|" + order.indexOf(item.id) + "|" + !!item.muted + "|" + (item.speed || 1);
      if (el.dataset.key !== key || el.shownData !== item.data) {
        el.dataset.key = key;
        el.shownData = item.data;
        el.replaceChildren(...cardInside(item, order.indexOf(item.id)));
      }
      if (item.kind === "song") {
        nameNotes(el, item);
        const pb = el.querySelector(".card-play");
        const want = solo === item.id && player?.playing ? "stop" : "play";
        if (pb && pb.dataset.icon !== want) {
          pb.dataset.icon = want;
          pb.setAttribute("aria-label", want === "stop" ? "멈춤" : "이 카드만 듣기");
          pb.replaceChildren(icon(want));
        }
      }
    }
    for (const el of [...content.querySelectorAll(".card")]) if (!keep.has(el.dataset.id)) el.remove();
    drawLines();
    drawCursor();
    drawLoopMarks();
    drawLassos();
    surface.classList.toggle("lassoing", lassoing());
    drawRail();
    placeMenu(true);
    // A hint shows for a few seconds after it changes, then fades (it never stays over the board).
    const said = hintText(items);
    if (hint.textContent !== said) {
      hint.textContent = said;
      hint.style.animation = "none";
      void hint.offsetWidth;
      hint.style.animation = "";
    }
    hint.hidden = !said;
    toolbar.querySelector("#board-undo").disabled = !undo.canUndo;
    toolbar.querySelector("#board-redo").disabled = !undo.canRedo;
    toolbar.querySelector("#board-delete").disabled = !selected || readOnly();
    playButton.replaceChildren(icon(player?.playing ? "pause" : "play"));
    if (modes) for (const b of modes.children) b.setAttribute("aria-pressed", String(b.dataset.value === mode));
  }

  /** Where the mode's tools stand now, in words (they can be moved to the left). */
  const toolSide = () => (roomEl?.dataset.railAt === "left" ? "왼쪽" : "오른쪽");

  function hintText(items) {
    if (cutting) return "자를 곳을 노래 카드 위에서 누르세요";
    if (lassoing()) return "카드들을 둘러 그리세요(끝이 안 닿아도 닫혀요). 테두리 안을 끌면 안의 카드와 함께 옮겨져요.";
    if (!items.length) return mode === "song" ? `${toolSide()} '내 노래'나 '소리 넣기'로 노래 카드를 놓아 보세요.` : `${toolSide()} 아이콘으로 글이나 노래 카드를 놓아 보세요. 노래 방에서 '보내기'로 보낼 수도 있어요.`;
    if (mode === "link") return linkFrom ? "다음에 올 카드를 누르거나 줄을 그으세요. 한 카드에서 여러 줄도 돼요(나중 줄이 다음). 번호를 누르면 지워져요." : "카드를 재생할 차례대로 누르거나, 카드에서 카드로 줄을 그어 이으세요.";
    return "";
  }

  /** A song card's name (the owner: "mp3 가지고 왔으면 그것의 이름과 어떤 mp3인지"): "노래 · mp3", or 녹음. */
  function cardTitle(d) {
    const t = soundTitle(d.name, "녹음");
    return t.kind && t.kind !== "녹음" ? `${t.title} · ${t.kind}` : t.title;
  }

  function cardInside(item, place) {
    if (item.kind === "note") return [h("p", { class: "card-text", text: item.text || "빈 메모" })];
    // Once the picture is in, the card is taller: its menu and lines are placed again.
    if (item.kind === "photo") return [h("img", { class: "card-photo", src: item.data.src, alt: "사진", draggable: "false", onload: () => drawSoon() })];
    const d = item.data;
    return [
      h("div", { class: "card-head" },
        // One tap plays just this card (again stops it); the card's menu has the rest.
        h("button", { type: "button", class: "card-play", "aria-label": "이 카드만 듣기", data: { icon: "play" }, onclick: (e) => { if (e.detail === 0) playCard(item.id); } }, icon("play")),
        place >= 0 && h("span", { class: "card-order", text: String(place + 1) }),
        item.muted && h("span", { class: "card-muted", "aria-label": "음소거" }, icon("muted")),
        h("span", { class: "card-name", text: cardTitle(d) }),
        // Its own speed beside its length (the length as it sounds at that speed).
        (item.speed || 1) !== 1 && h("b", { class: "speed-badge", text: item.speed + "×" }),
        h("span", { class: "card-len", text: (d.dur / (item.speed || 1) / 1000).toFixed(1) + "초" })),
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

  /** Order lines between cards; `moving` ({ id: { x, y } }) holds where cards being dragged stand now. */
  function drawLines(moving = null) {
    const items = new Map(board.items().map((i) => [i.id, moving?.[i.id] ? { ...i, ...moving[i.id] } : i]));
    const style = settings().lineColors || "rainbow";
    const mine = colorOf(session.memberId);
    const parts = [];
    for (const l of board.links()) {
      const a = items.get(l.a);
      const b = items.get(l.b);
      const ea = content.querySelector(`.card[data-id="${l.a}"]`);
      const eb = content.querySelector(`.card[data-id="${l.b}"]`);
      if (!a || !b || !ea || !eb) continue;
      // From the side of one card that faces the other: right to left when they stand side by side,
      // bottom to top when one stands under the other.
      const [aw, ah, bw, bh] = [widthOf(a), ea.offsetHeight, widthOf(b), eb.offsetHeight];
      const [acx, acy, bcx, bcy] = [a.x * sx + aw / 2, a.y + ah / 2, b.x * sx + bw / 2, b.y + bh / 2];
      const across = Math.max(0, Math.abs(bcx - acx) - (aw + bw) / 2);
      const down = Math.max(0, Math.abs(bcy - acy) - (ah + bh) / 2);
      let x1, y1, x2, y2, d;
      if (down > across) {
        const s1 = Math.sign(bcy - acy) || 1;
        [x1, y1, x2, y2] = [acx, acy + (s1 * ah) / 2, bcx, bcy - (s1 * bh) / 2];
        const bend = Math.max(30, Math.abs(y2 - y1) / 2) * s1;
        d = `M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`;
      } else {
        const s1 = Math.sign(bcx - acx) || 1;
        [x1, y1, x2, y2] = [acx + (s1 * aw) / 2, acy, bcx - (s1 * bw) / 2, bcy];
        const bend = Math.max(40, Math.abs(x2 - x1) / 2) * s1;
        d = `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
      }
      const color = orderColor(l.n, style, mine);
      const ink = contrast(color, "#ffffff") >= contrast(color, "#1d2433") ? "#ffffff" : "#1d2433";
      parts.push(`<path d="${d}" stroke="${color}" />`);
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      parts.push(`<g class="badge" data-link="${l.id}" transform="translate(${mx} ${my})"><circle r="13" fill="${color}" /><text text-anchor="middle" dy="4.5" style="fill:${ink}">${l.n}</text></g>`);
    }
    const html = parts.join("");
    if (lines.dataset.html === html) return;
    lines.dataset.html = html;
    lines.innerHTML = html;
    for (const g of lines.querySelectorAll(".badge")) {
      g.addEventListener("pointerdown", (e) => {
        if (mode !== "link" || readOnly()) return;
        e.stopPropagation();
        apply(unlinkOps(session.clock, board, g.dataset.link));
      });
    }
  }

  // ---- 올가미 ------------------------------------------------------------------------

  /** An SVG path through board points, as the board shows them (stretched by sx). */
  function loopPath(pts, dx = 0, dy = 0) {
    let d = "";
    for (let i = 0; i < pts.length; i += 2) d += (i ? "L" : "M") + Math.round((pts[i] + dx) * sx * 10) / 10 + " " + Math.round(pts[i + 1] + dy);
    return d;
  }

  /** The loops: a dashed outline under the cards, and a chip (▶ n, ✕) over each loop's top that also drags it. */
  function drawLassos() {
    const all = board.lassos();
    const shift = (l) => (loopDrag?.id === l.id ? [loopDrag.dx, loopDrag.dy] : [0, 0]);
    const html = all.map((l) => `<path data-lasso="${l.id}"${l.tint != null ? ` style="--lc:${memberColor(l.tint, currentTheme())}"` : ""} d="${loopPath(l.pts, ...shift(l))}Z" />`).join("");
    if (loopGroup.dataset.html !== html) {
      loopGroup.dataset.html = html;
      loopGroup.innerHTML = html;
    }
    const keep = new Set();
    for (const l of all) {
      keep.add(l.id);
      let chip = content.querySelector(`.lasso-chip[data-lasso="${l.id}"]`);
      if (!chip) content.append(chip = lassoChip(l.id));
      const [dx, dy] = shift(l);
      let top = 0;
      let bottom = 0;
      for (let i = 2; i < l.pts.length; i += 2) {
        if (l.pts[i + 1] < l.pts[top + 1]) top = i;
        if (l.pts[i + 1] > l.pts[bottom + 1]) bottom = i;
      }
      let left = 0;
      let right = 0;
      for (let i = 2; i < l.pts.length; i += 2) {
        if (l.pts[i] < l.pts[left]) left = i;
        if (l.pts[i] > l.pts[right]) right = i;
      }
      chip.anchors = {
        tx: (l.pts[top] + dx) * sx, ty: l.pts[top + 1] + dy, bx: (l.pts[bottom] + dx) * sx, by: l.pts[bottom + 1] + dy,
        x0: (l.pts[left] + dx) * sx, ly: l.pts[left + 1] + dy, x1: (l.pts[right] + dx) * sx, ry: l.pts[right + 1] + dy,
      };
      const count = lassoOrder(board, l.id).length;
      const sounding = soloLasso === l.id && !!player?.playing;
      const play = chip.querySelector(".lasso-play");
      const text = (sounding ? "■ 멈춤" : `▶ ${count}곡`) + (repeating.has(l.id) ? " ↻" : "");
      const k = kindOf(l.id);
      const held = loopHolds(l.id, k);
      const kindText = `${KIND_NAMES[k]} ${held.cards.length + held.strokes.length}`;
      const kindEl = chip.querySelector(".lasso-kind");
      const noPlay = k === "note" || k === "draw";
      if (play.textContent !== text || kindEl.textContent !== kindText || play.hidden !== noPlay || !chip.sizes) {
        play.textContent = text;
        kindEl.textContent = kindText;
        play.hidden = noPlay;
        // Its size lying down and standing up, for placeChips.
        const was = chip.classList.contains("side");
        chip.classList.remove("side");
        const row = [chip.offsetWidth, chip.offsetHeight];
        chip.classList.add("side");
        chip.sizes = { row, side: [chip.offsetWidth, chip.offsetHeight] };
        chip.classList.toggle("side", was);
      }
      play.setAttribute("aria-label", sounding ? "올가미 재생 멈춤" : `올가미 안의 노래 카드 ${count}개 재생`);
      chip.querySelector(".lasso-remove").hidden = readOnly();
    }
    for (const chip of [...content.querySelectorAll(".lasso-chip")]) if (!keep.has(chip.dataset.lasso)) chip.remove();
    placeChips();
  }

  /**
   * Keeps each loop's chip where a finger reaches it and off the cards near it:
   * over the loop's top; when that is out of view, beside the loop (right, then
   * left); then under it; inside a loop bigger than the view, at the top of the
   * view. Never under the tools on the right.
   */
  function placeChips() {
    const box = surface.getBoundingClientRect();
    const W = rail.getBoundingClientRect().left - box.left - 6;
    // The part in view, on the board (which reaches under the bars).
    const T = insets.top;
    const H = box.height - insets.bottom;
    for (const chip of content.querySelectorAll(".lasso-chip")) {
      const a = chip.anchors;
      if (!a || !chip.sizes) continue;
      const [w, tall] = chip.sizes.row;
      const [sw, stall] = chip.sizes.side;
      const X = (x) => panX + x * zoom;
      const Y = (y) => panY + y * zoom;
      const middle = (y) => Math.max(T + 4, Math.min(H - stall - 4, Y(y) - stall / 2));
      // [x, y, standing up]: over the top lying down; beside, standing up; under, lying down.
      const spots = [
        [X(a.tx) - w / 2, Y(a.ty) - tall - 6, false],
        [X(a.x1) + 6, middle(a.ry), true],
        [X(a.x0) - sw - 6, middle(a.ly), true],
        [X(a.bx) - w / 2, Y(a.by) + 6, false],
      ];
      const fits = ([x, y, side]) => x >= 4 && x + (side ? sw : w) <= W && y >= T + 4 && y + (side ? stall : tall) <= H - 4;
      let [x, y, side] = spots[0];
      if (X(a.x1) > 0 && X(a.x0) < W && Y(a.by) > T && Y(a.ty) < H) {
        const spot = spots.find(fits);
        if (spot) [x, y, side] = spot;
        else [x, y, side] = [Math.max(4, Math.min(W - w, X(a.tx) - w / 2)), Math.max(T + 4, Math.min(H - tall - 4, Y(a.ty) + 6)), false];
      }
      chip.classList.toggle("side", side);
      chip.style.left = (x - panX) / zoom + "px";
      chip.style.top = (y - panY) / zoom + "px";
    }
  }

  /** A loop's chip: ▶ plays what is inside, ✕ takes the loop off, a drag moves the loop. */
  function lassoChip(id) {
    const play = h("button", { type: "button", class: "lasso-play", id: "lasso-play-" + id, onclick: () => { if (!chipDragged) playLasso(id); } });
    const remove = h("button", { type: "button", class: "lasso-remove", id: "lasso-remove-" + id, "aria-label": "올가미 풀기", title: "올가미 풀기", text: "✕", onclick: () => {
      if (chipDragged || readOnly()) return;
      if (soloLasso === id) stopPlaying();
      apply(removeLassoOps(session.clock, board, id));
    } });
    const more = h("button", { type: "button", class: "lasso-more", id: "lasso-more-" + id, "aria-label": "올가미 안의 카드들", title: "복사, 지우기, 레퍼런스", text: "⋯", onclick: () => { if (!chipDragged) openLassoMenu(id, chip); } });
    // 곡·글·그림·전체: what the loop's actions take.
    const kind = h("button", { type: "button", class: "lasso-kind", id: "lasso-kind-" + id, "aria-label": "올가미가 다룰 것 (곡, 글, 그림, 전체)", onclick: () => { if (!chipDragged) openKinds(id, chip); } });
    const chip = h("div", { class: "lasso-chip", data: { lasso: id }, role: "group", "aria-label": "올가미" }, play, kind, more, remove);
    chip.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      chipDragged = false;
      focusLoop = id;
      if (fingers.pinching || readOnly()) return;
      const start = { x: e.clientX, y: e.clientY };
      const mine = (ev) => ev.pointerId === e.pointerId;
      const move = (ev) => {
        if (!mine(ev)) return;
        if (!chipDragged && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        // Held only once it is a drag, so a tap still clicks its button.
        if (!chipDragged) chip.setPointerCapture?.(e.pointerId);
        chipDragged = true;
        loopDrag = { id, dx: (ev.clientX - start.x) / (zoom * sx), dy: (ev.clientY - start.y) / zoom };
        drawLassos();
      };
      const stop = () => {
        chip.removeEventListener("pointermove", move);
        chip.removeEventListener("pointerup", up);
        chip.removeEventListener("pointercancel", cancel);
        gesture = null;
      };
      const up = (ev) => {
        if (!mine(ev)) return;
        stop();
        if (!chipDragged || !loopDrag) return;
        const { dx, dy } = loopDrag;
        loopDrag = null;
        if (!apply(moveLassoOps(session.clock, board, id, dx, dy))) drawLassos();
      };
      const cancel = (ev) => {
        if (ev && !mine(ev)) return;
        stop();
        loopDrag = null;
        drawLassos();
      };
      gesture = cancel;
      chip.addEventListener("pointermove", move);
      chip.addEventListener("pointerup", up);
      chip.addEventListener("pointercancel", cancel);
    });
    return chip;
  }

  /**
   * What the cards inside a loop can do together (the owner: "올가미기능은 많은걸 할 수 있게"):
   * 색 (the loop and every card in it), 정리 (one row, the loop round it), 잇기 (order lines from
   * the left), 음소거 / 소리 켜기, 반복 (its ▶ goes round again), 복사, 레퍼런스에 넣기, 지우기.
   * Each is one undo step; what cannot be done with these cards is not offered.
   */
  function openLassoMenu(id, chip) {
    closeExtra?.();
    focusLoop = id;
    const one = (bid, text, onclick) => h("button", { type: "button", id: bid, text, onclick: (e) => { e.stopPropagation(); close(); onclick(); } });
    const can = !readOnly();
    const box = h("div", { class: "clip-menu card-menu lasso-menu", id: "lasso-menu", role: "toolbar", "aria-label": "올가미 메뉴" });
    const fill = (view) => {
      const loop = board.lassos().find((l) => l.id === id);
      const kind = kindOf(id);
      const songs = kind === "all" || kind === "song" ? itemsInLoop(board, id).filter((c) => c.kind === "song") : [];
      if (view === "tints") {
        // The owner: "올가미에서 선택 영역을 했으면 거기서 무슨 색을 할거냐" - 곡, 텍스트, 그림, 전체:
        // first what takes the colour, then the colour. People's own colours stay as they are.
        const now = loop?.tint ?? null;
        box.replaceChildren(
          h("div", { class: "lasso-tint-kinds", id: "lasso-tint-kinds" }, ["song", "note", "draw", "all"].map((k) => {
            const held = loopHolds(id, k);
            return h("button", { type: "button", data: { tintKind: k }, "aria-pressed": String(kind === k), text: `${KIND_NAMES[k]} ${held.cards.length + held.strokes.length}`,
              onclick: (e) => { e.stopPropagation(); loopKinds.set(id, k); fill("tints"); place(); draw(); } });
          })),
          ...PALETTE.map((_, i) => h("button", { type: "button", class: "menu-dot", data: { tint: String(i) }, "aria-label": "색 " + (i + 1), "aria-pressed": String(now === i),
            style: { background: memberColor(i, currentTheme()) }, onclick: (e) => { e.stopPropagation(); close(); tintLasso(id, i); } })),
          one("lasso-tint-none", "기본", () => tintLasso(id, null)));
        return;
      }
      const held = loopHolds(id);
      const pasteable = !!(clipboardItem(app.store, "board-items") || clipboardItem(app.store, "song-clip"));
      box.replaceChildren(...[
        can && h("button", { type: "button", id: "lasso-tint", onclick: (e) => { e.stopPropagation(); fill("tints"); place(); } },
          h("span", { class: "menu-swatch", style: { background: loop?.tint != null ? memberColor(loop.tint, currentTheme()) : "var(--accent)" } }), "색"),
        can && held.cards.length > 0 && one("lasso-tidy", "순서 정리", () => tidyLasso(id)),
        can && songs.length > 1 && one("lasso-chain", "잇기", () => chainLasso(id)),
        can && songs.length > 0 && one("lasso-mute", songs.some((c) => !c.muted) ? "음소거" : "소리 켜기", () => muteLasso(id)),
        songs.length > 0 && one("lasso-repeat", repeating.has(id) ? "반복 끄기" : "반복", () => toggleRepeat(id)),
        can && pasteable && one("lasso-paste", "붙여넣기", () => pasteIntoLoop(id)),
        one("lasso-copy", "복사", () => copyLasso(loopHolds(id))),
        one("lasso-ref", "레퍼런스에 넣기", () => lassoToReference(loopHolds(id).cards)),
        can && one("lasso-delete", "지우기", () => deleteLasso(loopHolds(id))),
      ].filter(Boolean));
    };
    const place = () => {
      const area = body.getBoundingClientRect();
      const r = chip.getBoundingClientRect();
      const room = rail.getBoundingClientRect().left - area.left - 6;
      box.style.maxWidth = Math.max(160, room - 6) + "px";
      box.style.left = Math.max(6, Math.min(room - box.offsetWidth, r.left - area.left + r.width / 2 - box.offsetWidth / 2)) + "px";
      box.style.top = Math.max(4, Math.min(area.height - box.offsetHeight - 4, r.bottom - area.top + 6)) + "px";
    };
    fill("main");
    body.append(box);
    place();
    let open = true;
    const stopGuard = closeOnOutside((t) => box.contains(t), () => close(), box);
    function close() {
      if (!open) return;
      open = false;
      stopGuard();
      box.remove();
      if (closeExtra === close) closeExtra = null;
    }
    closeExtra = close;
  }

  /** Many board changes as one undo step. */
  function applyAll(made) {
    const atoms = [];
    for (const m of made) {
      if (!m?.ops?.length) continue;
      session.commit("board", m.ops);
      atoms.push(...m.atoms);
    }
    record(atoms);
    draw();
  }

  const KIND_NAMES = { all: "전체", song: "곡", note: "글", draw: "그림" };
  const kindOf = (id) => loopKinds.get(id) || "all";

  /** What a loop holds of a kind: { cards, strokes } (drawings count for 그림 and 전체). */
  function loopHolds(id, kind = kindOf(id)) {
    const loop = board.lassos().find((l) => l.id === id);
    if (!loop) return { cards: [], strokes: [] };
    const cards = itemsInLoop(board, id).filter((c) => kind === "all" || (kind === "song" && c.kind === "song") || (kind === "note" && c.kind === "note") || (kind === "draw" && c.kind === "photo"));
    const strokes = kind === "all" || kind === "draw" ? strokesInLoop(session.doc(INK_DOC).strokes(), loop.pts, INK_UNIT) : [];
    return { cards, strokes };
  }

  /** The 곡·글·그림·전체 choice by a loop's chip, each with how many it holds. */
  function openKinds(id, chip) {
    closeExtra?.();
    const box = h("div", { class: "clip-menu card-menu lasso-menu", id: "lasso-kinds", role: "toolbar", "aria-label": "올가미가 다룰 것" },
      ["song", "note", "draw", "all"].map((k) => {
        const held = loopHolds(id, k);
        return h("button", { type: "button", data: { loopKind: k }, "aria-pressed": String(kindOf(id) === k), text: `${KIND_NAMES[k]} ${held.cards.length + held.strokes.length}`,
          onclick: (e) => { e.stopPropagation(); close(); loopKinds.set(id, k); focusLoop = id; draw(); } });
      }));
    body.append(box);
    const area = body.getBoundingClientRect();
    const r = chip.getBoundingClientRect();
    const room = rail.getBoundingClientRect().left - area.left - 6;
    box.style.left = Math.max(6, Math.min(room - box.offsetWidth, r.left - area.left)) + "px";
    box.style.top = Math.max(4, Math.min(area.height - box.offsetHeight - 4, r.bottom - area.top + 6)) + "px";
    let open = true;
    const stopGuard = closeOnOutside((t) => box.contains(t), () => close(), box);
    function close() {
      if (!open) return;
      open = false;
      stopGuard();
      box.remove();
      if (closeExtra === close) closeExtra = null;
    }
    closeExtra = close;
  }

  /**
   * 색: what the loop works on (its 곡·글·그림·전체) takes the colour, and the loop's line with it
   * ("내 고유색을 바꾸는 게 아니라 그냥 거기 색깔을": a person's own colour never changes, only these
   * things'). 기본 gives each back its own (a recording its maker's colour); drawings keep theirs then.
   * One undo step.
   */
  function tintLasso(id, tint) {
    if (readOnly()) return;
    const held = loopHolds(id);
    const atoms = [];
    for (const made of [...held.cards.map((c) => setItemOps(session.clock, board, c.id, { tint })), tintLassoOps(session.clock, board, id, tint)]) {
      if (!made?.ops?.length) continue;
      session.commit("board", made.ops);
      atoms.push(...made.atoms);
    }
    if (tint !== null && held.strokes.length) {
      const made = recolorStrokesOps(session.clock, session.doc(INK_DOC), held.strokes, memberColor(tint, currentTheme()), session.memberId);
      if (made.ops.length) {
        session.commit(INK_DOC, made.ops);
        atoms.push(...made.atoms.map((a) => ({ ...a, doc: INK_DOC })));
      }
    }
    record(atoms);
    draw();
    inkSoon();
  }

  /** 정리: the cards inside in one row from the left, tops even, and the loop drawn again round them. */
  function tidyLasso(id) {
    const loop = board.lassos().find((l) => l.id === id);
    const cards = loopHolds(id).cards;
    if (!loop || !cards.length) return;
    // Measured as they stand on screen (song cards stretch with sx), then put back in board units.
    const boxes = cards.map((c) => {
      const el = content.querySelector(`.card[data-id="${c.id}"]`);
      return { id: c.id, x: c.x * sx, y: c.y, w: el ? el.offsetWidth : widthOf(c), h: el ? el.offsetHeight : 60 };
    });
    const placed = rowLayout(boxes, 24);
    const made = placed.map((p) => setItemOps(session.clock, board, p.id, { x: Math.round(p.x / sx), y: p.y }));
    const size = new Map(boxes.map((b) => [b.id, b]));
    const pad = 22;
    const x0 = placed[0].x - pad;
    const y0 = placed[0].y - pad;
    const x1 = Math.max(...placed.map((p) => p.x + size.get(p.id).w)) + pad;
    const y1 = Math.max(...placed.map((p) => p.y + size.get(p.id).h)) + pad;
    const atoms = [];
    for (const m of made) {
      if (!m.ops.length) continue;
      session.commit("board", m.ops);
      atoms.push(...m.atoms);
    }
    const gone = removeLassoOps(session.clock, board, id);
    session.commit("board", gone.ops);
    atoms.push(...gone.atoms);
    const again = lassoOps(session.clock, board, boxLoop(Math.round(x0 / sx), y0, Math.round(x1 / sx), y1, 22), session.memberId);
    if (again.ops.length) {
      session.commit("board", again.ops);
      atoms.push(...again.atoms);
      if (loop.tint != null) {
        const t = tintLassoOps(session.clock, board, again.id, loop.tint);
        session.commit("board", t.ops);
        atoms.push(...t.atoms);
      }
      if (repeating.delete(id)) repeating.add(again.id);
      if (soloLasso === id) soloLasso = again.id;
      if (loopKinds.has(id)) loopKinds.set(again.id, loopKinds.get(id));
      if (focusLoop === id) focusLoop = again.id;
    }
    record(atoms);
    draw();
  }

  /** 잇기: order lines between the song cards inside, from the left (one undo step). */
  function chainLasso(id) {
    const ids = itemsInLoop(board, id).filter((c) => c.kind === "song").sort((p, q) => p.x - q.x || p.y - q.y).map((c) => c.id);
    if (ids.length < 2) return;
    linkChain(ids);
    linkFrom = null;
    draw();
  }

  /** 음소거: every song inside goes quiet; when all are quiet, 소리 켜기 brings them back. */
  function muteLasso(id) {
    const songs = itemsInLoop(board, id).filter((c) => c.kind === "song");
    const mute = songs.some((c) => !c.muted);
    applyAll(songs.filter((c) => !!c.muted !== mute).map((c) => setItemOps(session.clock, board, c.id, { muted: mute })));
  }

  /** 반복: the loop's ▶ goes round and round until it is stopped (on this device). Turning it on plays it. */
  function toggleRepeat(id) {
    if (repeating.delete(id)) return void draw();
    repeating.add(id);
    draw();
    if (!(soloLasso === id && player?.playing)) playLasso(id);
  }

  /** The cards as they stand relative to each other, ready to be put down elsewhere. */
  /** The cards (and drawings) as they stand to each other, ready to be put down elsewhere. */
  function copyLasso({ cards: items, strokes = [] }) {
    const ink = session.doc(INK_DOC);
    const lines = strokes.map((sid) => ink.get(sid)).filter(Boolean);
    if (!items.length && !lines.length) return void toast(root, "올가미 안에 고른 것이 없어요");
    // The group's corner, in board pixels (drawings count in INK_UNITs).
    const xs = [...items.map((i) => i.x), ...lines.flatMap((l) => l.pts.filter((_, k) => k % 3 === 0).map((v) => v / INK_UNIT))];
    const ys = [...items.map((i) => i.y), ...lines.flatMap((l) => l.pts.filter((_, k) => k % 3 === 1).map((v) => v / INK_UNIT))];
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    copyItem(app.store, {
      kind: "board-items",
      items: items.map((i) => ({ kind: i.kind, dx: i.x - x0, dy: i.y - y0, data: i.kind === "note" ? { text: i.text || "" } : i.data, ...keepOf(i) })),
      strokes: lines.map((l) => ({ pts: l.pts.map((v, k) => (k % 3 === 0 ? Math.round(v - x0 * INK_UNIT) : k % 3 === 1 ? Math.round(v - y0 * INK_UNIT) : v)), c: l.c, w: l.w, b: l.b || "pen" })),
    });
    toast(root, `${items.length + lines.length}개를 복사했어요. 화이트보드의 '붙이기'나 올가미의 '붙여넣기'로 넣을 수 있어요`, 3200);
  }

  function deleteLasso({ cards: items, strokes = [] }) {
    if ((!items.length && !strokes.length) || readOnly()) return void toast(root, "올가미 안에 고른 것이 없어요");
    const atoms = [];
    for (const i of items) {
      const made = removeItemOps(session.clock, board, i.id);
      session.commit("board", made.ops);
      atoms.push(...made.atoms);
    }
    for (const sid of strokes) {
      const made = eraseOps(session.clock, session.doc(INK_DOC), sid);
      session.commit(INK_DOC, made.ops);
      atoms.push(...made.atoms.map((a) => ({ ...a, doc: INK_DOC })));
    }
    record(atoms);
    draw();
    inkSoon();
    toast(root, `${items.length + strokes.length}개를 지웠어요. 되돌리기로 살릴 수 있어요`, 3200);
  }

  /** 붙여넣기 into a loop: what was copied goes to the right of what the loop holds, and the loop goes round it all. */
  function pasteIntoLoop(id) {
    const loop = board.lassos().find((l) => l.id === id);
    if (!loop || readOnly()) return;
    const group = clipboardItem(app.store, "board-items");
    const clip = !group && clipboardItem(app.store, "song-clip");
    if (!group && !clip) return void toast(root, "복사한 것이 없어요");
    const list = group ? group.items : [{ kind: "song", dx: 0, dy: 0, data: cardFromClip(clip), speed: clip.speed, tint: clip.tint }];
    const inside = itemsInLoop(board, id);
    const boxes = inside.map((c) => {
      const el = content.querySelector(`.card[data-id="${c.id}"]`);
      return { x: c.x, y: c.y, w: (el ? el.offsetWidth : widthOf(c)) / sx, h: el ? el.offsetHeight : 60 };
    });
    let x0, y0, x1, y1;
    if (boxes.length) {
      x0 = Math.min(...boxes.map((b) => b.x)); y0 = Math.min(...boxes.map((b) => b.y));
      x1 = Math.max(...boxes.map((b) => b.x + b.w)); y1 = Math.max(...boxes.map((b) => b.y + b.h));
    } else {
      x0 = Math.min(...loop.pts.filter((_, k) => k % 2 === 0)) + 20; y0 = Math.min(...loop.pts.filter((_, k) => k % 2 === 1)) + 20;
      x1 = x0 - 24; y1 = y0;
    }
    const at = { x: x1 + 24, y: y0 };
    const made = pasteGroup(list, { strokes: group?.strokes || [], at, quiet: true });
    if (!made) return;
    // The loop goes round what it held and what came in.
    let mx1 = x1, my1 = y1;
    for (const it of made.items) {
      const el = content.querySelector(`.card[data-id="${it.id}"]`);
      mx1 = Math.max(mx1, it.x + (el ? el.offsetWidth / sx : 200));
      my1 = Math.max(my1, it.y + (el ? el.offsetHeight : 100));
    }
    const atoms = [...made.atoms];
    const gone = removeLassoOps(session.clock, board, id);
    session.commit("board", gone.ops);
    atoms.push(...gone.atoms);
    const again = lassoOps(session.clock, board, boxLoop(Math.round(Math.min(x0, at.x) - 22), Math.round(y0 - 22), Math.round(mx1 + 22), Math.round(my1 + 22), 22), session.memberId);
    if (again.ops.length) {
      session.commit("board", again.ops);
      atoms.push(...again.atoms);
      if (loop.tint != null) {
        const t = tintLassoOps(session.clock, board, again.id, loop.tint);
        session.commit("board", t.ops);
        atoms.push(...t.atoms);
      }
      if (loopKinds.has(id)) loopKinds.set(again.id, loopKinds.get(id));
      if (repeating.delete(id)) repeating.add(again.id);
      focusLoop = again.id;
    }
    record(atoms);
    draw();
    toast(root, `올가미에 ${made.items.length + made.strokes}개를 붙였어요`);
  }

  /** Song cards go to 레퍼런스 as recordings, text as notes (on this device only, as all of 레퍼런스). */
  function lassoToReference(items) {
    let n = 0;
    for (const i of items) {
      if (i.kind === "note" && (i.text || "").trim()) {
        addRefNote(app.store, i.text);
        n++;
      } else if (i.kind === "song") {
        const d = i.data;
        addRefSound(app.store, { name: d.name, dur: d.dur / 1000, notes: d.notes.map(([t, len, p, v]) => ({ t: t / 1000, d: len / 1000, p, v: v / 100 })), peaks: d.peaks, blob: d.blob });
        n++;
      }
    }
    toast(root, n ? `레퍼런스에 ${n}개를 넣었어요` : "레퍼런스에 넣을 글이나 노래 카드가 없어요", 3000);
  }

  /** Takes every loop off (one undo step). */
  function removeAllLassos() {
    const ops = [];
    const atoms = [];
    for (const l of board.lassos()) {
      const made = removeLassoOps(session.clock, board, l.id);
      ops.push(...made.ops);
      atoms.push(...made.atoms);
    }
    if (!ops.length) return void toast(root, "풀 올가미가 없어요");
    stopPlaying();
    apply({ ops, atoms });
  }

  // ---- the tools on the right ------------------------------------------------------

  /** A rail tool that opens a picker: a label, so the chooser opens straight from the tap. */
  function railLabel(id, iconName, label, forId) {
    return h("label", { class: "rail-btn", id, for: forId, role: "button", "aria-label": label, title: label }, icon(iconName), h("span", { class: "rail-cap", text: label }));
  }

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
    // Built again only when what it shows changes, not on every draw.
    const key = [mode, can, s.songSpeed || 1, s.songMode, s.lineColors || "rainbow", JSON.stringify(writeStyle()), focusLoop, focusOff, board.lassos().length].join("|");
    if (rail.dataset.key === key) return;
    rail.dataset.key = key;
    const chosen = selected ? board.item(selected) : null;
    const song = chosen && !chosen.removed && chosen.kind === "song" ? chosen : null;
    const tools = {
      all: [
        can && railButton("add-note", null, "글", () => addNote(), { text: "+글" }),
        can && railButton("add-song", null, "붙이기", () => addSong(), { text: "+♪" }),
        can && railLabel("add-photo", "photo", "사진", "board-photo-file"),
        can && railButton("my-songs", "library", "내 노래", () => openSongDrawer()),
      ],
      move: [
        railButton("board-fit", "fit", "모두 보기", () => fitAll()),
        railButton("board-zoom-in", "zoomIn", "크게", () => zoomAt(1.25)),
        railButton("board-zoom-out", "zoomOut", "작게", () => zoomAt(1 / 1.25)),
      ],
      // 글쓰기: a tap writes there; the colour and size of the words (the ones being written too).
      write: [
        can && writeColorButton(),
        can && railButton("write-size", null, "글 크기", () => setWriteStyle({ size: (writeStyle().size % 3) + 1 }), { text: ["작게", "보통", "크게"][writeStyle().size - 1] }),
      ],
      link: [
        railButton("order-list", "lines", "순서 목록", () => openOrderList()),
        railButton("order-slots", "slots", "순서 칸", () => openSlots()),
        railButton("line-colors", "palette", LINE_STYLES[s.lineColors || "rainbow"], () => nextLineColors()),
        can && railButton("unlink-all", "eraser", "줄 지우기", () => unlinkAll()),
      ],
      song: [
        can && railButton("my-songs", "library", "내 노래", () => openSongDrawer()),
        railButton("order-list", "lines", "순서 목록", () => openOrderList()),
        can && railButton("board-add-sound", "upload", "소리 넣기", () => openAddSound()),
        railButton("stretch-in", "stretch", "늘이기", () => stretchChosen(1.4)),
        railButton("stretch-out", "squeeze", "줄이기", () => stretchChosen(1 / 1.4)),
        railButton("board-speed", null, "빠르기", () => nextSpeed(), { text: (s.songSpeed || 1) + "×" }),
        railButton("board-sound-mode", s.songMode === "original" ? "wave" : "note", s.songMode === "original" ? "원본" : "피아노", () => toggleSoundMode()),
        // With a loop in hand: only its part (pressed), or the whole board.
        !!focusLoop && railButton("song-focus", "fit", "올가미만", () => { focusOff = !focusOff; draw(); }, { pressed: !focusOff }),
      ],
      // 올가미: its loops play what is inside; their ⋯ copies, removes, sends to 레퍼런스.
      lasso: [
        railButton("board-fit", "fit", "모두 보기", () => fitAll()),
        railButton("board-speed", null, "빠르기", () => nextSpeed(), { text: (s.songSpeed || 1) + "×" }),
        railButton("board-sound-mode", s.songMode === "original" ? "wave" : "note", s.songMode === "original" ? "원본" : "피아노", () => toggleSoundMode()),
        can && railButton("lasso-clear", "eraser", "모두 풀기", () => removeAllLassos()),
      ],
    }[mode];
    rail.replaceChildren(...tools.filter(Boolean));
    // Choosing a colour or size keeps the words being written in focus (and the keyboard up).
    for (const b of rail.querySelectorAll("#write-color, #write-size")) b.addEventListener("pointerdown", (e) => e.preventDefault());
  }

  // ---- a card's menu: tap a card, act on it right there (as in the song room) ----------

  /** Builds (when asked) and places the chosen card's menu above the card, or below it near the top. */
  function placeMenu(build) {
    const item = selected ? board.item(selected) : null;
    const el = item && !item.removed && !cutting && mode !== "link" ? content.querySelector(`.card[data-id="${item.id}"]`) : null;
    if (!el) {
      menu?.stopGuard?.();
      menu?.remove();
      menu = null;
      return;
    }
    if (!menu) {
      menu = h("div", { class: "clip-menu card-menu", id: "card-menu", role: "toolbar", "aria-label": "카드 메뉴" });
      body.append(menu);
      build = true;
      // A tap anywhere else only puts the menu away (the card itself and the tool bars still work).
      menu.stopGuard = closeOnOutside(
        (t) => menu?.contains(t) || !!content.querySelector(`.card[data-id="${selected}"]`)?.contains(t),
        () => { selected = null; draw(); }, menu);
    }
    if (menu.forItem !== item.id) {
      menu.forItem = item.id;
      menu.view = "main";
    }
    const key = [item.id, item.kind, !!item.muted, solo === item.id && !!player?.playing, readOnly(), item.color, item.size, item.tint, item.speed, menu.view].join("|");
    if (build && menu.dataset.key !== key) {
      menu.dataset.key = key;
      const can = !readOnly();
      const one = (id, text, onclick) => h("button", { type: "button", id, text, onclick: (e) => { e.stopPropagation(); onclick(); } });
      // 색 for a song or a photo card: the people colours in place of the menu, and 기본 (whoever placed it).
      // Whose it is, so a colour that is a person's is not taken for theirs (the owner: "색깔 들어가면은 누구 건지도").
      const owner = session.room.member(item.by)?.name || "누군가";
      const whose = (i) => session.room.members().filter((m) => m.color === i).map((m) => m.name);
      const tints = () => [
        h("p", { class: "menu-info", id: "card-owner" }, h("span", { class: "menu-swatch", style: { background: colorOf(item.by) } }), `${owner}이(가) 넣음 · 기본은 ${owner}의 색`),
        ...PALETTE.map((_, i) => h("button", { type: "button", class: "menu-dot", data: { tint: String(i) }, "aria-label": whose(i).length ? whose(i).join(", ") + "의 색" : "색 " + (i + 1), title: whose(i).join(", "),
          "aria-pressed": String((item.tint ?? null) === i), text: whose(i)[0]?.slice(0, 1) || "",
          style: { background: memberColor(i, currentTheme()) }, onclick: (e) => { e.stopPropagation(); menu.view = "main"; apply(setItemOps(session.clock, board, item.id, { tint: i })); } })),
        item.tint != null && one("card-tint-none", "기본", () => { menu.view = "main"; apply(setItemOps(session.clock, board, item.id, { tint: null })); }),
      ];
      const tintButton = () => can && h("button", { type: "button", id: "card-tint", onclick: (e) => { e.stopPropagation(); menu.view = "tints"; placeMenu(true); } },
        h("span", { class: "menu-swatch", style: { background: item.tint != null ? memberColor(item.tint, currentTheme()) : colorOf(item.by) } }), "색");
      menu.replaceChildren(...(item.kind !== "note" && menu.view === "tints" ? tints() : item.kind === "song" ? [
        one("card-play", solo === item.id && player?.playing ? "■ 멈춤" : "▶ 듣기", () => playCard(item.id)),
        can && one("card-cut", "분할", () => { if (cursor?.id === item.id) cutAtMs(item.id, cursor.ms); else { cutting = true; draw(); } }),
        one("card-notes", "음 편집", () => editCardNotes(item.id)),
        can && one("card-mute", item.muted ? "소리 켜기" : "음소거", () => apply(setItemOps(session.clock, board, item.id, { muted: !item.muted }))),
        // Its own 빠르기: the card plays that much faster (pitch kept) and is that much shorter.
        can && one("card-speed", `빠르기 ${item.speed || 1}×`, () => {
          const next = CLIP_SPEEDS[(CLIP_SPEEDS.indexOf(item.speed || 1) + 1) % CLIP_SPEEDS.length];
          apply(setItemOps(session.clock, board, item.id, { speed: next, w: songWidth(Math.round(item.data.dur / next)) }));
        }),
        tintButton(),
        one("card-copy", "복사", () => copyCard(item.id)),
        can && one("card-delete", "지우기", () => removeSelected()),
      ] : item.kind === "note" && menu.view === "colors" ? [
        // Plain text's colours, in place of the menu (small, so it covers little).
        ...INK_COLORS.map((c) => h("button", { type: "button", class: "menu-dot", data: { textColor: c }, "aria-label": "글자 색", "aria-pressed": String((item.color || "black") === c),
          style: { background: inkColor(c) }, onclick: (e) => { e.stopPropagation(); menu.view = "main"; apply(setItemOps(session.clock, board, item.id, { color: c, tint: null })); } })),
      ] : item.kind === "note" ? [
        can && one("card-edit", "고치기", () => write(item.id)),
        can && h("button", { type: "button", id: "card-color", onclick: (e) => { e.stopPropagation(); menu.view = "colors"; placeMenu(true); } },
          h("span", { class: "menu-swatch", style: { background: inkColor(item.color || "black") } }), "색"),
        can && one("card-size", ["작게", "보통", "크게"][(item.size || 2) - 1], () => apply(setItemOps(session.clock, board, item.id, { size: ((item.size || 2) % 3) + 1 }))),
        can && one("card-delete", "지우기", () => removeSelected()),
      ] : [
        tintButton(),
        can && one("card-delete", "지우기", () => removeSelected()),
      ]).filter(Boolean));
    }
    const area = body.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    // Never over the tools on the right: the menu wraps onto another line instead.
    const room = rail.getBoundingClientRect().left - area.left - 6;
    menu.style.maxWidth = Math.max(160, room - 6) + "px";
    const w = menu.offsetWidth;
    const hgt = menu.offsetHeight;
    const left = Math.max(6, Math.min(room - w, box.left - area.left + box.width / 2 - w / 2));
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
    const r = body.getBoundingClientRect();
    const ax = cx ?? r.left + r.width / 2;
    const ay = cy ?? r.top + r.height / 2;
    const at = toBoard(ax, ay);
    zoom = clamp(zoom * f, MIN_ZOOM, MAX_ZOOM);
    keepUnder(ax, ay, at);
    place();
  }

  /** 노래: one song card longer or shorter in time (its left edge stays); kept when it rests. */
  function stretchCard(id, f, from = null) {
    const item = board.item(id);
    if (!item || item.kind !== "song" || readOnly()) return;
    const was = stretching?.id === id ? stretching.w : from ?? item.w;
    const w = Math.round(clamp(was * f, 60, 20000));
    clearTimeout(stretching?.timer);
    if (stretching && stretching.id !== id) keepStretch();
    stretching = { id, w, timer: setTimeout(keepStretch, 450) };
    drawSoon();
  }

  /** The stretched width becomes the card's own (seen by everyone; one undo step). */
  function keepStretch() {
    const s = stretching;
    if (!s) return;
    clearTimeout(s.timer);
    stretching = null;
    const item = board.item(s.id);
    if (item && item.w !== s.w) apply(setItemOps(session.clock, board, s.id, { w: s.w }));
    else drawSoon();
  }

  /** 늘이기 / 줄이기 on the right: the chosen song card. */
  function stretchChosen(f) {
    if (!selected || board.item(selected)?.kind !== "song") return void toast(root, "늘이거나 줄일 노래 카드를 먼저 눌러 고르세요", 2600);
    stretchCard(selected, f);
  }

  /** The song card under a point, if any. */
  const songCardAt = (x, y) => document.elementFromPoint(x, y)?.closest?.(".card.song")?.dataset.id || null;

  /** 이동: every card in view. */
  function fitAll() {
    const els = [...content.querySelectorAll(".card")];
    if (!els.length) return;
    const r = surface.getBoundingClientRect();
    const v = body.getBoundingClientRect(); // the part in view
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of els) {
      const x = parseFloat(el.style.left), y = parseFloat(el.style.top);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + el.offsetWidth); y1 = Math.max(y1, y + el.offsetHeight);
    }
    zoom = clamp(Math.min((v.width - 48) / Math.max(1, x1 - x0), (v.height - 64) / Math.max(1, y1 - y0)), MIN_ZOOM, MAX_ZOOM);
    panX = v.left - r.left + (v.width - (x1 - x0) * zoom) / 2 - x0 * zoom;
    panY = v.top - r.top + 24 - y0 * zoom;
    place();
  }

  /** Moves the view just enough to show a card that stands outside it. */
  function reveal(id) {
    const el = content.querySelector(`.card[data-id="${id}"]`);
    if (!el) return;
    const r = body.getBoundingClientRect(); // the part in view
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
    boardInk?.cancelTouch();
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
      // 잇기: a line drawn from this card over others chains them in the order it passes them.
      const chain = [id];
      let line = null;
      const move = (ev) => {
        if (!mine(ev)) return;
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4 * zoom) start.moved = true;
        if (linking && start.moved && !readOnly()) {
          if (!line) {
            line = document.createElementNS(SVG, "path");
            line.setAttribute("class", "drawing chain-line");
            loops.append(line);
            const p0 = toBoard(start.x, start.y);
            line.pts = [p0.x, p0.y];
          }
          const p = toBoard(ev.clientX, ev.clientY);
          line.pts.push(p.x, p.y);
          line.setAttribute("d", loopPath(line.pts));
          const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".card")?.dataset.id;
          if (over && !chain.includes(over)) {
            chain.push(over);
            markChain(chain);
          }
          return;
        }
        if (linking || readOnly() || !start.moved) return;
        const p = at(ev);
        el.style.left = p.x * sx + "px";
        el.style.top = p.y + "px";
        drawLines({ [id]: p }); // the order lines follow the card while it moves
      };
      const stop = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", cancel);
        gesture = null;
        line?.remove();
        markChain([]);
      };
      const up = (ev) => {
        if (!mine(ev)) return;
        stop();
        // The card's ▶: a tap plays just this card, in every mode.
        if (!start.moved && e.target.closest?.(".card-play")) return void playCard(id);
        // 잇기 counts a tap, not a touch, so a pinch that starts on a card joins nothing.
        if (linking) {
          if (!start.moved) return void tapToLink(id);
          if (chain.length >= 2 && !readOnly()) linkChain(chain);
          return;
        }
        if (start.moved && !readOnly()) return void apply(setItemOps(session.clock, board, id, at(ev)));
        if (cutting && item.kind === "song" && !readOnly()) return void cutAt(id, el, ev.clientX);
        // A song card tapped again: a line where it was tapped says "here" (▶ plays from it, 분할 cuts there).
        if (item.kind === "song" && selected === id && !e.target.closest?.(".card-play")) return void setCursor(id, el, ev.clientX);
        if (item.kind === "note" && !readOnly() && (mode === "write" || (selected === id && mode === "all"))) return void write(id);
        if (cursor && cursor.id !== id) cursor = null;
        selected = id;
        draw();
      };
      const cancel = (ev) => {
        if (ev && !mine(ev)) return;
        stop();
        el.style.left = start.ix * sx + "px";
        el.style.top = start.iy + "px";
        drawLines();
      };
      gesture = cancel;
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", cancel);
    });
  }

  /** Numbers the cards a 잇기 line has passed so far (an empty list clears them). */
  function markChain(ids) {
    for (const el of content.querySelectorAll(".card[data-chain]")) if (!ids.includes(el.dataset.id)) delete el.dataset.chain;
    ids.forEach((cid, i) => {
      const el = content.querySelector(`.card[data-id="${cid}"]`);
      if (el && ids.length > 1) el.dataset.chain = String(i + 1);
    });
  }

  /** Lines between the cards in turn, one undo step; a card already led to or from is passed over. */
  function linkChain(ids) {
    const atoms = [];
    let skipped = 0;
    for (let i = 1; i < ids.length; i++) {
      const made = linkOps(session.clock, board, ids[i - 1], ids[i], session.memberId);
      if (!made.ops.length) {
        skipped++;
        continue;
      }
      session.commit("board", made.ops);
      atoms.push(...made.atoms);
    }
    record(atoms);
    linkFrom = ids[ids.length - 1];
    if (skipped) toast(root, "이미 다른 줄에 이어진 카드는 건너뛰었어요");
    draw();
  }

  function nextLineColors() {
    const order = ["rainbow", "pastel", "mine"];
    const now = settings().lineColors || "rainbow";
    setSetting(app.store, "lineColors", order[(order.indexOf(now) + 1) % order.length]);
    draw();
  }

  function tapToLink(id) {
    if (readOnly()) return;
    if (!linkFrom || linkFrom === id) {
      linkFrom = id;
      return void draw();
    }
    const made = linkOps(session.clock, board, linkFrom, id, session.memberId);
    if (made.ops.length) apply(made);
    // A card that cannot come next (it already follows a card, or it is further back on this
    // line) is where the next line starts from: tap a card, then another, to branch from it.
    else if (board.links().some((l) => l.b === id)) toast(root, "그 카드는 이미 앞에 오는 카드가 있어요. 여기서부터 이어요", 2600);
    linkFrom = id;
    draw();
  }

  // 올가미 mode: one finger (or the mouse, or a pen) draws a loop, over the cards too; a drag
  // that starts inside a loop moves the loop with the cards inside it. A tap still chooses a
  // card; a second finger zooms and draws or moves nothing.
  surface.addEventListener("pointerdown", (e) => {
    if (!lassoing() || fingers.pinching || e.button > 0 || e.target.closest(".lasso-chip")) return;
    e.stopPropagation();
    if (readOnly()) return;
    const pid = e.pointerId;
    const onCard = e.target.closest(".card")?.dataset.id || null;
    const p = toBoard(e.clientX, e.clientY);
    const holder = board.lassos().slice().reverse().find((l) => insideLoop(l.pts, p.x, p.y));
    if (holder) return void moveGroup(e, holder, onCard);
    const loop = { pts: [p.x, p.y], last: [e.clientX, e.clientY], start: [e.clientX, e.clientY], length: 0, moved: false, second: null, done: false };
    const live = document.createElementNS(SVG, "path");
    live.setAttribute("class", "drawing");
    loops.append(live);
    surface.setPointerCapture?.(pid);
    const mine = (ev) => ev.pointerId === pid;
    // Closing (the owner: "처음 부분과 끝부분이 엄청 진짜 미세하게 가깝다거나", "다른 손가락으로 한 번
    // 터치할 시에", "왼쪽 딸깍을 누르고 있다가 오른쪽 딸깍"): the end brought right back to the start
    // (SNAP px) closes it at once; so do a quick tap of a second finger and a right click while the left
    // is held. Let go anywhere else and it still closes the shortest way. A closed loop shines like neon.
    const SNAP = 14;
    const NEAR = 44;
    const LONG = 160;
    const close = () => {
      if (loop.done) return;
      loop.done = true;
      finish();
      if (!loop.moved) return;
      const before = board.lassos().map((l) => l.id);
      const made = lassoOps(session.clock, board, loop.pts, session.memberId);
      if (!made.ops.length) return void toast(root, "조금 더 크게 둘러 주세요");
      // One 올가미 at a time (the owner: "올가미 툴은 하나만"): the new one takes the old one's place.
      const gone = before.map((lid) => removeLassoOps(session.clock, board, lid));
      if (before.includes(soloLasso)) stopPlaying();
      apply({ ops: [...made.ops, ...gone.flatMap((g) => g.ops)], atoms: [...made.atoms, ...gone.flatMap((g) => g.atoms)] });
      shine(made.id);
    };
    const move = (ev) => {
      if (!mine(ev) || loop.done) return;
      if (ev.buttons & 2) return void close(); // a right click while the left is held
      if (loop.second) return; // a second finger is down: a tap closes, a pinch zooms
      if (Math.hypot(ev.clientX - loop.last[0], ev.clientY - loop.last[1]) < 5) return;
      loop.moved = true;
      loop.length += Math.hypot(ev.clientX - loop.last[0], ev.clientY - loop.last[1]);
      loop.last = [ev.clientX, ev.clientY];
      const q = toBoard(ev.clientX, ev.clientY);
      loop.pts.push(q.x, q.y);
      live.setAttribute("d", loopPath(loop.pts));
      const back = Math.hypot(ev.clientX - loop.start[0], ev.clientY - loop.start[1]);
      const near = loop.length > LONG && back < NEAR;
      live.classList.toggle("near", near);
      // Nearly closed: what it is about to hold lights up with the line ("그 애들을 포함하는 느낌").
      previewHold(near ? loop.pts : null);
      if (loop.length > LONG && back < SNAP) close();
    };
    // A second finger: lifted quickly where it came down, it closes the loop; moved, it is a pinch.
    const second = (ev) => {
      if (ev.pointerId === pid || ev.pointerType !== "touch" || loop.done) return;
      loop.second = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: performance.now() };
    };
    const secondMove = (ev) => {
      const s2 = loop.second;
      if (!s2 || ev.pointerId !== s2.id) return;
      if (Math.hypot(ev.clientX - s2.x, ev.clientY - s2.y) > 14) cancel(); // a pinch: no loop
    };
    const secondUp = (ev) => {
      const s2 = loop.second;
      if (!s2 || ev.pointerId !== s2.id) return;
      if (performance.now() - s2.t < 450 && Math.hypot(ev.clientX - s2.x, ev.clientY - s2.y) <= 14) close();
      else cancel();
    };
    const rightClick = (ev) => {
      ev.preventDefault();
      close();
    };
    const finish = () => {
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerup", up);
      surface.removeEventListener("pointercancel", cancel);
      surface.removeEventListener("pointerdown", second, true);
      window.removeEventListener("pointermove", secondMove, true);
      window.removeEventListener("pointerup", secondUp, true);
      surface.removeEventListener("contextmenu", rightClick);
      live.remove();
      previewHold(null);
      gesture = null;
    };
    const up = (ev) => {
      if (!mine(ev) || loop.done) return;
      if (!loop.moved) {
        loop.done = true;
        finish();
        selected = onCard;
        return void draw();
      }
      close();
    };
    const cancel = (ev) => {
      if (ev && ev.pointerId !== undefined && !mine(ev) && ev.pointerId !== loop.second?.id) return;
      loop.done = true;
      finish();
    };
    // Two fingers usually mean a pinch: the loop waits to see whether the second one only taps.
    gesture = () => {};
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerup", up);
    surface.addEventListener("pointercancel", cancel);
    surface.addEventListener("pointerdown", second, true);
    window.addEventListener("pointermove", secondMove, true);
    window.addEventListener("pointerup", secondUp, true);
    surface.addEventListener("contextmenu", rightClick);
  }, true);

  /** A loop just closed is the plain loop again ("원래 하던 대로"); it is the one 노래 works on now. */
  function shine(id) {
    if (!id) return;
    focusLoop = id;
    draw();
  }

  /** While a loop is nearly closed, the cards its line goes round light up with it (null: none). */
  function previewHold(pts) {
    for (const el of content.querySelectorAll(".card")) {
      const inside = !!pts && insideLoop(pts, (el.offsetLeft + el.offsetWidth / 2) / sx, el.offsetTop + el.offsetHeight / 2);
      el.classList.toggle("lasso-glow", inside);
    }
  }

  /** A loop dragged from inside: it and the cards in it move together, as one undo step. */
  function moveGroup(e, loop, onCard) {
    const pid = e.pointerId;
    const start = { x: e.clientX, y: e.clientY };
    focusLoop = loop.id;
    const held = loopHolds(loop.id);
    const cards = held.cards.map((i) => ({ id: i.id, x: i.x, y: i.y, el: content.querySelector(`.card[data-id="${i.id}"]`) }));
    const strokeIds = new Set(held.strokes);
    let moved = false;
    let dx = 0;
    let dy = 0;
    surface.setPointerCapture?.(pid);
    const mine = (ev) => ev.pointerId === pid;
    const show = () => {
      for (const c of cards) {
        if (!c.el) continue;
        c.el.style.left = (c.x + dx) * sx + "px";
        c.el.style.top = c.y + dy + "px";
      }
      loopDrag = { id: loop.id, dx, dy };
      drawLassos();
      drawLines(Object.fromEntries(cards.map((c) => [c.id, { x: c.x + dx, y: c.y + dy }])));
      // The drawings it holds show where they are going.
      boardInk.shift = strokeIds.size ? { ids: strokeIds, dx: dx * INK_UNIT, dy: dy * INK_UNIT } : null;
      inkSoon();
    };
    const move = (ev) => {
      if (!mine(ev)) return;
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      moved = true;
      dx = (ev.clientX - start.x) / (zoom * sx);
      dy = (ev.clientY - start.y) / zoom;
      show();
    };
    const finish = () => {
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerup", up);
      surface.removeEventListener("pointercancel", cancel);
      loopDrag = null;
      gesture = null;
    };
    const up = (ev) => {
      if (!mine(ev)) return;
      finish();
      if (!moved) {
        selected = onCard;
        return void draw();
      }
      const atoms = [];
      for (const c of cards) {
        const made = setItemOps(session.clock, board, c.id, { x: c.x + dx, y: c.y + dy });
        session.commit("board", made.ops);
        atoms.push(...made.atoms);
      }
      const shifted = moveLassoOps(session.clock, board, loop.id, dx, dy);
      session.commit("board", shifted.ops);
      atoms.push(...shifted.atoms);
      if (strokeIds.size) {
        const inked = moveStrokesOps(session.clock, session.doc(INK_DOC), [...strokeIds], dx * INK_UNIT, dy * INK_UNIT, session.memberId);
        session.commit(INK_DOC, inked.ops);
        atoms.push(...inked.atoms.map((a) => ({ ...a, doc: INK_DOC })));
      }
      boardInk.shift = null;
      record(atoms);
      draw();
      inkSoon();
    };
    const cancel = (ev) => {
      if (ev && !mine(ev)) return;
      finish();
      dx = 0;
      dy = 0;
      show();
      boardInk.shift = null;
      inkSoon();
      loopDrag = null;
      draw();
    };
    gesture = cancel;
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerup", up);
    surface.addEventListener("pointercancel", cancel);
  }

  surface.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".card") || e.target.closest(".badge") || e.target.closest(".lasso-chip") || fingers.pinching || lassoing() || pen.tool) return;
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
      // 글쓰기: words start where the finger was.
      if (mode === "write" && !readOnly()) writeAt(e.clientX, e.clientY);
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
    // Both fingers on the same song card in 노래: that card is stretched, not the board zoomed.
    const a = songCardAt(e.touches[0].clientX, e.touches[0].clientY);
    const card = mode === "song" && a && a === songCardAt(e.touches[1].clientX, e.touches[1].clientY) ? a : null;
    pinch = {
      d: spread(e.touches), dx: Math.abs(e.touches[0].clientX - e.touches[1].clientX), dy: Math.abs(e.touches[0].clientY - e.touches[1].clientY),
      zoom, sx, at: toBoard(mx, my), card, w: card ? widthOf(board.item(card)) : 0,
    };
    pan = null;
  }, { passive: true });
  surface.addEventListener("touchmove", (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [mx, my] = middle(e.touches);
    if (mode === "song" && pinch.card) {
      // Two fingers on one song card in 노래: spreading them sideways makes that card longer in time.
      const dx = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
      if (pinch.dx > 40) stretchCard(pinch.card, (dx / pinch.dx) * (pinch.w / (stretching?.id === pinch.card ? stretching.w : pinch.w)), pinch.w);
    } else {
      zoom = clamp(pinch.zoom * (spread(e.touches) / pinch.d), MIN_ZOOM, MAX_ZOOM);
      keepUnder(mx, my, pinch.at);
      place();
    }
  }, { passive: false });
  surface.addEventListener("touchend", (e) => {
    if (e.touches.length < 2) {
      if (pinch?.card) keepStretch();
      pinch = null;
    }
  });
  // A computer's wheel: zoom (in 노래, stretch in time; Alt zooms there); Shift moves sideways.
  surface.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.shiftKey) { panX -= e.deltaY; place(); return; }
    const f = Math.exp(-e.deltaY / 400);
    // In 노래, the wheel on a song card makes just that card longer or shorter in time; elsewhere it zooms.
    const card = mode === "song" && !e.altKey ? songCardAt(e.clientX, e.clientY) : null;
    if (card) stretchCard(card, f);
    else zoomAt(f, e.clientX, e.clientY);
  }, { passive: false });

  // ---- editing --------------------------------------------------------------------

  /** One undo step; 되돌리기 and 다시하기 say at once whether they can (a stroke draws no cards). */
  function record(atoms) {
    if (atoms.length) undo.record(atoms, { now: Date.now(), typing: false });
    toolbar.querySelector("#board-undo").disabled = !undo.canUndo;
    toolbar.querySelector("#board-redo").disabled = !undo.canRedo;
  }

  function apply(made) {
    if (!made?.ops?.length) return false;
    session.commit("board", made.ops);
    record(made.atoms);
    draw();
    return true;
  }

  function step(dir) {
    finishWriting();
    const atoms = dir === "undo" ? undo.undo() : undo.redo();
    if (!atoms) return;
    const inked = atoms.filter((a) => a.doc === INK_DOC);
    const rest = atoms.filter((a) => a.doc !== INK_DOC);
    if (inked.length) session.commit(INK_DOC, invertInkOps(session.doc(INK_DOC), session.clock, inked, dir));
    if (rest.length) session.commit("board", invertBoardOps(board, session.clock, rest, dir));
    draw();
    inkSoon();
  }

  /**
   * Where a new card goes: the first free spot in view, row by row, clear of the
   * other cards and of the tools on the right; when the view is full, right of the
   * rightmost card.
   */
  function spotFor(kind, data) {
    const r = body.getBoundingClientRect(); // the part in view
    const from = toBoard(r.left + 16, r.top + 16);
    const to = toBoard(r.right - rail.offsetWidth - 28, r.bottom - 56);
    const w = kind === "song" ? songWidth(data.dur) : 200 / sx;
    const tall = kind === "song" ? 100 : kind === "photo" ? Math.round((200 * data.h) / data.w) + 16 : 84;
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
      const r = body.getBoundingClientRect();
      return toBoard(r.left + 30, r.top + 30);
    }
    const right = items.reduce((a, b) => (b.x * sx + widthOf(b) > a.x * sx + widthOf(a) ? b : a));
    return { x: (right.x * sx + widthOf(right) + 60) / sx, y: right.y };
  }

  function placeCard(data, keep = {}) {
    if (readOnly()) return null;
    const at = spotFor("song", data);
    const made = addItemOps(session.clock, board, { kind: "song", x: at.x, y: at.y, data, by: session.memberId });
    apply(made);
    // A copied clip keeps its own speed and colour (one undo still takes the card away).
    if (Object.keys(keep).length) session.commit("board", setItemOps(session.clock, board, made.id, keep).ops);
    selected = made.id;
    draw();
    if (!at.seen) reveal(made.id);
    return made.id;
  }

  /** A picture card in view, chosen, so its menu is at hand. */
  function placePhoto({ data, w, h: tall }) {
    if (readOnly()) return;
    const at = spotFor("photo", { w, h: tall });
    const made = addItemOps(session.clock, board, { kind: "photo", x: at.x, y: at.y, data: { src: data, w, h: tall }, by: session.memberId });
    apply(made);
    selected = made.id;
    draw();
    if (!at.seen) reveal(made.id);
  }

  /** +글: words at a free spot in view, written in place. */
  function addNote() {
    if (readOnly()) return;
    const at = spotFor("note");
    newWords(at.x, at.y);
  }

  // ---- writing in place (글쓰기; the owner: "노트처럼 글 쓰는 것도 진짜 잘 되고") ----------
  // The words are written where they stand on the board, not in a sheet. A friend sees them
  // as they come. A tap outside (or Escape) ends the writing and does nothing else; words
  // left empty leave nothing behind. One undo step takes back what one writing did.

  /** 글쓰기: a tap on the empty board starts words there. */
  function writeAt(cx, cy) {
    const at = toBoard(cx, cy);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    newWords(at.x - 0.3 * rem / sx, at.y - 0.6 * rem);
  }

  function newWords(x, y) {
    const style = writeStyle();
    const made = addItemOps(session.clock, board, { kind: "note", x, y, data: { text: "" }, by: session.memberId });
    session.commit("board", made.ops);
    const look = setItemOps(session.clock, board, made.id, { color: style.color, size: style.size });
    session.commit("board", look.ops);
    draw();
    write(made.id, { fresh: true, made: [...made.atoms, ...look.atoms] });
  }

  function write(id, { fresh = false, made = [] } = {}) {
    finishWriting();
    const item = board.item(id);
    if (!item || item.removed || readOnly()) return;
    if (selected) {
      selected = null;
      draw();
    }
    const el = content.querySelector(`.card[data-id="${id}"]`);
    if (!el) return;
    const ta = h("textarea", { class: "board-typing", id: "board-typing", rows: 1, spellcheck: false, "aria-label": "보드에 쓰는 글" });
    ta.value = item.text || "";
    body.append(ta);
    el.classList.add("writing");
    const state = { id, ta, el, fresh, made, before: item.text || "", timer: 0, stop: null };
    writer = state;
    placeWriter();
    ta.addEventListener("input", () => {
      fitWriter();
      clearTimeout(state.timer);
      state.timer = setTimeout(() => sendWords(state), 250);
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finishWriting();
      }
    });
    state.stop = closeOnOutside((t) => ta.contains(t) || !!t.closest?.("#write-colors"), () => finishWriting(), ta);
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  /** The words so far, to everyone (not an undo step of their own). */
  function sendWords(state) {
    const item = board.item(state.id);
    if (!item || item.removed || (item.text || "") === state.ta.value) return;
    session.commit("board", setItemOps(session.clock, board, state.id, { text: state.ta.value }).ops);
  }

  function finishWriting() {
    const state = writer;
    if (!state) return;
    writer = null;
    clearTimeout(state.timer);
    state.stop?.();
    const text = state.ta.value;
    state.ta.remove();
    state.el.classList.remove("writing");
    const item = board.item(state.id);
    if (!item || item.removed) return void draw();
    if (!text.trim()) {
      // Nothing written: no empty words stay on the board.
      const gone = removeItemOps(session.clock, board, state.id);
      if (state.fresh) session.commit("board", gone.ops);
      else apply({ ops: [...setItemOps(session.clock, board, state.id, { text: "" }).ops, ...gone.ops], atoms: [{ k: "set", item: state.id, prev: { text: state.before }, next: { text: "" } }, ...gone.atoms] });
      return void draw();
    }
    if ((item.text || "") !== text) session.commit("board", setItemOps(session.clock, board, state.id, { text }).ops);
    if (state.fresh) record([...state.made, { k: "set", item: state.id, prev: { text: "" }, next: { text } }]);
    else if (text !== state.before) record([{ k: "set", item: state.id, prev: { text: state.before }, next: { text } }]);
    draw();
  }

  /** The writing lies over its words, in their size and colour, however the board is zoomed. */
  function placeWriter() {
    const state = writer;
    if (!state) return;
    const words = state.el.querySelector(".card-text") || state.el;
    const area = body.getBoundingClientRect();
    const r = words.getBoundingClientRect();
    const css = getComputedStyle(words);
    const ta = state.ta;
    ta.style.left = r.left - area.left + "px";
    ta.style.top = r.top - area.top + "px";
    ta.style.width = Math.max(r.width, 120 * zoom) + 4 + "px";
    ta.style.fontSize = parseFloat(css.fontSize) * zoom + "px";
    ta.style.fontWeight = css.fontWeight;
    ta.style.lineHeight = css.lineHeight === "normal" ? "1.45" : parseFloat(css.lineHeight) * zoom + "px";
    ta.style.color = css.color;
    fitWriter();
  }

  function fitWriter() {
    const ta = writer?.ta;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = ta.scrollHeight + "px";
  }

  function setWriteStyle(patch) {
    setSetting(app.store, "boardText", { ...writeStyle(), ...patch });
    if (writer) {
      apply(setItemOps(session.clock, board, writer.id, patch));
      placeWriter();
    }
    drawRail();
  }

  function writeColorButton() {
    const b = railButton("write-color", null, "글 색", () => openWriteColors(b), { text: "가" });
    b.querySelector(".rail-text").style.color = inkColor(writeStyle().color);
    return b;
  }

  /** 글 색: eight dots beside the rail (small, so they cover little). */
  function openWriteColors(anchor) {
    closeExtra?.();
    const now = writeStyle().color;
    const box = h("div", { class: "clip-menu card-menu write-colors", id: "write-colors", role: "toolbar", "aria-label": "글 색" },
      INK_COLORS.map((c) => h("button", { type: "button", class: "menu-dot", data: { writeColor: c }, "aria-label": "글 색", "aria-pressed": String(now === c), style: { background: inkColor(c) },
        onpointerdown: (e) => e.preventDefault(),
        onclick: (e) => { e.stopPropagation(); close(); setWriteStyle({ color: c }); } })));
    body.append(box);
    const area = body.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    box.style.left = Math.max(6, r.left - area.left - box.offsetWidth - 8) + "px";
    box.style.top = Math.max(4, r.top - area.top) + "px";
    let open = true;
    const stopGuard = closeOnOutside((t) => box.contains(t) || anchor.contains(t), () => close(), box);
    function close() {
      if (!open) return;
      open = false;
      stopGuard();
      box.remove();
      if (closeExtra === close) closeExtra = null;
    }
    closeExtra = close;
  }

  function addSong() {
    const group = clipboardItem(app.store, "board-items");
    if (group) return void pasteGroup(group.items, { strokes: group.strokes || [] });
    const item = clipboardItem(app.store, "song-clip");
    if (!item) return void toast(root, "노래 방에서 클립을 '복사'하면 여기에 붙일 수 있어요. '내 노래'에서 골라도 돼요.", 4200);
    const data = cardFromClip(item);
    placeCard(data, keptFields("song", item, data));
  }

  /** 붙이기 of cards copied with a loop: they keep their places to each other, in view, as one undo step. */
  /** Copied cards (and drawings) put down together, as one undo step: in view, or at `at`. */
  function pasteGroup(list, { strokes = [], at = null, quiet = false } = {}) {
    if (readOnly() || !Array.isArray(list) || (!list.length && !strokes.length)) return null;
    if (!at) {
      const r = body.getBoundingClientRect();
      at = toBoard(r.left + 24, r.top + 24);
    }
    const atoms = [];
    const items = [];
    for (const it of list) {
      const made = addItemOps(session.clock, board, { kind: it.kind, x: Math.round(at.x + it.dx), y: Math.round(at.y + it.dy), data: it.data, by: session.memberId });
      if (!made.ops.length) continue;
      session.commit("board", made.ops);
      atoms.push(...made.atoms);
      items.push({ id: made.id, x: Math.round(at.x + it.dx), y: Math.round(at.y + it.dy) });
      // Its looks come along: ink colour and size, own colour, speed, mute.
      const keep = keptFields(it.kind, it, it.data);
      if (Object.keys(keep).length) session.commit("board", setItemOps(session.clock, board, made.id, keep).ops);
    }
    for (const l of strokes) {
      const pts = l.pts.map((v, k) => (k % 3 === 0 ? Math.round(v + at.x * INK_UNIT) : k % 3 === 1 ? Math.round(v + at.y * INK_UNIT) : v));
      const made = strokeOps(session.clock, session.doc(INK_DOC), { pts, color: l.c, width: l.w, by: session.memberId, brush: l.b || "pen" });
      session.commit(INK_DOC, made.ops);
      atoms.push(...made.atoms.map((a) => ({ ...a, doc: INK_DOC })));
    }
    if (quiet) {
      draw();
      inkSoon();
      return { atoms, items, strokes: strokes.length };
    }
    record(atoms);
    draw();
    inkSoon();
    toast(root, `${items.length + strokes.length}개를 붙였어요`);
    return { atoms, items, strokes: strokes.length };
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
      kind: "song-clip", room: session.roomId, src: id, offset: 0, length: d.dur, speed: board.item(id).speed || 1, tint: board.item(id).tint ?? null,
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
            h("span", { class: "slot-what", text: s ? s.name || `줄 ${s.pairs.length}개` : "비어 있음" }),
            s && h("button", { type: "button", class: "chip", id: "slot-use-" + n, text: "불러오기", onclick: () => { apply(useSlotOps(session.clock, board, n, session.memberId)); close(); } }),
            !readOnly() && h("button", { type: "button", class: "chip", id: "slot-save-" + n, text: "저장", onclick: () => { apply(saveSlotOps(session.clock, board, n, session.memberId)); draw(); paint(); toast(root, n + "번 칸에 지금 순서를 담았어요"); } }));
        }),
        count < 9 && h("button", { type: "button", class: "chip slot-more", id: "slot-more", text: "+ 칸", onclick: () => { count++; paint(); } }));
    };
    paint();
    const top = anchor ? anchor.getBoundingClientRect().top - body.getBoundingClientRect().top : 8;
    menu.style.top = Math.max(8, top) + "px";
    body.append(menu);
    let stopGuard = () => {};
    setTimeout(() => { if (open) stopGuard = closeOnOutside((t) => menu.contains(t) || t === anchor || !!anchor?.contains(t), () => close(), menu); }, 0);
    let open = true;
    function close() {
      if (!open) return;
      open = false;
      menu.remove();
      stopGuard();
      if (closeExtra === close) closeExtra = null;
    }
    closeExtra = close;
  }

  // ---- the mode bar: moved by a long press, set up as one likes ------------------------------

  /** A long press lifts el (a buzz); dragged, it follows the finger and is put down where it is let
   *  go (onDrop gets that point); held still and let go, onHold. A short tap stays a tap, and a
   *  second finger before the lift is a pinch, not a lift. */
  function wireLift(el, { onDrop, onHold }) {
    let hold = null;
    const reset = () => { el.classList.remove("lifting"); el.style.transform = ""; };
    el.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      if (hold) {
        if (!hold.lifted) { clearTimeout(hold.timer); hold = null; }
        return;
      }
      const start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      hold = { start, lifted: false, moved: false, timer: setTimeout(() => {
        if (!hold) return;
        hold.lifted = true;
        el.classList.add("lifting");
        try { el.setPointerCapture?.(start.id); } catch {}
        buzz();
      }, 450) };
    });
    el.addEventListener("pointermove", (e) => {
      if (!hold || e.pointerId !== hold.start.id) return;
      const dx = e.clientX - hold.start.x;
      const dy = e.clientY - hold.start.y;
      if (!hold.lifted) {
        if (Math.hypot(dx, dy) > 8) { clearTimeout(hold.timer); hold = null; }
        return;
      }
      if (Math.hypot(dx, dy) > 8) hold.moved = true;
      el.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    el.addEventListener("pointerup", (e) => {
      if (!hold || e.pointerId !== hold.start.id) return;
      clearTimeout(hold.timer);
      const was = hold;
      hold = null;
      if (!was.lifted) return;
      reset();
      // A long press is not a tap on what it lifted.
      swallowPress(e);
      if (!was.moved) return void onHold();
      onDrop(e.clientX, e.clientY);
      buzz();
    });
    el.addEventListener("pointercancel", (e) => {
      if (!hold || e.pointerId !== hold.start.id) return;
      clearTimeout(hold.timer);
      hold = null;
      reset();
    });
  }

  /** The mode bar goes to the edge nearest where it is let go. */
  function wireBarMove(bar) {
    wireLift(bar, {
      onHold: () => openBarSettings(),
      onDrop: (x, y) => {
        const room = body.closest(".room").getBoundingClientRect();
        const d = { top: y - room.top, bottom: room.bottom - y, left: x - room.left, right: room.right - x };
        setSetting(app.store, "boardModesAt", Object.entries(d).sort((p, q) => p[1] - q[1])[0][0]);
        buildModes();
        measureInsets();
      },
    });
  }

  // The tools on the right move too (the owner chose "오른쪽 도구도 직접 옮기기"): held and let go
  // on the left half, they stand on the left.
  wireLift(rail, {
    onHold: () => openBarSettings(),
    onDrop: (x) => {
      const room = body.closest(".room").getBoundingClientRect();
      setSetting(app.store, "boardRailAt", x < room.left + room.width / 2 ? "left" : "right");
      buildModes();
      measureInsets();
      draw();
    },
  });

  /** 막대 꾸미기: where the bar stands, its size, words or icons, the order and which modes show. */
  function openBarSettings() {
    closeExtra?.();
    openSheet(root, "막대 꾸미기", (panel) => {
      const set = (key, value) => { setSetting(app.store, key, value); buildModes(); measureInsets(); paint(); draw(); };
      const list = h("div", { class: "bar-order", id: "bar-order" });
      const paint = () => {
        const look = barLook();
        list.replaceChildren(...look.order.map((k, i) => {
          const [, name] = MODE_LIST.find(([m]) => m === k);
          const move = (by) => {
            const order = look.order.slice();
            const j = i + by;
            if (j < 0 || j >= order.length) return;
            [order[i], order[j]] = [order[j], order[i]];
            set("boardModesOrder", order);
          };
          return h("div", { class: "bar-order-row", data: { mode: k } },
            h("span", { class: "bar-order-name", text: name }),
            h("button", { type: "button", class: "chip", id: "bar-up-" + k, text: "↑", "aria-label": name + " 앞으로", disabled: i === 0, onclick: () => move(-1) }),
            h("button", { type: "button", class: "chip", id: "bar-down-" + k, text: "↓", "aria-label": name + " 뒤로", disabled: i === look.order.length - 1, onclick: () => move(1) }),
            k !== "all" && h("button", { type: "button", class: "chip", id: "bar-show-" + k, "aria-pressed": String(!look.hidden.has(k)), text: look.hidden.has(k) ? "숨김" : "보임", onclick: () => {
              const hidden = new Set(look.hidden);
              if (hidden.has(k)) hidden.delete(k);
              else {
                hidden.add(k);
                if (mode === k) setMode("all");
              }
              set("boardModesHidden", [...hidden]);
            } }));
        }));
      };
      const look = barLook();
      panel.append(h("div", { class: "form", id: "bar-settings" },
        h("div", { class: "row" }, h("span", { class: "label", text: "자리 (막대를 꾹 눌러 끌어도 돼요)" }),
          segmented([["top", "위", "bar-at-top"], ["bottom", "아래", "bar-at-bottom"], ["left", "왼쪽", "bar-at-left"], ["right", "오른쪽", "bar-at-right"]], look.at, (v) => set("boardModesAt", v), "barAt")),
        h("div", { class: "row" }, h("span", { class: "label", text: "크기" }),
          segmented([["1", "작게", "bar-size-1"], ["2", "보통", "bar-size-2"], ["3", "크게", "bar-size-3"]], String(look.size), (v) => set("boardBarSize", Number(v)), "barSize")),
        h("div", { class: "row" }, h("span", { class: "label", text: "보기" }),
          segmented([["words", "글자", "bar-words"], ["icons", "아이콘만", "bar-icons"]], look.icons ? "icons" : "words", (v) => set("boardModesIcons", v === "icons"), "barLook")),
        h("div", { class: "row" }, h("span", { class: "label", text: "모드 도구 자리 (꾹 눌러 끌어도 돼요)" }),
          segmented([["auto", "자동", "rail-auto"], ["left", "왼쪽", "rail-left"], ["right", "오른쪽", "rail-right"]], look.rail, (v) => set("boardRailAt", v), "railAt")),
        h("div", { class: "row" }, h("span", { class: "label", text: "순서와 보이기" }), list),
        h("button", { type: "button", class: "btn quiet", id: "bar-reset", text: "처음대로", onclick: () => {
          for (const key of ["boardModesAt", "boardBarSize", "boardModesIcons", "boardRailAt", "boardModesOrder", "boardModesHidden"]) setSetting(app.store, key, undefined);
          buildModes();
          measureInsets();
          paint();
        } })));
      paint();
    });
  }

  // ---- 순서 목록 (the first description's 노래 잇기 창) ------------------------------------
  // "잠시 다른 창으로 넘어와서… 왼쪽부터 녹음했던 음들이 한 줄에 쭉… 순서를 내 마음대로 바꿀 수
  // 있어… 순서의 이어짐을 저장할 수 있는… 1, 2, 3… 왔다 갔다 하면서 들어볼 수 있고". The order
  // now as one row of the song cards (a drag puts one elsewhere: the lines follow, one undo step),
  // heard, saved, sent to a song room; and every saved order with its name, heard without bringing
  // it back, brought back, copied, sent.

  function openOrderList() {
    closeExtra?.();
    openSheet(root, "순서 목록", (panel, close, onClose) => {
      const strip = h("div", { class: "order-strip", id: "order-strip" });
      const saved = h("div", { class: "order-saved", id: "order-saved" });
      const can = !readOnly();
      const lenOf = (card) => (card.data.dur / (card.speed || 1) / 1000).toFixed(1) + "초";
      const paintStrip = () => {
        const order = playOrder(board);
        strip.replaceChildren(...(order.length ? order.map((card, i) => {
          const chip = h("div", { class: "order-chip", data: { id: card.id }, style: { "--c": card.tint != null ? memberColor(card.tint, currentTheme()) : colorOf(card.by) } },
            h("b", { class: "order-n", text: String(i + 1) }), h("span", { class: "order-name", text: cardTitle(card.data) }), h("span", { class: "order-len", text: lenOf(card) }));
          if (can) dragToReorder(chip, card.id);
          return chip;
        }) : [h("p", { class: "help", text: "노래 카드가 아직 없어요." })]));
      };
      // A chip held and moved goes where the finger lets go; the cards then play in that order.
      const dragToReorder = (chip, id) => {
        chip.addEventListener("pointerdown", (e) => {
          if (e.button > 0) return;
          chip.setPointerCapture?.(e.pointerId);
          const start = { x: e.clientX, y: e.clientY };
          let moving = false;
          const move = (ev) => {
            if (!moving && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) {
              moving = true;
              chip.classList.add("lifted");
              buzz();
            }
            if (moving) chip.style.transform = `translate(${ev.clientX - start.x}px, ${ev.clientY - start.y}px)`;
          };
          const up = (ev) => {
            chip.removeEventListener("pointermove", move);
            chip.removeEventListener("pointerup", up);
            chip.removeEventListener("pointercancel", up);
            chip.classList.remove("lifted");
            chip.style.transform = "";
            if (!moving || ev.type === "pointercancel") return;
            const others = [...strip.querySelectorAll(".order-chip")].filter((c) => c !== chip);
            const at = others.findIndex((c) => {
              const r = c.getBoundingClientRect();
              return ev.clientY < r.top || (ev.clientY < r.bottom && ev.clientX < r.left + r.width / 2);
            });
            const ids = others.map((c) => c.dataset.id);
            ids.splice(at < 0 ? ids.length : at, 0, id);
            apply(orderOps(session.clock, board, ids, session.memberId));
          };
          chip.addEventListener("pointermove", move);
          chip.addEventListener("pointerup", up);
          chip.addEventListener("pointercancel", up);
        });
      };
      const paintSaved = () => {
        const list = board.slots();
        saved.replaceChildren(...(list.length ? list.map((s) => {
          const order = slotOrder(board, s.n);
          return h("div", { class: "order-row", data: { n: String(s.n) } },
            h("span", { class: "slot-n", text: String(s.n) }),
            h("span", { class: "order-row-name", text: s.name || `순서 ${s.n}` }),
            h("span", { class: "order-len", text: `곡 ${order.length}개` }),
            h("div", { class: "order-row-actions" },
              h("button", { type: "button", class: "chip", id: "order-play-" + s.n, text: "▶", "aria-label": "이 순서로 듣기", onclick: () => playCards(order) }),
              can && h("button", { type: "button", class: "chip", id: "order-use-" + s.n, text: "불러오기", onclick: () => { apply(useSlotOps(session.clock, board, s.n, session.memberId)); toast(root, `'${s.name || "순서 " + s.n}'을(를) 불러왔어요`); } }),
              can && h("button", { type: "button", class: "chip", id: "order-rename-" + s.n, text: "이름", onclick: () => renameSlot(s) }),
              can && h("button", { type: "button", class: "chip", id: "order-copy-" + s.n, text: "복제", onclick: () => copySlot(s) }),
              can && order.length > 0 && h("button", { type: "button", class: "chip", id: "order-send-" + s.n, text: "보내기", onclick: () => sendToSongRoom(order) })));
        }) : [h("p", { class: "help", text: "저장한 순서가 없어요. 지금 순서를 저장해 두면 왔다 갔다 하며 들어볼 수 있어요." })]));
      };
      const renameSlot = (s) => {
        const row = saved.querySelector(`.order-row[data-n="${s.n}"]`);
        const input = h("input", { class: "input", id: "order-name-input", value: s.name || "", maxlength: "30", placeholder: `순서 ${s.n}`, "aria-label": "순서 이름" });
        let over = false;
        const done = () => {
          if (over) return;
          over = true;
          const name = input.value.trim();
          if (name !== (s.name || "")) apply(nameSlotOps(session.clock, board, s.n, name, session.memberId));
          paintSaved();
        };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(); });
        input.addEventListener("blur", done);
        row.querySelector(".order-row-name").replaceWith(input);
        input.focus();
      };
      const freeSlot = () => {
        const used = new Set(board.slots().map((s) => s.n));
        for (let n = 1; n <= 9; n++) if (!used.has(n)) return n;
        return null;
      };
      const copySlot = (s) => {
        const n = freeSlot();
        if (!n) return void toast(root, "순서는 9개까지 저장해요");
        // The same lines into the next free slot, under the same name with "복사".
        session.clock.atLeast(board.maxN);
        session.commit("board", [{ t: "slot", id: session.clock.next(), n, pairs: s.pairs, by: session.memberId, name: ((s.name || `순서 ${s.n}`) + " 복사").slice(0, 30) }]);
        draw();
      };
      panel.append(
        h("p", { class: "help", text: can ? "지금 재생 순서예요. 꾹 눌러 끌면 순서가 바뀌어요." : "지금 재생 순서예요." }),
        strip,
        h("div", { class: "order-actions" },
          h("button", { type: "button", class: "btn", id: "order-play", onclick: () => playCards(playOrder(board)) }, "▶ 이 순서로 듣기"),
          can && h("button", { type: "button", class: "btn quiet", id: "order-save", onclick: () => {
            const n = freeSlot();
            if (!n) return void toast(root, "순서는 9개까지 저장해요");
            apply(saveSlotOps(session.clock, board, n, session.memberId, `순서 ${n}`));
            toast(root, `순서 ${n}에 저장했어요`);
          } }, "지금 순서 저장"),
          can && h("button", { type: "button", class: "btn quiet", id: "order-send", onclick: () => sendToSongRoom(playOrder(board)) }, "노래 방으로 보내기")),
        h("div", { class: "section" }, h("p", { class: "section-title", text: "저장한 순서" }), saved));
      paintStrip();
      paintSaved();
      onClose(session.on("change", ({ doc }) => {
        if (doc !== "board") return;
        paintStrip();
        if (!saved.querySelector("#order-name-input")) paintSaved();
      }));
    });
  }

  /** A short buzz where the phone can (a card lifted, a place taken), unless 진동 is off. */
  const buzz = (ms = 8) => buzzOnce(app, ms);

  /** Song cards played back to back (an order from the list), from the start; again stops. */
  async function playCards(cards) {
    if (player?.playing) return void stopPlaying();
    if (!cards.length) return void toast(root, "재생할 노래 카드가 없어요");
    const ctx = await audioContext();
    if (!ctx) return;
    const song = cardsSong(cards);
    if (!(await makePlayer(song, await recordingsOf(song, ctx)))) return;
    player.play(0);
    const ends = [];
    let at = 0;
    for (const card of cards) ends.push([card.id, (at += Math.round(card.data.dur / (card.speed || 1)))]);
    follow(ends);
    draw();
  }

  /** 노래 방으로 보내기: these song cards, in this order, back to back on one row of a song room of mine. */
  function sendToSongRoom(cards) {
    if (!cards.length) return void toast(root, "보낼 노래 카드가 없어요");
    openSheet(root, "어느 노래 방으로 보낼까요?", (panel, close) => {
      const wait = h("p", { class: "help", text: "노래 방을 찾는 중…" });
      panel.append(wait);
      reachableRooms(app, ["creative-song"]).then(({ mine, others }) => {
        wait.remove();
        if (!mine.length && !others.length) return void panel.append(h("p", { class: "help", id: "no-song-rooms", text: "노래 방이 아직 없어요. 홈의 창작 +에서 만들 수 있어요." }));
        const pick = (r) => h("button", { class: "kind", type: "button", data: { songRoom: r.id }, onclick: async () => {
          close();
          showStatus("보내는 중…");
          try {
            const n = await putCardsIntoSong(app, r, cards, session.me);
            toast(root, `'${r.name || "노래 방"}'에 ${n}곡을 순서대로 보냈어요`);
          } catch (err) {
            console.warn(err);
            toast(root, "보내지 못했어요. 그 노래 방을 한 번 열었다가 다시 해 주세요.", 3600);
          } finally {
            showStatus(null);
          }
        } }, h("span", { class: "kind-name", text: r.name || "노래 방" }));
        panel.append(h("div", { class: "kinds", id: "send-song-rooms" }, mine.map(pick)));
        if (others.length) panel.append(h("p", { class: "group-label", text: "다른 기기에서 만든 방" }), h("div", { class: "kinds" }, others.map(pick)));
      });
    });
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
        return { data: cardFromClip({ source, offset: clip.offset, length: clip.length }), label: src.name || "녹음 " + (i + 1), keep: { speed: clip.speed, tint: clip.tint } };
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
    const pick = (data, label, keep = null) => h("button", { type: "button", class: "song-pick", onclick: () => { close(); placeCard(data, keptFields("song", keep, data)); } },
      h("span", { class: "pick-head" }, h("span", { class: "pick-name", text: label }), h("span", { class: "pick-len", text: (data.dur / 1000).toFixed(1) + "초" })),
      noteBars(data, "pick-notes"));
    const copied = clipboardItem(app.store, "song-clip");
    if (copied) list.append(h("div", { class: "drawer-section" }, h("p", { class: "drawer-group", text: "복사한 클립" }), pick(cardFromClip(copied), copied.source?.name || "복사한 클립", copied)));
    // My song rooms here, then the ones made on my other devices (home lists those too).
    const remembered = app.store.get("rooms", []).filter((r) => r.kind === "creative-song").sort((a, b) => b.at - a.at);
    const rooms = remembered.slice();
    (async () => {
      for (const extra of (await reachableRooms(app, ["creative-song"])).others) rooms.push(extra);
      if (!open) return;
      if (!rooms.length && !copied) list.append(h("p", { class: "help", text: `아직 노래 방이 없어요. ${toolSide()} '소리 넣기'로 여기에 바로 넣어도 돼요.` }));
      for (const room of rooms) {
        const wait = h("p", { class: "help", text: "불러오는 중…" });
        const box = h("div", { class: "drawer-section" }, h("p", { class: "drawer-room", text: room.name }), wait);
        list.append(box);
        const found = await songsOf(room).catch(() => null);
        if (!open) return;
        wait.replaceWith(found === null ? h("p", { class: "help", text: "이 방을 열지 못했어요" })
          : found.length ? h("div", { class: "drawer-picks" }, found.map(({ data, label, keep }) => pick(data, label, keep)))
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
      return void micRefused({ app, root, err, retry: () => startRecording() });
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
    // A soft take (the phone far away) is made loud enough to hear.
    samples = louder(samples).samples;
    const result = await analyzeSamples(samples, rate, { onProgress: (p) => showStatus(`음을 찾는 중… ${Math.round(p * 100)}%`) });
    const kept = rate === KEEP_RATE ? samples : resample(samples, rate, KEEP_RATE);
    const blob = newBlobId();
    await app.blobs.put(blob, encodeWav(kept, KEEP_RATE), "audio/wav");
    placeCard(songCardData({ duration: result.duration, notes: result.notes, peaks: toBase64(result.peaks), name: name || undefined, blob }));
    keepTake(app, { name, result, blob, where: takeWhere(app, session.roomId) });
    if (!result.notes.length) toast(root, "음을 찾지 못했어요. 원본으로 들을 수 있어요", 3600);
  }

  // ---- playing ----------------------------------------------------------------------

  async function makePlayer(song, audio) {
    const ctx = await audioContext();
    if (!ctx) return null;
    player?.close();
    const s = settings();
    player = new SongPlayer(ctx, { song: () => song, audioFor: (id) => audio.get(id) || null, onEnd: () => {
      // 반복: a loop that should go round again starts over (only a play that reached its end comes here).
      const again = soloLasso && repeating.has(soloLasso) && board.lassos().some((l) => l.id === soloLasso) ? soloLasso : null;
      playing = null;
      solo = null;
      soloLasso = null;
      draw();
      if (again && alive) playLasso(again);
    } });
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
    soloLasso = null;
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
    // In 노래 with a loop in hand, 전체 재생 is that part.
    if (mode === "song" && focusLoop && !focusOff && board.lassos().some((l) => l.id === focusLoop)) return void playLasso(focusLoop);
    const order = playOrder(board);
    if (!order.length) return void toast(root, "재생할 노래 카드가 없어요");
    const ctx = await audioContext();
    if (!ctx) return;
    const song = boardSong(board);
    if (!(await makePlayer(song, await recordingsOf(song, ctx)))) return;
    player.play(0);
    const ends = [];
    let at = 0;
    for (const card of order) ends.push([card.id, (at += Math.round(card.data.dur / (card.speed || 1)))]);
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
    // From the position line when it stands on this card, else from the start (its own speed counted).
    const sp = card.speed || 1;
    player.play(cursor?.id === id ? Math.min(cursor.ms, card.data.dur - 1) / sp : 0);
    follow([[id, Math.round(card.data.dur / sp)]]);
    draw();
  }

  /**
   * 노래 works on the last-used loop's part only ("노래 모드에서 그 올가미 선택한 부분만"): the rest dims and
   * 전체 재생 plays that part; a loop just closed lights up what it holds.
   */
  function drawLoopMarks() {
    const all = board.lassos();
    if (focusLoop && !all.some((l) => l.id === focusLoop)) focusLoop = null;
    const focusing = mode === "song" && !!focusLoop && !focusOff;
    const inFocus = focusing ? new Set(itemsInLoop(board, focusLoop).map((c) => c.id)) : null;
    content.classList.toggle("focus", focusing);
    for (const el of content.querySelectorAll(".card")) el.classList.toggle("in-focus", !!inFocus?.has(el.dataset.id));
  }

  /** Shows the position line (and its time) on the chosen song card, and a light tick each second while chosen. */
  function drawCursor() {
    if (cursor && (cursor.id !== selected || !board.item(cursor.id) || board.item(cursor.id).removed)) cursor = null;
    for (const el of content.querySelectorAll(".card.song")) {
      const item = board.item(el.dataset.id);
      const notes = el.querySelector(".card-notes");
      if (!item || !notes) continue;
      const chosen = item.id === selected;
      notes.classList.toggle("ticks", chosen);
      // A tick each second as it sounds (at 2× a second of the card is two seconds of the take).
      if (chosen) notes.style.setProperty("--sec", (100000 * (item.speed || 1) / Math.max(1, item.data.dur)) + "%");
      let line = notes.querySelector(".card-cursor");
      if (cursor?.id !== item.id) {
        line?.remove();
        continue;
      }
      if (!line) notes.append(line = h("i", { class: "card-cursor", "aria-hidden": "true" }, h("b", { class: "card-cursor-time" })));
      line.style.left = (cursor.ms / item.data.dur) * 100 + "%";
      line.firstChild.textContent = (Math.floor(cursor.ms / (item.speed || 1) / 100) / 10).toFixed(1) + "초";
    }
  }

  /** The position line on a chosen song card: where the finger came down, in the card's own time. */
  function setCursor(id, el, clientX) {
    const item = board.item(id);
    const area = el.querySelector(".card-notes") || el;
    const r = area.getBoundingClientRect();
    if (!item || !r.width) return;
    const ratio = clamp((clientX - r.left) / r.width, 0, 1);
    cursor = { id, ms: Math.round(ratio * item.data.dur) };
    draw();
  }

  /** 분할 at the position line. */
  function cutAtMs(id, ms) {
    const made = splitCardOps(session.clock, board, id, ms, session.memberId);
    cursor = null;
    if (!made.ops.length) {
      toast(root, "끝에 너무 가까워서 자를 수 없어요");
      return void draw();
    }
    apply(made);
    selected = made.ids[0];
    draw();
  }

  /** A loop's ▶: only the song cards inside, in their order (lines first, then from the left). Again stops. */
  async function playLasso(id) {
    if (player?.playing) {
      const was = soloLasso;
      stopPlaying();
      if (was === id) return;
    }
    const order = lassoOrder(board, id);
    if (!order.length) return void toast(root, "올가미 안에 노래 카드가 없어요");
    const ctx = await audioContext();
    if (!ctx) return;
    const song = cardsSong(order);
    if (!(await makePlayer(song, await recordingsOf(song, ctx)))) return;
    soloLasso = id;
    player.play(0);
    const ends = [];
    let at = 0;
    for (const card of order) ends.push([card.id, (at += Math.round(card.data.dur / (card.speed || 1)))]);
    follow(ends);
    draw();
  }

  const offs = [
    session.on("change", ({ doc }) => {
      if (doc === "board" || doc === "room") draw();
      if (doc === INK_DOC) inkSoon();
    }),
    onThemeChange(draw),
  ];
  session.load("board").then(draw);
  session.load(INK_DOC).then(() => inkSoon());
  buildModes();
  measureInsets();
  draw();

  return {
    /** 레퍼런스 → 이 방에 붙이기, a recording: a song card (its sound is already on this device). */
    insertSound(memo) {
      placeCard(songCardData({ duration: memo.dur, notes: memo.notes, peaks: memo.peaks, name: memo.name, blob: memo.blob }));
    },
    /** 레퍼런스 → 이 방에 붙이기: a memo card. */
    insertText(text) {
      const at = spotFor("note");
      apply(addItemOps(session.clock, board, { kind: "note", x: at.x, y: at.y, data: { text }, by: session.memberId }));
    },
    close() {
      finishWriting();
      alive = false;
      insetWatch.disconnect();
      boardInk?.destroy();
      inkTools.remove();
      roomEl?.style.removeProperty("--top-inset");
      roomEl?.style.removeProperty("--bottom-inset");
      cancelAnimationFrame(frameReq);
      closeExtra?.();
      menu?.stopGuard?.();
      menu?.remove();
      editor?.close();
      stopPickers();
      stopPhotoWatch();
      fingers.stop();
      player?.close();
      for (const off of offs) off();
      toolbar.remove();
      frame.top.replaceChildren();
      body.classList.remove("board-body");
    },
  };
}
