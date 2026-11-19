// 애니메이션 방: a flipbook drawn together. From the reference study (specs/2026-11-20-reference-study.md
// §3): FlipaClip's strip of frames along the bottom; onion skin (the frame before faintly in red, the
// one after in green, as Krita and Toon Boom show them); ▶ at a speed (12 a second at first, as
// animators draw "on twos") that loops, goes back and forth, or plays once; a frame held for longer
// (Procreate's hold, OpenToonz's exposure) shown wider in the strip; a frame copied to change a
// little, the animator's way. Friends draw on whichever frame they like at the same time: the strip
// shows where each of them is, and their lines appear live on the frame they share. Each frame is its
// own drawing, with the same brushes, gestures and live lines as 그림 방.

import { h, icon, iconButton, toast, flashHint, closeOnOutside } from "./dom.js";
import { InkLayer, drawInkTools, paintStroke } from "./ink.js";
import { LiveInk } from "./live-ink.js";
import { watchFingerTaps } from "./fingers.js";
import { pageStage } from "./page-stage.js";
import { PAGE_W, PAGE_H } from "./draw-room.js";
import { addFrameOps, setFrameOps, removeFrameOps, moveFrameOps, setAnimOps, invertAnimOps, frameDocOf, frameAt, timeline, FPS_CHOICES, LOOPS, MAX_FRAMES, MAX_HOLD } from "../core/anim.js";
import { strokeOps, eraseOps, invertInkOps, brushOf } from "../core/ink.js";
import { UndoStack } from "../core/undo.js";
import { getSettings, setSetting } from "../identity.js";
import { buzz } from "./chime.js";
import { memberColor } from "../core/paint.js";
import { currentTheme } from "./theme.js";

