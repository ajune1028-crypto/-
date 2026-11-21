// 그림 방: one page drawn on together, in layers (the owner: "그림 방도 만들고… 실시간으로 같이 그림
// 그리는 거", "레이어는 이거에서 하면 좋고"). Friends' strokes come in as they are drawn. The layers
// follow Klecks (MIT): name, shown or hidden, opacity, blend mode, order, at most 16; each layer's
// strokes are their own drawing document, drawn with the same brushes as everywhere (ui/ink.js).
// Two fingers zoom and move the page; one draws.

import { h, icon, iconButton, toast, closeOnOutside, flashHint } from "./dom.js";
import { openTimelapse } from "./timelapse.js";
import { personColor } from "../core/paint.js";
import { currentTheme } from "./theme.js";
import { watchFingerTaps } from "./fingers.js";
import { pageStage } from "./page-stage.js";
import { InkLayer, drawInkTools, paintStroke, pixelAt, lassoActions } from "./ink.js";
import { LiveInk } from "./live-ink.js";
import { addLayerOps, setLayerOps, removeLayerOps, moveLayerOps, invertDrawOps, inkDocOf, BLEND_MODES, MAX_LAYERS, PAPERS, paperOps } from "../core/draw.js";
import { strokeOps, eraseOps, invertInkOps, brushOf, widthOf, moveStrokesOps } from "../core/ink.js";
import { UndoStack } from "../core/undo.js";
import { getSettings, setSetting } from "../identity.js";
import { buzz } from "./chime.js";

/** The page, in stroke units (hundredths of a rem): 22.5 × 30 rem, a phone's width at 1×. */
export const PAGE_W = 2250;
export const PAGE_H = 3000;
const BLEND_NAMES = { "source-over": "보통", multiply: "곱하기", screen: "스크린", overlay: "오버레이", darken: "어둡게", lighten: "밝게", "color-dodge": "닷지", "color-burn": "번", "hard-light": "하드 라이트", "soft-light": "소프트 라이트", difference: "차이", exclusion: "제외", hue: "색조", saturation: "채도", color: "색", luminosity: "광도" };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** A paper's colour (null for 투명). */
const paperColour = (key) => (PAPERS.find(([k]) => k === key) || PAPERS[0])[1];

