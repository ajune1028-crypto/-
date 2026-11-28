// 애니메이션 방: a flipbook drawn together. From the reference study (specs/2026-11-20-reference-study.md
// §3): FlipaClip's strip of frames along the bottom; onion skin (the frame before faintly in red, the
// one after in green, as Krita and Toon Boom show them); ▶ at a speed (12 a second at first, as
// animators draw "on twos") that loops, goes back and forth, or plays once; a frame held for longer
// (Procreate's hold, OpenToonz's exposure) shown wider in the strip; a frame copied to change a
// little, the animator's way. Friends draw on whichever frame they like at the same time: the strip
// shows where each of them is, and their lines appear live on the frame they share. Each frame is its
// own drawing, with the same brushes, gestures and live lines as 그림 방.

import { rollTo } from "./motion.js";
import { h, icon, iconButton, toast, flashHint, closeOnOutside, mount } from "./dom.js";
import { InkLayer, drawInkTools, paintStroke, lassoActions, fixedInk, landInk, boardStrokesCarried, keepRailBetween, watchPick } from "./ink.js";
import { copyItem } from "../clipboard.js";
import { LiveInk } from "./live-ink.js";
import { watchFingerTaps, toggleBare } from "./fingers.js";
import { pageStage } from "./page-stage.js";
import { releasePieces } from "./ink-pieces.js";
import { PAGE_W, PAGE_H } from "./draw-room.js";
import { addFrameOps, setFrameOps, removeFrameOps, moveFrameOps, setAnimOps, invertAnimOps, frameDocOf, frameAt, timeline, onePass, FPS_CHOICES, LOOPS, MAX_FRAMES, MAX_HOLD } from "../core/anim.js";
import { strokeOps, eraseOps, invertInkOps, brushOf, widthOf, moveStrokesOps, opacityOf } from "../core/ink.js";
import { PAPERS } from "../core/draw.js";
import { ColourCount, GifWriter, gifDelays } from "../core/gif.js";
import { UndoStack } from "../core/undo.js";
import { getSettings, setSetting, roomEntry } from "../identity.js";
import { buzz } from "./chime.js";
import { memberColor, personColor } from "../core/paint.js";
import { currentTheme } from "./theme.js";

const ONION = { before: "#e5484d", after: "#2f9e5b" };
const LOOP_NAMES = { loop: "반복", pingpong: "왕복", once: "한 번" };
const MAX_PIXELS = 3.2e6;
// 배경: one drawing beneath every frame (Procreate's background frame): drawn once, it is under each
// frame as it is drawn, played, shown small and saved.
const BG = "bg";
const paperColour = (key) => (PAPERS.find(([k]) => k === key) || PAPERS[0])[1];
// A GIF this wide: plenty for a chat (it shows a few hundred points wide there) and a small file.
const GIF_W = 480;
const canRecord = () => typeof HTMLCanvasElement !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function" && typeof window.MediaRecorder === "function";