const ONION = { before: "#e5484d", after: "#2f9e5b" };
const LOOP_NAMES = { loop: "반복", pingpong: "왕복", once: "한 번" };
const MAX_PIXELS = 3.2e6;

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
  const view = pageStage(body, { id: "anim", width: PAGE_W, height: PAGE_H, onPinch: () => ink?.cancelTouch() });
  const { page, stage } = view;
  const onion = h("canvas", { class: "anim-sheet anim-onion", "aria-hidden": "true" });
  const inkHost = h("div", { class: "draw-layer active", id: "anim-ink" });
  const show = h("canvas", { class: "anim-sheet anim-show", id: "anim-show", hidden: true, "aria-hidden": "true" });
  page.append(onion, inkHost, show);
  const curDoc = () => (current ? frameDocOf(current) : "k:F-");
  const share = liveInk.on(curDoc);
  ink = new InkLayer({
    host: inkHost,
    grow: false,
    maxPixels: MAX_PIXELS,
    ink: () => session.doc(curDoc()),
    share,
    steady: () => getSettings(app.store).inkSteady ?? 1,
    blocked: () => view.pinching || !!playing,
    shapes: () => getSettings(app.store).inkShapes !== false,
    onShape: () => buzz(app),
    onPick: (color) => { pen.color = color; setTool(pen.tool); },
    onStroke: ({ pts, color, width, brush, shape }) => {
      if (readOnly() || !current) return null;
      const name = curDoc();
      const made = strokeOps(session.clock, session.doc(name), { pts, color, width, brush, shape, by: session.memberId });
      session.commit(name, made.ops);
      record(made.atoms.map((atom) => ({ ...atom, doc: name })));
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
  const speedChip = h("button", { class: "chip anim-chip", id: "anim-speed", type: "button", title: "1초에 몇 장", onclick: () => cycle("fps") });
  const loopChip = h("button", { class: "chip anim-chip", id: "anim-loop", type: "button", title: "다 돌면 어떻게", onclick: () => cycle("loop") });
  const toolbar = h("div", { class: "toolbar draw-tools anim-tools", id: "anim-tools" }, undoButton, redoButton, playButton, onionButton, speedChip, loopChip);
  body.after(strip, inkTools, toolbar);

  function drawTools() {
    const { fps, loop } = doc.settings();
    speedChip.textContent = `${fps}장/초`;
    loopChip.textContent = LOOP_NAMES[loop];
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
    ink.setStyle({ color: pen.color, width: pen.width, brush: pen.brush });
    drawInkTools(inkTools, { pen, setTool, store: app.store });
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

  /** One frame's strokes onto a context sized w × hgt; tint: every stroke in that one colour. */
  function paintFrame(g, id, w, hgt, tint = null) {
    g.setTransform(w / PAGE_W, 0, 0, hgt / PAGE_H, 0, 0);
    for (const s of session.doc(frameDocOf(id)).strokes()) paintStroke(g, s.pts, tint || s.c, s.w, brushOf(s), !!s.q);
  }

  const neighbours = () => {
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
    if (had && had.version === d.version && had.canvas.width === w && had.canvas.height === hgt) return had.canvas;
    const c = had?.canvas || document.createElement("canvas");
    c.width = w;
    c.height = hgt;
    const g = c.getContext("2d");
    if (g) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, w, hgt);
      paintFrame(g, id, w, hgt);
    }
    pictures.set(id, { version: d.version, canvas: c });
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
    paintFrame(g, id, c.width, c.height);
  }

  /** Where friends are: frame id → their colours. */
  function friendsOn() {
    const out = new Map();
    for (const peer of session.peers || []) {
      const f = peer.state?.anim?.f;
      const member = peer.state?.m ? session.room.member(peer.state.m) : null;
      if (peer.isMe || !f || !member) continue;
      if (!out.has(f)) out.set(f, []);
      out.get(f).push(memberColor(member.color, currentTheme()));
    }
    return out;
  }

  const addButton = h("button", { class: "anim-add", id: "anim-add", type: "button", "aria-label": "빈 장 더하기", onclick: () => addFrame() }, icon("plus"));
  const copyButton = h("button", { class: "anim-add", id: "anim-copy", type: "button", "aria-label": "이 장 복제해서 다음 장으로", onclick: () => duplicate() }, icon("copy"));
  function drawStrip() {
    const list = doc.frames();
    const friends = friendsOn();
    const keep = new Set(list.map((f) => f.id));
    for (const [id, { cell }] of cells) if (!keep.has(id)) { cell.remove(); cells.delete(id); }
    list.forEach((f, i) => {
      let entry = cells.get(f.id);
      if (!entry) {
        const thumb = h("canvas", { class: "anim-thumb", width: 54, height: 72, "aria-hidden": "true" });
        const cell = h("button", { class: "anim-frame", type: "button", role: "option", data: { frame: f.id } }, thumb, h("span", { class: "anim-num" }), h("span", { class: "anim-hold" }), h("span", { class: "anim-peers" }));
        wireCell(cell, f.id);
        entry = { cell, thumb };
        cells.set(f.id, entry);
        thumbSoon(f.id);
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

  /** A tap goes to the frame; held, its menu: 길게, 복제, 앞으로·뒤로, 지우기. */
  function wireCell(cell, id) {
    let timer = 0;
    let held = false;
    cell.addEventListener("pointerdown", () => {
      held = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        held = true;
        buzz(app, 8);
        frameMenu(cell, id);
      }, 480);
    });
    const off = () => clearTimeout(timer);
    cell.addEventListener("pointerup", off);
    cell.addEventListener("pointercancel", off);
    cell.addEventListener("pointerleave", off);
    cell.addEventListener("contextmenu", (e) => e.preventDefault());
    cell.addEventListener("click", () => {
      if (held) return;
      if (playing) stopPlay();
      select(id);
    });
  }

  let closeMenu = null;
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
    document.body.append(menu);
    const r = cell.getBoundingClientRect();
    const mr = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(innerWidth - mr.width - 8, r.left + r.width / 2 - mr.width / 2)) + "px";
    menu.style.top = Math.max(8, r.top - mr.height - 10) + "px";
    let stop = null;
    function close() {
      stop?.();
      menu.remove();
      if (closeMenu === close) closeMenu = null;
    }
    closeMenu = close;
    setTimeout(() => { if (menu.isConnected) stop = closeOnOutside((t) => menu.contains(t), close, menu); }, 0);
  }

  // ---- frames: choose, add, copy, take away -------------------------------------------------------

  function select(id) {
    if (!id) return;
    if (current !== id) {
      current = id;
      share.detach(ink);
      share.attach(ink);
      session.load(frameDocOf(id)).then(() => { if (alive && current === id) { ink.render(); paintOnion(); } });
      session.setPresencePart("anim", { f: id });
    }
    ink.render();
    paintOnion();
    drawStrip();
  }

  function addFrame() {
    if (readOnly() || doc.frames().length >= MAX_FRAMES) return;
    const made = addFrameOps(session.clock, doc, { by: session.memberId, after: current });
    if (apply(made)) select(made.id);
  }

  /** The animator's way: the frame copied as the next one, to change a little. */
  function duplicate() {
    if (readOnly() || !current || doc.frames().length >= MAX_FRAMES) return;
    const from = session.doc(frameDocOf(current));
    const made = addFrameOps(session.clock, doc, { by: session.memberId, after: current });
    session.commit("anim", made.ops);
    const atoms = made.atoms.map((atom) => ({ ...atom, doc: "anim" }));
    const name = frameDocOf(made.id);
    for (const s of from.strokes()) {
      const one = strokeOps(session.clock, session.doc(name), { pts: s.pts, color: s.c, width: s.w, brush: s.b || "pen", style: s.s, shape: !!s.q, by: session.memberId });
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

  function cycle(key) {
    const now = doc.settings();
    const choices = key === "fps" ? FPS_CHOICES : LOOPS;
    const next = choices[(choices.indexOf(now[key]) + 1) % choices.length];
    apply(setAnimOps(session.clock, doc, { [key]: next }));
  }

  // ---- changes, undo --------------------------------------------------------------------------------

  function record(atoms) {
    if (atoms.length) undo.record(atoms, { now: Date.now(), typing: false });
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
    if (!doc.frame(current) || doc.frame(current).removed) select(doc.frames()[0]?.id);
    drawStrip();
    ink.render();
    paintOnion();
  }

  // Procreate's taps: two fingers 되돌리기, three 다시하기.
  const stopTaps = watchFingerTaps(stage, {
    two: () => { if (undo.canUndo) { step("undo"); flashHint("되돌리기"); } },
    three: () => { if (undo.canRedo) { step("redo"); flashHint("다시하기"); } },
  });

  // ---- start --------------------------------------------------------------------------------------

  let peersTimer = 0;
  const offs = [
    session.on("change", ({ doc: name }) => {
      if (name === "anim") {
        if (current && (!doc.frame(current) || doc.frame(current).removed)) select(doc.frames()[0]?.id);
        drawStrip();
        drawTools();
        paintOnion();
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
  const resize = new ResizeObserver(() => { if (!playing) paintOnion(); else fitCanvas(show); });
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
    drawTools();
    view.fit();
  });
  setTool(pen.tool);
  drawTools();
  drawStrip();

  return {
    close() {
      alive = false;
      stopPlay();
      closeMenu?.();
      for (const off of offs) off();
      clearTimeout(peersTimer);
      resize.disconnect();
      view.destroy();
      stopTaps();
      ink.destroy();
      liveInk.close();
      session.setPresencePart("anim", null);
      strip.remove();
      inkTools.remove();
      toolbar.remove();
    },
  };
}