export function mountDrawRoom(body, app, session, frame) {
  const root = app.root;
  const doc = session.doc("draw");
  const undo = new UndoStack(100, 0);
  const readOnly = () => !!session.transport.readOnly;
  let alive = true;
  let active = null; // the layer I draw on
  const pen = { tool: "pen", brush: getSettings(app.store).inkBrush || "pen", color: "black", width: 2 };
  const hosts = new Map(); // layer id → { el, ink }
  // Friends' lines while they draw them and their pointer's light, on whichever layer they draw.
  const liveInk = new LiveInk(session);

  // The page fitted to the screen; two fingers zoom and move it (ui/page-stage.js).
  const view = pageStage(body, { id: "draw", width: PAGE_W, height: PAGE_H, onPinch: () => { for (const { ink } of hosts.values()) ink.cancelTouch(); } });
  const { page, stage } = view;
  const inkTools = h("div", { class: "ink-tools", id: "ink-tools", role: "toolbar", "aria-label": "그리기 도구" });
  const panel = h("aside", { class: "layers-panel", id: "layers-panel", hidden: true, "aria-label": "레이어" });
  const undoButton = iconButton("draw-undo", "undo", "되돌리기", () => step("undo"), "되돌리기");
  const redoButton = iconButton("draw-redo", "redo", "다시하기", () => step("redo"), "다시하기");
  const layersButton = iconButton("draw-layers", "layers", "레이어", () => showPanel(panel.hidden), "레이어");
  const saveButton = iconButton("draw-save", "save", "그림을 이미지로 저장", () => saveImage(), "저장");
  const replayButton = iconButton("draw-replay", "replay", "그린 과정 보기 (누가 언제 그렸는지 처음부터)", () => showReplay(), "과정");
  const toolbar = h("div", { class: "toolbar draw-tools", id: "draw-tools" }, undoButton, redoButton, layersButton, replayButton, saveButton);
  body.append(panel);
  body.after(inkTools, toolbar);

  // The brush's size is on the tools' rail (ui/ink.js), as in every room that draws.

  // Procreate's taps: two fingers 되돌리기, three 다시하기.
  const stopTaps = watchFingerTaps(stage, {
    two: () => { if (undo.canUndo) { step("undo"); flashHint("되돌리기"); } },
    three: () => { if (undo.canRedo) { step("redo"); flashHint("다시하기"); } },
  });
  // ---- layers on the page ---------------------------------------------------------------------

  function layerHost(layer) {
    let entry = hosts.get(layer.id);
    if (entry) return entry;
    const el = h("div", { class: "draw-layer", data: { layer: layer.id } });
    const name = inkDocOf(layer.id);
    const keepInk = (made) => {
      session.commit(name, made.ops);
      record(made.atoms.map((atom) => ({ ...atom, doc: name })));
      thumbSoon(layer.id);
    };
    let lasso = null;
    const ink = new InkLayer({
      // 올가미 on this layer: lines drawn round are held, taken anywhere, recoloured, copied or rubbed out.
      onLasso: (info) => lasso?.show(info),
      onLassoMove: (ids, dx, dy) => {
        const made = moveStrokesOps(session.clock, session.doc(name), ids, dx, dy, session.memberId);
        keepInk(made);
        return made.ops.filter((o) => o.t === "stroke").map((o) => o.id);
      },
      host: el,
      ink: () => session.doc(name),
      share: liveInk.on(name),
      steady: () => getSettings(app.store).inkSteady ?? 1,
      onPick: (color) => { pen.color = color; setTool(pen.tool); },
      pick: (x, y) => colorAt(x, y),
      blocked: () => view.pinching,
      grow: false,
      maxPixels: 3.2e6,
      shapes: () => getSettings(app.store).inkShapes !== false,
      onShape: () => buzz(app),
      onStroke: ({ pts, color, width, size, brush, shape }) => {
        if (readOnly()) return;
        const made = strokeOps(session.clock, session.doc(name), { pts, color, width, size, brush, shape, by: session.memberId });
        session.commit(name, made.ops);
        record(made.atoms.map((atom) => ({ ...atom, doc: name })));
        thumbSoon(layer.id);
        return made.ops[0]?.id;
      },
      onErase: (id) => {
        const made = eraseOps(session.clock, session.doc(name), id);
        session.commit(name, made.ops);
        record(made.atoms.map((atom) => ({ ...atom, doc: name })));
        thumbSoon(layer.id);
      },
    });
    lasso = lassoActions({ ink, doc: () => session.doc(name), clock: session.clock, by: session.memberId, commit: keepInk });
    entry = { el, ink };
    hosts.set(layer.id, entry);
    session.load(name).then(() => { if (alive) { ink.render(); thumbSoon(layer.id); } });
    return entry;
  }

  /**
   * 스포이트 on the page: the colour that shows at a point, the visible layers from the top down
   * (the first one with ink there, through its opacity).
   */
  function colorAt(x, y) {
    for (const layer of doc.layers().slice().reverse()) {
      if (!layer.visible || layer.opacity <= 0.05) continue;
      const c = hosts.get(layer.id)?.ink.canvas;
      const got = c && pixelAt(c, x, y);
      if (got) return got;
    }
    return null;
  }

  /** The page as the layers are now: order, shown or hidden, opacity, blend; only mine takes the pen. */
  function drawLayers() {
    // 종이 under them all (the owner, 21 November: "종이의 개념이고 뒷배경을 투명하게 할 수도").
    const paper = doc.paper();
    page.dataset.paper = paper;
    page.style.setProperty("--paper-c", paperColour(paper) || "transparent");
    const list = doc.layers();
    if (active && !list.some((l) => l.id === active)) active = null;
    if (!active && list.length) active = list[list.length - 1].id;
    const keep = new Set(list.map((l) => l.id));
    for (const [id, entry] of hosts) {
      if (keep.has(id)) continue;
      entry.ink.destroy();
      entry.el.remove();
      hosts.delete(id);
    }
    for (const layer of list) {
      const { el, ink } = layerHost(layer);
      el.style.opacity = String(layer.opacity);
      el.style.mixBlendMode = layer.mode === "source-over" ? "normal" : layer.mode;
      el.hidden = !layer.visible;
      el.classList.toggle("active", layer.id === active);
      page.append(el); // in order, bottom first
      const tool = layer.id === active && layer.visible && !readOnly() ? pen.tool : null;
      if (ink.tool !== tool) ink.setTool(tool);
      ink.setStyle({ color: pen.color, width: pen.width, brush: pen.brush, size: pen.size || null });
    }
    drawInkTools(inkTools, { pen, setTool, store: app.store, lasso: true, units: () => hosts.get(active)?.ink.unitsPerPx() || 1 });
    if (!panel.hidden) drawPanel();
    layersButton.dataset.count = String(list.length);
  }

  function setTool(tool) {
    pen.tool = tool;
    drawLayers();
  }

  // ---- the layers panel -----------------------------------------------------------------------

  // The panel is a little window over the page: a press on the page outside it only puts it away
  // (that press draws nothing), as with every menu in the app; the tool rows stay pressable.
  let stopOutside = null;
  function showPanel(on) {
    panel.hidden = !on;
    layersButton.setAttribute("aria-pressed", String(on));
    stopOutside?.();
    stopOutside = null;
    if (!on) return;
    drawPanel();
    stopOutside = closeOnOutside((t) => panel.contains(t), () => { stopOutside = null; showPanel(false); }, panel);
  }

  const thumbs = new Map(); // layer id → canvas
  const thumbWaiting = new Set();
  function thumbSoon(id) {
    thumbWaiting.add(id);
    requestAnimationFrame(() => {
      for (const one of thumbWaiting) paintThumb(one);
      thumbWaiting.clear();
    });
  }
  function paintThumb(id) {
    const c = thumbs.get(id);
    if (!c) return;
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.setTransform(c.width / PAGE_W, 0, 0, c.height / PAGE_H, 0, 0);
    for (const s of session.doc(inkDocOf(id)).strokes()) paintStroke(g, s.pts, s.c, widthOf(s), brushOf(s), !!s.q);
  }

  function drawPanel() {
    const list = doc.layers().slice().reverse(); // top first, as one looks at them
    const can = !readOnly();
    panel.replaceChildren(
      h("div", { class: "layers-head" },
        h("h2", { class: "layers-title", text: "레이어" }),
        can && h("button", { class: "chip", id: "layer-add", type: "button", disabled: list.length >= MAX_LAYERS, onclick: () => addLayer() }, icon("plus"), "레이어")),
      h("div", { class: "layers-list", id: "layers-list" }, list.map((layer) => {
        const on = layer.id === active;
        const thumb = thumbs.get(layer.id) || h("canvas", { class: "layer-thumb", width: 45, height: 60, "aria-hidden": "true" });
        thumbs.set(layer.id, thumb);
        thumbSoon(layer.id);
        const row = h("div", { class: "layer-row" + (on ? " active" : ""), data: { layer: layer.id } },
          h("button", { class: "layer-pick", type: "button", "aria-pressed": String(on), "aria-label": layer.name + (on ? " (그리는 레이어)" : " 고르기"), onclick: () => { active = layer.id; drawLayers(); } },
            thumb, h("span", { class: "layer-name", text: layer.name }),
            layer.mode !== "source-over" && h("span", { class: "layer-mode", text: BLEND_NAMES[layer.mode] })),
          h("button", { class: "icon-btn layer-eye", type: "button", data: { eye: layer.id }, "aria-pressed": String(layer.visible), "aria-label": layer.visible ? "숨기기" : "보이기",
            onclick: () => change(layer.id, { visible: !layer.visible }) }, icon(layer.visible ? "eye" : "eyeOff")));
        if (on && can) row.append(layerControls(layer, list));
        return row;
      })),
      // 종이 at the bottom, under every layer (as Procreate's background colour lies under its layers).
      paperRow(can));
  }

  function paperRow(can) {
    const paper = doc.paper();
    const [, colour, name] = PAPERS.find(([k]) => k === paper) || PAPERS[0];
    return h("div", { class: "paper-row", id: "paper-row" },
      h("span", { class: "paper-swatch" + (colour ? "" : " clear"), style: colour ? { background: colour } : {}, "aria-hidden": "true" }),
      h("span", { class: "layer-name", text: "종이 · " + name }),
      can && h("div", { class: "paper-choices", role: "group", "aria-label": "종이" },
        PAPERS.map(([k, c, label]) => h("button", { class: "paper-pick" + (c ? "" : " clear"), type: "button", data: { paper: k }, "aria-pressed": String(k === paper), "aria-label": label, title: label,
          style: c ? { background: c } : {}, onclick: () => { if (k !== paper) apply(paperOps(session.clock, doc, k)); } }))));
  }

  function layerControls(layer, list) {
    const opacity = h("input", { type: "range", class: "layer-opacity", id: "layer-opacity", min: 0, max: 100, step: 1, value: Math.round(layer.opacity * 100), "aria-label": "불투명도",
      oninput: () => { const el = hosts.get(layer.id)?.el; if (el) el.style.opacity = String(opacity.value / 100); },
      onchange: () => change(layer.id, { opacity: Number(opacity.value) / 100 }) });
    const mode = h("select", { class: "input layer-blend", id: "layer-blend", "aria-label": "섞는 방식", onchange: () => change(layer.id, { mode: mode.value }) },
      BLEND_MODES.map((m) => h("option", { value: m, selected: m === layer.mode, text: BLEND_NAMES[m] })));
    const at = list.findIndex((l) => l.id === layer.id); // 0 is the top
    return h("div", { class: "layer-controls" },
      h("label", { class: "layer-label" }, "불투명", opacity, h("span", { class: "layer-pct", text: Math.round(layer.opacity * 100) + "%" })),
      mode,
      h("div", { class: "layer-actions" },
        h("button", { class: "chip", id: "layer-up", type: "button", disabled: at === 0, onclick: () => apply(moveLayerOps(session.clock, doc, layer.id, 1)) }, "↑ 위로"),
        h("button", { class: "chip", id: "layer-down", type: "button", disabled: at === list.length - 1, onclick: () => apply(moveLayerOps(session.clock, doc, layer.id, -1)) }, "↓ 아래로"),
        h("button", { class: "chip", id: "layer-rename", type: "button", onclick: () => rename(layer) }, "이름"),
        h("button", { class: "chip danger", id: "layer-remove", type: "button", disabled: list.length <= 1, onclick: () => { apply(removeLayerOps(session.clock, doc, layer.id)); toast(root, "레이어를 지웠어요 (되돌리기로 살려요)"); } }, "지우기")));
  }

  function rename(layer) {
    const row = panel.querySelector(`.layer-row[data-layer="${layer.id}"] .layer-name`);
    if (!row) return;
    const input = h("input", { class: "input layer-name-input", id: "layer-name-input", value: layer.name, maxlength: 30, "aria-label": "레이어 이름" });
    const done = () => {
      if (!input.isConnected) return;
      const name = input.value.trim();
      if (name && name !== layer.name) change(layer.id, { name });
      else drawPanel();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(); if (e.key === "Escape") drawPanel(); });
    input.addEventListener("blur", done);
    row.replaceWith(input);
    input.focus();
    input.select();
  }

  // ---- changes, undo --------------------------------------------------------------------------

  function record(atoms) {
    if (atoms.length) undo.record(atoms, { now: Date.now(), typing: false });
    undoButton.disabled = !undo.canUndo;
    redoButton.disabled = !undo.canRedo;
  }

  function apply(made) {
    if (!made?.ops?.length || readOnly()) return false;
    session.commit("draw", made.ops);
    record(made.atoms.map((atom) => ({ ...atom, doc: "draw" })));
    drawLayers();
    return true;
  }

  const change = (id, fields) => apply(setLayerOps(session.clock, doc, id, fields));

  function addLayer() {
    if (doc.layers().length >= MAX_LAYERS) return void toast(root, `레이어는 ${MAX_LAYERS}개까지예요`);
    const made = addLayerOps(session.clock, doc, { by: session.memberId });
    if (apply(made)) {
      active = made.id;
      drawLayers();
    }
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
      if (name === "draw") session.commit("draw", invertDrawOps(doc, session.clock, list, dir));
      else session.commit(name, invertInkOps(session.doc(name), session.clock, list, dir));
    }
    record([]);
    drawLayers();
    for (const { ink } of hosts.values()) ink.render();
  }

  // ---- 저장: the page as a picture --------------------------------------------------------------

  // 타임랩스: the page made again from its first line, each line with the name of the one who drew it.
  function showReplay() {
    const list = doc.layers().filter((l) => l.visible).map((l) => ({ strokes: session.doc(inkDocOf(l.id)).strokes(), opacity: l.opacity, mode: l.mode }));
    if (!list.some((l) => l.strokes.length)) return void toast(root, "아직 그린 것이 없어요");
    openTimelapse({
      root,
      layers: list,
      pageW: PAGE_W,
      pageH: PAGE_H,
      paper: paperColour(doc.paper()) || "rgba(0, 0, 0, 0)",
      nameOf: (m) => (m === session.memberId ? "나" : session.room.member(m)?.name || "친구"),
      colorOf: (m) => { const member = session.room.member(m); return member ? personColor(member, currentTheme()) : "#8c919c"; },
      title: session.room.meta("name") || "그림",
    });
  }

  function saveImage() {
    const scale = 3; // 1080 × 1440 pixels
    const w = Math.round((PAGE_W / 100) * 16 * scale);
    const hgt = Math.round((PAGE_H / 100) * 16 * scale);
    const out = document.createElement("canvas");
    out.width = w;
    out.height = hgt;
    const g = out.getContext("2d");
    if (!g) return;
    // A clear paper stays clear in the image (a PNG with nothing behind the drawing).
    const paper = paperColour(doc.paper());
    if (paper) {
      g.fillStyle = paper;
      g.fillRect(0, 0, w, hgt);
    }
    for (const layer of doc.layers()) {
      if (!layer.visible) continue;
      const one = document.createElement("canvas");
      one.width = w;
      one.height = hgt;
      const lg = one.getContext("2d");
      lg.setTransform(w / PAGE_W, 0, 0, hgt / PAGE_H, 0, 0);
      for (const s of session.doc(inkDocOf(layer.id)).strokes()) paintStroke(lg, s.pts, s.c, widthOf(s), brushOf(s), !!s.q);
      g.globalAlpha = layer.opacity;
      g.globalCompositeOperation = layer.mode;
      g.drawImage(one, 0, 0);
    }
    out.toBlob((blob) => {
      if (!blob) return void toast(root, "저장하지 못했어요");
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: `${session.room.meta("name") || "그림"}.png` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(root, "그림을 이미지로 저장했어요");
    }, "image/png");
  }

  // ---- start ----------------------------------------------------------------------------------

  const offs = [
    session.on("change", ({ doc: name }) => {
      if (name === "draw") drawLayers();
      else if (name.startsWith("k:L")) {
        const id = name.slice(3);
        hosts.get(id)?.ink.render();
        thumbSoon(id);
      }
    }),
  ];
  session.load("draw").then(() => {
    if (!alive) return;
    // An empty page starts with one layer.
    if (!doc.layers().length && !readOnly()) {
      const made = addLayerOps(session.clock, doc, { name: "레이어 1", by: session.memberId });
      session.commit("draw", made.ops);
      active = made.id;
    }
    drawLayers();
    view.fit();
  });
  record([]);
  drawLayers();

  return {
    close() {
      alive = false;
      stopOutside?.();
      for (const off of offs) off();
      view.destroy();
      stopTaps();
      for (const { ink } of hosts.values()) ink.destroy();
      liveInk.close();
      inkTools.remove();
      toolbar.remove();
    },
  };
}