export function mountAnimRoom(body, app, session) {
  const root = app.root;
  const doc = session.doc("anim");
  const undo = new UndoStack(100, 0);
  const readOnly = () => !!session.transport.readOnly;
  let alive = true;
  let current = null; // the frame I draw on
  let playing = null;
  const pen = { tool: "pen", brush: getSettings(app.store).inkBrush || "pen", color: "black", width: 2 };
  const liveInk = new LiveInk(session);
  const onionOn = () => getSettings(app.store).animOnion !== false;

  // ---- the page: the onion skin beneath, the frame I draw on, the frame playing over both ------

  let ink = null;
  const view = pageStage(body, { id: "anim", width: PAGE_W, height: PAGE_H, onPinch: () => ink?.cancelTouch(), avoid: () => inkTools });
  const { page, stage } = view;
  const back = h("canvas", { class: "anim-sheet anim-back", id: "anim-back", "aria-hidden": "true" });
  const onion = h("canvas", { class: "anim-sheet anim-onion", "aria-hidden": "true" });
  const inkHost = h("div", { class: "draw-layer active", id: "anim-ink" });
  const show = h("canvas", { class: "anim-sheet anim-show", id: "anim-show", hidden: true, "aria-hidden": "true" });
  page.append(back, onion, inkHost, show);
  const curDoc = () => (current ? frameDocOf(current) : "k:F-");
  const share = liveInk.on(curDoc);
  // 올가미, the same as in 그림 방 and the text room: what is drawn round is held, taken anywhere,
  // recoloured, copied or rubbed out, on the frame being drawn.
  let lasso = null;
  const keepInk = (made) => {
    const name = curDoc();
    session.commit(name, made.ops);
    record(made.atoms.map((atom) => ({ ...atom, doc: name })));
    if (current) thumbSoon(current);
  };
  ink = new InkLayer({
    fixedInk: true,
    host: inkHost,
    grow: false,
    onLasso: (info) => lasso?.show(info),
    onLassoMove: (ids, dx, dy) => {
      const made = moveStrokesOps(session.clock, session.doc(curDoc()), ids, dx, dy, session.memberId);
      keepInk(made);
      return made.ops.filter((o) => o.t === "stroke").map((o) => o.id);
    },
    maxPixels: MAX_PIXELS,
    ink: () => session.doc(curDoc()),
    share,
    steady: () => getSettings(app.store).inkSteady ?? 0,
    blocked: () => view.pinching || !!playing,
    shapes: () => getSettings(app.store).inkShapes !== false,
    onShape: () => buzz(app),
    onPick: (color) => { pen.color = color; setTool(pen.tool); },
    onStroke: ({ pts, color, width, size, brush, shape, opacity, cont }) => {
      if (readOnly() || !current) return null;
      const name = curDoc();
      const made = strokeOps(session.clock, session.doc(name), { pts, color: fixedInk(color), width, size, brush, shape, opacity, by: session.memberId });
      session.commit(name, made.ops);
      record(made.atoms.map((atom) => ({ ...atom, doc: name })), cont);
      thumbSoon(current);
      return made.ops[0]?.id;
    },
    onErase: (id) => {
      const name = curDoc();
      const made = eraseOps(session.clock, session.doc(name), id);
      session.commit(name, made.ops);
      record(made.atoms.map((atom) => ({ ...atom, doc: name })));
      thumbSoon(current);
    },
  });

  const inkKit = { ink, doc: () => session.doc(curDoc()), clock: session.clock, by: session.memberId, commit: keepInk };
  /** Drawings copied with the 올가미 go into 비서's 바구니, to be put into another room. */
  const carryInk = (strokes) => {
    if (!strokes.length) return;
    copyItem(app.store, { kind: "ink", strokes }, { room: session.roomId, name: roomEntry(app.store, session.roomId)?.name || "", kind: "creative-anim" });
    toast(root, `그림 ${strokes.length}획을 복사했어요. 다른 방에서 비서의 '여기에 놓기'로 꺼내요`, 3200);
  };
  lasso = lassoActions({ ...inkKit, carry: carryInk });

  // ---- below the page: the strip of frames, the brushes, the tools ------------------------------

  const strip = h("div", { class: "anim-strip", id: "anim-strip", role: "listbox", "aria-label": "장" });
  const inkTools = h("div", { class: "ink-tools", id: "ink-tools", role: "toolbar", "aria-label": "그리기 도구" });
  const undoButton = iconButton("anim-undo", "undo", "되돌리기", () => step("undo"), "되돌리기");
  const redoButton = iconButton("anim-redo", "redo", "다시하기", () => step("redo"), "다시하기");
  const playButton = iconButton("anim-play", "play", "재생", () => (playing ? stopPlay() : startPlay()), "재생");
  const onionButton = iconButton("anim-onion-btn", "onion", "양파 껍질: 앞뒤 장을 옅게 비춰요", () => {
    setSetting(app.store, "animOnion", !onionOn());
    paintOnion();
    drawTools();
  }, "양파");
  // 빠르기 and what happens at the end share one chip and one small menu (Procreate keeps them in its
  // Animation Assist settings), so the bar fits a 360-wide phone; the paper is held in the 배경 cell,
  // the bottom of the stack, as 그림 방 keeps it at the bottom of its layers. 저장 gives GIF (a chat
  // plays it by itself, over and over) or 영상, as FlipaClip and Procreate export both.
  const speedChip = h("button", { class: "chip anim-chip", id: "anim-speed", type: "button", "aria-haspopup": "menu", title: "재생: 빠르기와 끝나면", onclick: () => playMenu() });
  const saveButton = iconButton("anim-save", "save", "저장: GIF나 영상으로", () => saveMenu(), "저장");
  saveButton.setAttribute("aria-haspopup", "menu");
  const toolbar = h("div", { class: "toolbar draw-tools anim-tools", id: "anim-tools" }, undoButton, redoButton, playButton, onionButton, speedChip, saveButton);
  // The frames and what plays them are one thing at the room's foot, as Procreate's Animation Assist
  // and Dreams keep the timeline as one band under the canvas: one glass, the frames above their
  // buttons (beside them on a short, wide screen). The rail keeps between the bars, never over it.
  const dock = h("div", { class: "anim-dock", id: "anim-dock" }, strip, toolbar);
  body.after(inkTools, dock);
  const offBand = keepRailBetween(inkTools);

  function drawTools() {
    const { fps, loop } = doc.settings();
    rollTo(speedChip, `${fps}장/초`);
    speedChip.setAttribute("aria-label", `재생: 1초에 ${fps}장, 끝나면 ${LOOP_NAMES[loop]}`);
    onionButton.setAttribute("aria-pressed", String(onionOn()));
    playButton.replaceChildren(icon(playing ? "pause" : "play"));
    playButton.setAttribute("aria-label", playing ? "멈춤" : "재생");
    playButton.dataset.cap = playing ? "멈춤" : "재생";
    playButton.setAttribute("aria-pressed", String(!!playing));
    undoButton.disabled = !undo.canUndo;
    redoButton.disabled = !undo.canRedo;
  }

  function setTool(tool) {
    pen.tool = tool;
    ink.setTool(playing || readOnly() ? null : tool);
    ink.setStyle({ color: pen.color, width: pen.width, brush: pen.brush, size: pen.size || null });
    drawInkTools(inkTools, { pen, setTool, store: app.store, lasso: true, fixedInk: true, units: () => ink.unitsPerPx(),
      restyle: () => ink.setStyle({ color: pen.color, width: pen.width, brush: pen.brush, size: pen.size || null }),
      pieces: "creative-anim", drop: (x, y) => dropTarget(x, y) });
  }

  /** 컬러드롭: the colour let go on the page fills there, on the frame being drawn (as 채우기 does). */
  function dropTarget(x, y) {
    const r = page.getBoundingClientRect();
    if (readOnly() || !current || playing || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    return ink;
  }

  // ---- drawing a frame onto a canvas (onion skin, playing, thumbnails) --------------------------

  /** A canvas sized to its box on screen (sharp), at most MAX_PIXELS. */
  function fitCanvas(c) {
    const r = c.getBoundingClientRect();
    let ratio = window.devicePixelRatio || 1;
    const px = r.width * r.height * ratio * ratio;
    if (px > MAX_PIXELS) ratio *= Math.sqrt(MAX_PIXELS / px);
    const w = Math.max(1, Math.round(r.width * ratio));
    const hgt = Math.max(1, Math.round(r.height * ratio));
    if (c.width !== w || c.height !== hgt) {
      c.width = w;
      c.height = hgt;
    }
  }

  function paintPaper() {
    const key = doc.settings().paper;
    page.dataset.paper = key;
    page.style.setProperty("--paper-c", paperColour(key) || "transparent");
    strip.dataset.paper = key;
    strip.style.setProperty("--paper-c", paperColour(key) || "transparent");
  }

  /** The background under the frame being drawn (not while the background itself is drawn). */
  function paintBack() {
    fitCanvas(back);
    const g = back.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, back.width, back.height);
    back.hidden = current === BG || !!playing;
    if (!back.hidden) paintFrame(g, BG, back.width, back.height);
  }

  /** A frame as it is seen: the background, then its own strokes. */
  function paintWhole(g, id, w, hgt) {
    paintFrame(g, BG, w, hgt);
    if (id !== BG) paintFrame(g, id, w, hgt);
  }

  /** One frame's strokes onto a context sized w × hgt; tint: every stroke in that one colour. */
  function paintFrame(g, id, w, hgt, tint = null) {
    g.setTransform(w / PAGE_W, 0, 0, hgt / PAGE_H, 0, 0);
    for (const s of session.doc(frameDocOf(id)).strokes()) paintStroke(g, s.pts, tint || fixedInk(s.c), widthOf(s), brushOf(s), !!s.q, opacityOf(s));
  }

  const neighbours = () => {
    // Drawing the background, the first frame shows faintly over it (to place the scene).
    if (current === BG) return { before: doc.frames()[0]?.id || null, after: null };
    const list = doc.frames();
    const i = list.findIndex((f) => f.id === current);
    return { before: i > 0 ? list[i - 1].id : null, after: i >= 0 && i < list.length - 1 ? list[i + 1].id : null };
  };

  function paintOnion() {
    fitCanvas(onion);
    const g = onion.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, onion.width, onion.height);
    onion.hidden = !onionOn() || !!playing;
    if (onion.hidden || !current) return;
    const { before, after } = neighbours();
    // The one before a little stronger than the one after: where the drawing came from leads.
    for (const [id, tint, alpha] of [[after, ONION.after, 0.22], [before, ONION.before, 0.3]]) {
      if (!id) continue;
      g.globalAlpha = alpha;
      paintFrame(g, id, onion.width, onion.height, tint);
    }
    g.globalAlpha = 1;
  }

  // Each frame drawn once into a picture of its own while it plays (drawn again when it changes).
  const pictures = new Map(); // frame id → { version, canvas }
  function pictureOf(id, w, hgt) {
    const d = session.doc(frameDocOf(id));
    const had = pictures.get(id);
    if (had && had.version === d.version + "/" + session.doc(frameDocOf(BG)).version && had.canvas.width === w && had.canvas.height === hgt) return had.canvas;
    const c = had?.canvas || document.createElement("canvas");
    c.width = w;
    c.height = hgt;
    const g = c.getContext("2d");
    if (g) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, w, hgt);
      paintWhole(g, id, w, hgt);
    }
    pictures.set(id, { version: d.version + "/" + session.doc(frameDocOf(BG)).version, canvas: c });
    return c;
  }

  // ---- ▶ ----------------------------------------------------------------------------------------

  function startPlay() {
    if (!timeline(doc).length) return;
    ink.cancelTouch();
    playing = { start: performance.now(), shown: null, raf: 0 };
    show.hidden = false;
    inkHost.style.visibility = "hidden";
    fitCanvas(show);
    paintOnion();
    paintBack();
    setTool(pen.tool);
    drawTools();
    const loop = (now) => {
      if (!playing || !alive) return;
      const { fps, loop: way } = doc.settings();
      const tick = Math.floor(((now - playing.start) / 1000) * fps);
      if (way === "once" && tick >= timeline(doc).length) return stopPlay();
      const id = frameAt(doc, tick);
      if (id && id !== playing.shown) {
        const g = show.getContext("2d");
        if (g) {
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.clearRect(0, 0, show.width, show.height);
          g.drawImage(pictureOf(id, show.width, show.height), 0, 0);
        }
        playing.shown = id;
        show.dataset.frame = id;
        for (const cell of strip.querySelectorAll(".anim-frame")) cell.classList.toggle("playing", cell.dataset.frame === id);
      }
      playing.raf = requestAnimationFrame(loop);
    };
    playing.raf = requestAnimationFrame(loop);
  }

  function stopPlay() {
    if (!playing) return;
    cancelAnimationFrame(playing.raf);
    playing = null;
    show.hidden = true;
    delete show.dataset.frame;
    inkHost.style.visibility = "";
    for (const cell of strip.querySelectorAll(".anim-frame.playing")) cell.classList.remove("playing");
    paintOnion();
    paintBack();
    setTool(pen.tool);
    drawTools();
  }

  // ---- the strip of frames ------------------------------------------------------------------------

  const cells = new Map(); // frame id → { cell, thumb }
  const thumbWaiting = new Set();
  function thumbSoon(id) {
    thumbWaiting.add(id);
    requestAnimationFrame(() => {
      for (const one of thumbWaiting) paintThumb(one);
      thumbWaiting.clear();
    });
  }
  function paintThumb(id) {
    const c = cells.get(id)?.thumb;
    const g = c?.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    paintWhole(g, id, c.width, c.height);
  }

  /** Where friends are: frame id → their colours. */
  function friendsOn() {
    const out = new Map();
    for (const peer of session.peers || []) {
      const f = peer.state?.anim?.f;
      const member = peer.state?.m ? session.room.member(peer.state.m) : null;
      if (peer.isMe || !f || !member) continue;
      if (!out.has(f)) out.set(f, []);
      out.get(f).push(personColor(member, currentTheme()));
    }
    return out;
  }

  // ‹ 3/12 ›: to the frame before or after without hunting along the strip (as FlipaClip and
  // RoughAnimator step through frames); it stays at the strip's start while the strip scrolls.
  const where = h("span", { class: "anim-where", id: "anim-where" });
  // 배경 sits before the first frame on the strip, so from it › is frame 1; at either end the
  // arrow greys out rather than wrapping round (FlipaClip does not wrap either).
  const stepTo = (by) => {
    const list = doc.frames();
    const i = current === BG ? -1 : list.findIndex((f) => f.id === current);
    const next = list[i + by];
    if (next) { if (playing) stopPlay(); select(next.id); }
  };
  const prevButton = h("button", { class: "anim-step", id: "anim-prev", type: "button", "aria-label": "앞 장", text: "‹", onclick: () => stepTo(-1) });
  const nextButton = h("button", { class: "anim-step", id: "anim-next", type: "button", "aria-label": "다음 장", text: "›", onclick: () => stepTo(1) });
  const nav = h("div", { class: "anim-nav", id: "anim-nav" }, prevButton, where, nextButton);
  const bgThumb = h("canvas", { class: "anim-thumb", width: 54, height: 72, "aria-hidden": "true" });
  const bgCell = h("button", { class: "anim-frame anim-bg", id: "anim-bg", type: "button", role: "option", data: { frame: BG }, "aria-label": "배경 (모든 장 밑에)" }, bgThumb, h("span", { class: "anim-num", text: "배경" }),
    h("span", { class: "anim-peers" }));
  wireCell(bgCell, BG, () => { select(BG); paperMenu(bgCell); });
  cells.set(BG, { cell: bgCell, thumb: bgThumb });
  const addButton = h("button", { class: "anim-add", id: "anim-add", type: "button", "aria-label": "빈 장 더하기", onclick: () => addFrame() }, icon("plus"));
  const copyButton = h("button", { class: "anim-add", id: "anim-copy", type: "button", "aria-label": "이 장 복제해서 다음 장으로", onclick: () => duplicate() }, icon("copy"));
  function drawStrip() {
    const list = doc.frames();
    const friends = friendsOn();
    const keep = new Set(list.map((f) => f.id));
    keep.add(BG);
    for (const [id, { cell }] of cells) if (!keep.has(id)) { cell.remove(); cells.delete(id); }
    strip.append(nav, bgCell);
    const at = list.findIndex((f) => f.id === current);
    rollTo(where, current === BG ? `배경 · ${list.length}장` : `${at + 1}/${list.length}`);
    prevButton.disabled = current === BG || at <= 0;
    nextButton.disabled = current !== BG && at >= list.length - 1;
    bgCell.classList.toggle("on", current === BG);
    bgCell.setAttribute("aria-selected", String(current === BG));
    bgCell.querySelector(".anim-peers").replaceChildren(...(friends.get(BG) || []).map((color) => h("i", { style: { background: color } })));
    list.forEach((f, i) => {
      let entry = cells.get(f.id);
      if (!entry) {
        const thumb = h("canvas", { class: "anim-thumb", width: 54, height: 72, "aria-hidden": "true" });
        const cell = h("button", { class: "anim-frame", type: "button", role: "option", data: { frame: f.id } }, thumb, h("span", { class: "anim-num" }), h("span", { class: "anim-hold" }), h("span", { class: "anim-peers" }));
        wireCell(cell, f.id);
        entry = { cell, thumb };
        cells.set(f.id, entry);
        thumbSoon(f.id);
        // Every frame is read, not only the one drawn on: its small picture, the onion skin and ▶
        // show what it holds (coming back to the room, frames 2 and 3 were empty until chosen: the
        // owner, 27 November, "나갔다가 들어와서 선이 한칸이 사라지거나"). Its picture comes when it is read.
        session.load(frameDocOf(f.id));
      }
      const { cell } = entry;
      const on = f.id === current;
      cell.classList.toggle("on", on);
      cell.setAttribute("aria-selected", String(on));
      cell.setAttribute("aria-label", `${i + 1}장${f.hold > 1 ? `, ${f.hold}배 길게` : ""}`);
      cell.style.setProperty("--hold", String(f.hold));
      cell.querySelector(".anim-num").textContent = String(i + 1);
      cell.querySelector(".anim-hold").textContent = f.hold > 1 ? "×" + f.hold : "";
      cell.querySelector(".anim-peers").replaceChildren(...(friends.get(f.id) || []).map((color) => h("i", { style: { background: color } })));
      strip.append(cell); // in order (moving, not making again: a finger may be on it)
    });
    if (!readOnly()) strip.append(addButton, copyButton);
    else { addButton.remove(); copyButton.remove(); }
    addButton.disabled = copyButton.disabled = list.length >= MAX_FRAMES;
    const on = cells.get(current)?.cell;
    if (on) {
      const r = on.getBoundingClientRect();
      const box = strip.getBoundingClientRect();
      if (r.left < box.left || r.right > box.right) on.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
  }

  /**
   * A tap goes to the frame; held, its menu: 길게, 복제, 앞으로·뒤로, 지우기 (배경's: 종이). A frame held and
   * then dragged along the strip goes where it is let go instead (FlipaClip and Procreate Dreams move a
   * frame so): a mark shows the place between the frames, the strip scrolls at its ends, and the move
   * is one step back for 되돌리기, for everyone.
   */
  function wireCell(cell, id, hold = () => frameMenu(cell, id)) {
    let timer = 0;
    let held = false;
    let lift = null; // { pointer, x, y, moved, to }
    let press = null;
    const movable = id !== BG;
    cell.addEventListener("pointerdown", (e) => {
      held = false;
      clearTimeout(timer);
      lift = null;
      const start = { pointer: e.pointerId, x: e.clientX, y: e.clientY };
      press = start;
      timer = setTimeout(() => {
        held = true;
        buzz(app, 8);
        if (!movable || readOnly()) return void hold();
        // Held: it may yet be dragged (then it moves) or let go where it is (then its menu).
        lift = { ...start, moved: false, to: null };
        cell.classList.add("lifting");
        try { cell.setPointerCapture(start.pointer); } catch { /* fine */ }
      }, 480);
    });
    cell.addEventListener("pointermove", (e) => {
      if (!lift || e.pointerId !== lift.pointer) {
        // Moved before the hold (a scroll of the strip): no hold.
        if (!held && press && e.pointerId === press.pointer && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) clearTimeout(timer);
        return;
      }
      if (!lift.moved && Math.hypot(e.clientX - lift.x, e.clientY - lift.y) < 8) return;
      lift.moved = true;
      cell.style.translate = `${e.clientX - lift.x}px 0`;
      // Near the strip's ends it scrolls, so a frame goes anywhere in a long flipbook.
      const box = strip.getBoundingClientRect();
      if (e.clientX < box.left + 28) strip.scrollLeft -= 10;
      else if (e.clientX > box.right - 28) strip.scrollLeft += 10;
      lift.to = dropIndex(e.clientX);
      showDrop(lift.to);
    });
    const end = (e) => {
      clearTimeout(timer);
      if (!lift || (e && e.pointerId !== lift.pointer)) return;
      const was = lift;
      lift = null;
      cell.classList.remove("lifting");
      cell.style.translate = "";
      strip.querySelector(".anim-drop")?.remove();
      if (!was.moved) return void hold();
      if (e?.type !== "pointerup" || was.to == null) return;
      const list = doc.frames();
      const from = list.findIndex((f) => f.id === id);
      // The place among the others: before the frame at `to` (counted with this one taken out).
      const to = was.to > from ? was.to - 1 : was.to;
      if (from >= 0 && to !== from) {
        apply(moveFrameOps(session.clock, doc, id, to - from));
        buzz(app, 8);
      }
    };
    cell.addEventListener("pointerup", end);
    cell.addEventListener("pointercancel", end);
    cell.addEventListener("lostpointercapture", (e) => { if (lift) end(e); });
    cell.addEventListener("pointerleave", () => { if (!lift && !held) clearTimeout(timer); });
    // Held, the finger moves the frame, not the strip.
    cell.addEventListener("touchmove", (e) => { if (lift) e.preventDefault(); }, { passive: false });
    cell.addEventListener("contextmenu", (e) => e.preventDefault());
    cell.addEventListener("click", () => {
      if (held) return;
      if (playing) stopPlay();
      select(id);
      if (id === BG && !getSettings(app.store).animBgSeen) {
        setSetting(app.store, "animBgSeen", true);
        flashHint("배경은 모든 장 밑에 깔려요 · 꾹 누르면 종이");
      }
    });
  }

  /** Where among the frames a frame dragged to x would go: the index of the frame it would stand before. */
  function dropIndex(x) {
    const list = doc.frames();
    for (let i = 0; i < list.length; i++) {
      const c = cells.get(list[i].id)?.cell;
      if (!c || c.classList.contains("lifting")) continue;
      const r = c.getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return list.length;
  }
  /** A thin mark of my colour between the frames where the dragged one would go. */
  function showDrop(index) {
    const list = doc.frames();
    let mark = strip.querySelector(".anim-drop");
    if (!mark) mark = h("span", { class: "anim-drop", "aria-hidden": "true" });
    const before = list[index] ? cells.get(list[index].id)?.cell : addButton.isConnected ? addButton : null;
    if (before) strip.insertBefore(mark, before);
    else strip.append(mark);
  }

  let closeMenu = null;
  let menuFor = null;
  /**
   * A small menu just above what opened it. A tap outside closes it and touches nothing else; the
   * bar's own button pressed again closes it too (the bars let a press through, so it asks).
   */
  function openMenu(anchor, menu) {
    closeMenu?.();
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const mr = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(innerWidth - mr.width - 8, r.left + r.width / 2 - mr.width / 2)) + "px";
    menu.style.top = Math.max(8, r.top - mr.height - 10) + "px";
    let stop = null;
    function close() {
      stop?.();
      menu.remove();
      if (closeMenu === close) { closeMenu = null; menuFor = null; }
    }
    closeMenu = close;
    menuFor = anchor;
    setTimeout(() => { if (menu.isConnected) stop = closeOnOutside((t) => menu.contains(t), close, menu); }, 0);
    return close;
  }

  function frameMenu(cell, id) {
    closeMenu?.();
    select(id);
    const f = doc.frame(id);
    if (!f || readOnly()) return;
    const list = doc.frames();
    const at = list.findIndex((x) => x.id === id);
    const menu = h("div", { class: "anim-menu", id: "anim-menu", role: "menu" },
      h("div", { class: "anim-menu-row", role: "group", "aria-label": "길게" },
        h("span", { class: "anim-menu-label", text: "길게" }),
        ...[1, 2, 3, 4].map((n) => h("button", { class: "chip", type: "button", data: { hold: String(n) }, "aria-pressed": String(f.hold === n), text: "×" + n, onclick: () => { apply(setFrameOps(session.clock, doc, id, { hold: n })); close(); } }))),
      h("div", { class: "anim-menu-row" },
        h("button", { class: "chip", type: "button", id: "anim-menu-copy", text: "복제", onclick: () => { close(); duplicate(); } }),
        at > 0 && h("button", { class: "chip", type: "button", id: "anim-menu-left", text: "← 앞으로", onclick: () => { apply(moveFrameOps(session.clock, doc, id, -1)); close(); } }),
        at < list.length - 1 && h("button", { class: "chip", type: "button", id: "anim-menu-right", text: "뒤로 →", onclick: () => { apply(moveFrameOps(session.clock, doc, id, 1)); close(); } }),
        list.length > 1 && h("button", { class: "chip danger", type: "button", id: "anim-menu-remove", text: "지우기", onclick: () => { close(); removeFrame(id); } })));
    const close = openMenu(cell, menu);
  }

  // ---- frames: choose, add, copy, take away -------------------------------------------------------

  function select(id) {
    if (!id) return;
    if (current !== id) {
      current = id;
      share.detach(ink);
      share.attach(ink);
      session.load(frameDocOf(id)).then(() => { if (alive && current === id) { ink.render(); paintOnion(); paintBack(); } });
      session.setPresencePart("anim", { f: id });
    }
    ink.render();
    paintOnion();
    paintBack();
    drawStrip();
  }

  function addFrame() {
    if (readOnly() || doc.frames().length >= MAX_FRAMES) return;
    const made = addFrameOps(session.clock, doc, { by: session.memberId, after: current === BG ? null : current });
    if (apply(made)) select(made.id);
  }

  /** The animator's way: the frame copied as the next one, to change a little. */
  function duplicate() {
    if (readOnly() || !current || current === BG || doc.frames().length >= MAX_FRAMES) return;
    const from = session.doc(frameDocOf(current));
    const made = addFrameOps(session.clock, doc, { by: session.memberId, after: current });
    session.commit("anim", made.ops);
    const atoms = made.atoms.map((atom) => ({ ...atom, doc: "anim" }));
    const name = frameDocOf(made.id);
    for (const s of from.strokes()) {
      const one = strokeOps(session.clock, session.doc(name), { pts: s.pts, color: fixedInk(s.c), width: s.w, size: s.z ? s.z / 10 : undefined, brush: s.b || "pen", style: s.s, shape: !!s.q, opacity: opacityOf(s), by: session.memberId });
      session.commit(name, one.ops);
      atoms.push(...one.atoms.map((atom) => ({ ...atom, doc: name })));
    }
    record(atoms);
    select(made.id);
    flashHint("복제했어요");
  }

  function removeFrame(id) {
    const list = doc.frames();
    if (list.length <= 1) return;
    const i = list.findIndex((f) => f.id === id);
    if (apply(removeFrameOps(session.clock, doc, id))) {
      toast(root, "장을 지웠어요 (되돌리기로 살려요)");
      if (current === id) select((list[i + 1] || list[i - 1]).id);
    }
  }

  /** 종이: the 그림 방's papers (투명 too), under every frame, for everyone; held from the 배경 cell. */
  function paperMenu(anchor) {
    if (readOnly()) return;
    const now = doc.settings().paper;
    const menu = h("div", { class: "anim-menu", id: "anim-paper-menu", role: "menu" },
      h("div", { class: "anim-menu-row paper-row", role: "group", "aria-label": "종이" },
        h("span", { class: "anim-menu-label", text: "종이" }),
        ...PAPERS.map(([k, c, label]) => h("button", { class: "paper-pick" + (c ? "" : " clear"), type: "button", data: { paper: k }, "aria-pressed": String(k === now), "aria-label": label, title: label,
          style: c ? { background: c } : {}, onclick: () => { if (k !== now) apply(setAnimOps(session.clock, doc, { paper: k })); close(); } }))));
    const close = openMenu(anchor, menu);
  }

  /** 재생: how many frames a second, and at the end 반복·왕복·한 번. Both can be set before it closes. */
  function playMenu() {
    if (menuFor === speedChip) return void closeMenu?.();
    if (readOnly()) return;
    const rows = () => {
      const { fps, loop } = doc.settings();
      return [
        h("div", { class: "anim-menu-row", role: "group", "aria-label": "1초에" },
          h("span", { class: "anim-menu-label", text: "1초에" }),
          ...FPS_CHOICES.map((n) => h("button", { class: "chip", type: "button", data: { fps: String(n) }, "aria-pressed": String(n === fps), text: `${n}장`, onclick: () => pick({ fps: n }) }))),
        h("div", { class: "anim-menu-row", role: "group", "aria-label": "끝나면" },
          h("span", { class: "anim-menu-label", text: "끝나면" }),
          ...LOOPS.map((k) => h("button", { class: "chip", type: "button", data: { loop: k }, "aria-pressed": String(k === loop), text: LOOP_NAMES[k], onclick: () => pick({ loop: k }) }))),
      ];
    };
    const menu = h("div", { class: "anim-menu", id: "anim-play-menu", role: "menu" }, ...rows());
    const pick = (change) => {
      apply(setAnimOps(session.clock, doc, change));
      mount(menu, rows());
    };
    openMenu(speedChip, menu);
  }

  /** 저장: GIF or 영상 from one small menu; where a video cannot be made, the GIF straight away. */
  function saveMenu() {
    if (menuFor === saveButton) return void closeMenu?.();
    if (saving) return;
    if (!canRecord()) return void saveGif();
    const clear = !paperColour(doc.settings().paper);
    const menu = h("div", { class: "anim-menu", id: "anim-save-menu", role: "menu" },
      h("div", { class: "anim-menu-row", role: "group", "aria-label": "저장" },
        h("span", { class: "anim-menu-label", text: "저장" }),
        h("button", { class: "chip", type: "button", id: "anim-save-gif", text: "GIF", title: clear ? "움짤로: 투명한 종이는 투명하게" : "움짤로: 대화창에서 저절로 돌아요", onclick: () => { close(); saveGif(); } }),
        h("button", { class: "chip", type: "button", id: "anim-save-video", text: "영상", title: "영상 파일로", onclick: () => { close(); saveVideo(); } })));
    const close = openMenu(saveButton, menu);
  }

  const fileName = () => String(session.room.meta("name") || "플립북").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60);

  /** The file handed to the browser to keep (on a phone, in its downloads). */
  function handOver(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  /**
   * GIF로 저장: once through as it plays (back and forth once for 왕복), at its own speed and holds;
   * 반복·왕복 go round for ever, 한 번 plays once. On 투명 paper what is not drawn stays see-through, a
   * sticker in a chat. Two goes over the frames: their colours (one table for all, so no colour
   * flickers), then each frame written, a rest between frames so the screen never stalls.
   */
  async function saveGif() {
    if (saving) return;
    const pass = onePass(doc);
    if (!pass.length) return;
    saving = true;
    if (playing) stopPlay();
    const runs = [];
    for (const id of pass) {
      const last = runs[runs.length - 1];
      if (last?.id === id) last.n++;
      else runs.push({ id, n: 1 });
    }
    const { fps, loop, paper } = doc.settings();
    const fill = paperColour(paper);
    const W = GIF_W;
    const H = Math.round((W * PAGE_H) / PAGE_W);
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    const picture = (id) => {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.clearRect(0, 0, W, H);
      if (fill) {
        g.fillStyle = fill;
        g.fillRect(0, 0, W, H);
      }
      paintWhole(g, id, W, H);
      return g.getImageData(0, 0, W, H).data;
    };
    const ids = [...new Set(pass)];
    const steps = ids.length + runs.length;
    let done = 0;
    saveButton.disabled = true;
    saveButton.dataset.cap = "GIF 0%";
    const rest = async () => {
      done++;
      saveButton.dataset.cap = `GIF ${Math.round((done / steps) * 100)}%`;
      await new Promise((resolve) => setTimeout(resolve, 0));
      return alive;
    };
    const end = () => {
      saving = false;
      if (!alive) return;
      saveButton.disabled = false;
      saveButton.dataset.cap = "저장";
    };
    let bytes = null;
    try {
      await Promise.all([...ids, BG].map((id) => session.load(frameDocOf(id))));
      const count = new ColourCount();
      for (const id of ids) {
        count.add(picture(id), !fill);
        if (!(await rest())) return end(); // left the room part way: no half a picture
      }
      const writer = new GifWriter({ width: W, height: H, palette: count.palette(fill ? 256 : 255), loop: loop !== "once", clear: !fill });
      const delays = gifDelays(runs.map((r) => r.n), fps);
      for (let i = 0; i < runs.length; i++) {
        writer.frame(picture(runs[i].id), delays[i]);
        if (!(await rest())) return end();
      }
      bytes = writer.finish();
    } catch {
      end();
      return void toast(root, "GIF를 만들지 못했어요");
    }
    end();
    const name = fileName();
    const file = new File([bytes], `${name}.gif`, { type: "image/gif" });
    toolbar.dataset.gif = String(file.size);
    handOver(file, file.name);
    // 보내기: the phone's share sheet (a chat app, a friend) with the GIF, from a tap of its own.
    let canSend = false;
    try {
      canSend = !!navigator.canShare?.({ files: [file] });
    } catch {}
    toast(root, "GIF로 저장했어요", 2600, canSend ? { label: "보내기", run: () => navigator.share({ files: [file], title: name }).catch(() => {}) } : null);
  }

  /**
   * 영상으로 저장 (FlipaClip's MP4): the flipbook once through at its own speed (back and forth once for
   * 왕복), each frame on its paper with the background beneath, recorded from a canvas.
   */
  let saving = false;
  async function saveVideo() {
    if (saving) return;
    const pass = onePass(doc);
    if (!pass.length) return;
    const canvas = document.createElement("canvas");
    if (typeof canvas.captureStream !== "function" || typeof window.MediaRecorder !== "function") return void toast(root, "이 브라우저에서는 영상으로 저장할 수 없어요");
    saving = true;
    if (playing) stopPlay();
    const W = 720;
    const H = Math.round((W * PAGE_H) / PAGE_W);
    canvas.width = W;
    canvas.height = H;
    canvas.className = "anim-record";
    document.body.append(canvas);
    const g = canvas.getContext("2d");
    const paper = paperColour(doc.settings().paper) || "#ffffff"; // a video has no see-through
    const draw = (id) => {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.fillStyle = paper;
      g.fillRect(0, 0, W, H);
      paintWhole(g, id, W, H);
    };
    await Promise.all([...new Set(pass), BG].map((id) => session.load(frameDocOf(id))));
    draw(pass[0]);
    const { fps } = doc.settings();
    const type = ["video/mp4", "video/webm;codecs=vp9", "video/webm"].find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
    let rec;
    try {
      rec = new MediaRecorder(canvas.captureStream(fps), type ? { mimeType: type } : {});
    } catch {
      canvas.remove();
      saving = false;
      return void toast(root, "이 브라우저에서는 영상으로 저장할 수 없어요");
    }
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data?.size) parts.push(e.data); };
    const stopped = new Promise((resolve) => { rec.onstop = resolve; });
    saveButton.disabled = true;
    saveButton.dataset.cap = "저장 중…";
    rec.start(250);
    const start = performance.now();
    let shown = 0;
    await new Promise((resolve) => {
      const tick = () => {
        if (!alive) return resolve();
        const i = Math.floor(((performance.now() - start) / 1000) * fps);
        if (i >= pass.length) return resolve();
        if (i !== shown) { shown = i; draw(pass[i]); }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    setTimeout(() => rec.state !== "inactive" && rec.stop(), 1000 / fps + 150);
    await stopped;
    canvas.remove();
    saving = false;
    if (!alive) return; // left the room part way: no half a video
    saveButton.disabled = false;
    saveButton.dataset.cap = "저장";
    const blob = new Blob(parts, { type: rec.mimeType || type || "video/webm" });
    toolbar.dataset.saved = String(blob.size);
    handOver(blob, `${fileName()}.${(rec.mimeType || type).includes("mp4") ? "mp4" : "webm"}`);
    toast(root, "영상으로 저장했어요");
  }

  // ---- changes, undo --------------------------------------------------------------------------------

  /** cont: a part of one line drawn in pieces (its look changed mid-line): one step with the parts before it. */
  function record(atoms, cont = null) {
    if (atoms.length) undo.record(atoms, { now: Date.now(), typing: false, group: cont || null });
    drawTools();
  }

  function apply(made) {
    if (!made?.ops?.length || readOnly()) return false;
    session.commit("anim", made.ops);
    record(made.atoms.map((atom) => ({ ...atom, doc: "anim" })));
    drawStrip();
    paintOnion();
    return true;
  }

  function step(dir) {
    const atoms = dir === "undo" ? undo.undo() : undo.redo();
    if (!atoms) return;
    const byDoc = new Map();
    for (const atom of atoms) {
      if (!byDoc.has(atom.doc)) byDoc.set(atom.doc, []);
      byDoc.get(atom.doc).push(atom);
    }
    for (const [name, list] of byDoc) {
      if (name === "anim") session.commit("anim", invertAnimOps(doc, session.clock, list, dir));
      else session.commit(name, invertInkOps(session.doc(name), session.clock, list, dir));
    }
    record([]);
    if (current !== BG && (!doc.frame(current) || doc.frame(current).removed)) select(doc.frames()[0]?.id);
    drawStrip();
    ink.render();
    paintOnion();
    paintBack();
  }

  // Procreate's taps: two fingers 되돌리기, three 다시하기.
  const stopTaps = watchFingerTaps(stage, {
    two: () => { if (undo.canUndo) { step("undo"); flashHint("되돌리기"); } },
    three: () => { if (undo.canRedo) { step("redo"); flashHint("다시하기"); } },
    four: () => toggleBare(stage.closest(".room"), flashHint),
  });
  // 스포이트: two fingers held still pick the colour drawn between them (not while it plays).
  const stopPick = watchPick(stage, () => (playing ? null : ink));

  // ---- start --------------------------------------------------------------------------------------

  let peersTimer = 0;
  const offs = [
    session.on("change", ({ doc: name }) => {
      if (name === "anim") {
        if (current && current !== BG && (!doc.frame(current) || doc.frame(current).removed)) select(doc.frames()[0]?.id);
        drawStrip();
        drawTools();
        paintOnion();
        paintPaper();
      } else if (name === frameDocOf(BG)) {
        // The background is under every frame: all of them change.
        for (const id of [BG, ...doc.frames().map((f) => f.id)]) thumbSoon(id);
        if (current === BG) ink.render();
        paintBack();
      } else if (name.startsWith("k:F")) {
        const id = name.slice(3);
        thumbSoon(id);
        if (id === current) ink.render();
        const { before, after } = neighbours();
        if (id === before || id === after) paintOnion();
      }
    }),
    session.on("peers", () => {
      if (peersTimer) return;
      peersTimer = setTimeout(() => { peersTimer = 0; if (alive) drawStrip(); }, 300);
    }),
  ];
  const resize = new ResizeObserver(() => { if (!playing) { paintOnion(); paintBack(); } else fitCanvas(show); });
  resize.observe(page);

  session.load("anim").then(async () => {
    if (!alive) return;
    // A new flipbook starts with two empty frames and the onion skin on: what to do is plain to see.
    if (!doc.frames().length && !readOnly()) {
      const one = addFrameOps(session.clock, doc, { by: session.memberId });
      session.commit("anim", one.ops);
      const two = addFrameOps(session.clock, doc, { by: session.memberId });
      session.commit("anim", two.ops);
    }
    const first = doc.frames()[0];
    if (first) select(first.id);
    paintPaper();
    session.load(frameDocOf(BG)).then(() => { if (!alive) return; paintBack(); for (const id of [BG, ...doc.frames().map((f) => f.id)]) thumbSoon(id); });
    drawTools();
    view.fit();
  });
  setTool(pen.tool);
  drawTools();
  drawStrip();

  return {
    /** 비서's 바구니: drawings (from any room, a whiteboard's too) land on the frame being drawn. */
    takes(item) {
      return !readOnly() && !!current && ((item.kind === "ink" && !!item.strokes?.length) || (item.kind === "board-items" && !!item.strokes?.length));
    },
    put(item) {
      if (!current) return;
      setTool("lasso");
      landInk(inkKit, item.kind === "ink" ? item.strokes : boardStrokesCarried(item.strokes));
    },
    close() {
      alive = false;
      stopPlay();
      closeMenu?.();
      lasso?.hide();
      for (const off of offs) off();
      clearTimeout(peersTimer);
      resize.disconnect();
      view.destroy();
      stopTaps();
      stopPick();
      ink.destroy();
      liveInk.close();
      session.setPresencePart("anim", null);
      offBand();
      releasePieces(inkTools);
      dock.remove();
      inkTools.remove();
    },
  };
}
