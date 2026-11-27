// 그림 방: one page drawn on together, in layers (the owner: "그림 방도 만들고… 실시간으로 같이 그림
// 그리는 거", "레이어는 이거에서 하면 좋고"). Friends' strokes come in as they are drawn. The layers
// follow Klecks (MIT): name, shown or hidden, opacity, blend mode, order, at most 16; each layer's
// strokes are their own drawing document, drawn with the same brushes as everywhere (ui/ink.js).
// Two fingers zoom and move the page; one draws.

import { h, icon, iconButton, toast, closeOnOutside, flashHint } from "./dom.js";
import { openTimelapse } from "./timelapse.js";
import { personColor } from "../core/paint.js";
import { currentTheme } from "./theme.js";
import { watchFingerTaps, toggleBare } from "./fingers.js";
import { pageStage } from "./page-stage.js";
import { releasePieces } from "./ink-pieces.js";
import { InkLayer, drawInkTools, paintStroke, pixelAt, lassoActions, fixedInk, landInk, boardStrokesCarried, keepRailBetween, paintLayers, watchPick } from "./ink.js";
import { copyItem } from "../clipboard.js";
import { LiveInk } from "./live-ink.js";
import { addLayerOps, setLayerOps, removeLayerOps, moveLayerOps, invertDrawOps, inkDocOf, BLEND_MODES, MAX_LAYERS, PAPERS, paperOps } from "../core/draw.js";
import { strokeOps, eraseOps, invertInkOps, brushOf, widthOf, opacityOf, moveStrokesOps, mergeStrokesOps } from "../core/ink.js";
import { UndoStack } from "../core/undo.js";
import { getSettings, setSetting, roomEntry } from "../identity.js";
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
  const view = pageStage(body, { id: "draw", width: PAGE_W, height: PAGE_H, onPinch: () => { for (const { ink } of hosts.values()) ink.cancelTouch(); }, avoid: () => inkTools });
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
  // The rail keeps between the bars (never over the toolbar), and the page fits beside it.
  const offBand = keepRailBetween(inkTools);

  // The brush's size is on the tools' rail (ui/ink.js), as in every room that draws.

  // Procreate's taps: two fingers 되돌리기, three 다시하기.
  const stopTaps = watchFingerTaps(stage, {
    two: () => { if (undo.canUndo) { step("undo"); flashHint("되돌리기"); } },
    three: () => { if (undo.canRedo) { step("redo"); flashHint("다시하기"); } },
    four: () => toggleBare(stage.closest(".room"), flashHint),
  });
  // 스포이트: two fingers held still pick the colour that shows between them (every visible layer).
  const stopPick = watchPick(stage, () => hosts.get(active)?.ink || null);
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
      fixedInk: true,
      // 알파 잠금: new lines only over what this layer has; 클리핑: shown only where the layer below has ink.
      inside: () => !!doc.layer(layer.id)?.lock,
      clipTo: () => clipBase(layer.id),
      afterRender: () => { for (const above of clippedAbove(layer.id)) above.ink.render(); },
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
      steady: () => getSettings(app.store).inkSteady ?? 0,
      onPick: (color) => { pen.color = color; setTool(pen.tool); },
      pick: (x, y) => colorAt(x, y),
      blocked: () => view.pinching,
      grow: false,
      maxPixels: 3.2e6,
      shapes: () => getSettings(app.store).inkShapes !== false,
      onShape: () => buzz(app),
      onStroke: ({ pts, color, width, size, brush, shape, opacity, inside, cont }) => {
        if (readOnly()) return;
        const made = strokeOps(session.clock, session.doc(name), { pts, color: fixedInk(color), width, size, brush, shape, opacity, inside, by: session.memberId });
        session.commit(name, made.ops);
        record(made.atoms.map((atom) => ({ ...atom, doc: name })), cont);
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
    const kit = { ink, doc: () => session.doc(name), clock: session.clock, by: session.memberId, commit: keepInk };
    lasso = lassoActions({ ...kit, carry: carryInk });
    entry = { el, ink, kit };
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
      const base = layer.clip ? baseOf(list, list.indexOf(layer)) : null;
      el.hidden = !layer.visible || (layer.clip && !!base && !base.visible);
      // Clipped now (or to another layer) than when last drawn: drawn again (here or from a friend).
      const entry = hosts.get(layer.id);
      const clipKey = layer.clip ? "clip:" + (base?.id || "") : "";
      if (entry && entry.clipKey !== clipKey) {
        const was = entry.clipKey;
        entry.clipKey = clipKey;
        if (was !== undefined) requestAnimationFrame(() => entry.ink.render());
      }
      el.classList.toggle("active", layer.id === active);
      page.append(el); // in order, bottom first
      const tool = layer.id === active && layer.visible && !readOnly() ? pen.tool : null;
      if (ink.tool !== tool) ink.setTool(tool);
      ink.setStyle({ color: pen.color, width: pen.width, brush: pen.brush, size: pen.size || null });
    }
    drawInkTools(inkTools, { pen, setTool, store: app.store, lasso: true, fixedInk: true, units: () => hosts.get(active)?.ink.unitsPerPx() || 1,
      restyle: () => { for (const { ink } of hosts.values()) ink.setStyle({ color: pen.color, width: pen.width, brush: pen.brush, size: pen.size || null }); },
      pieces: "creative-draw", drop: (x, y) => dropFill(x, y) });
    if (!panel.hidden) drawPanel();
    layersButton.dataset.count = String(list.length);
  }

  /** 컬러드롭: the colour let go on the page fills there, on the layer being drawn (as 채우기 does). */
  function dropFill(x, y) {
    const r = page.getBoundingClientRect();
    const entry = hosts.get(active);
    if (readOnly() || !entry || !doc.layer(active)?.visible || x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
    entry.ink.fillAt({ clientX: x, clientY: y });
    return true;
  }

  function setTool(tool) {
    pen.tool = tool;
    drawLayers();
  }

  /** Drawings copied with the 올가미 go into 비서's 바구니, to be put into another room. */
  function carryInk(strokes) {
    if (!strokes.length) return;
    copyItem(app.store, { kind: "ink", strokes }, { room: session.roomId, name: roomEntry(app.store, session.roomId)?.name || "", kind: "creative-draw" });
    toast(root, `그림 ${strokes.length}획을 복사했어요. 다른 방에서 비서의 '여기에 놓기'로 꺼내요`, 3200);
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
    opened = null; // it opens small, every time
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
    for (const s of session.doc(inkDocOf(id)).strokes()) paintStroke(g, s.pts, fixedInk(s.c), widthOf(s), brushOf(s), !!s.q, opacityOf(s), !!s.a);
  }

  /** The layer a clipping layer is clipped to: the nearest one below that is not clipping itself (as in Procreate). */
  function baseOf(list, i) {
    let j = i - 1;
    while (j >= 0 && list[j].clip) j--;
    return j >= 0 ? list[j] : null;
  }

  /** 클리핑: the canvas a layer is clipped to, or null. */
  function clipBase(id) {
    const list = doc.layers();
    const i = list.findIndex((l) => l.id === id);
    if (i <= 0 || !list[i].clip) return null;
    const base = baseOf(list, i);
    return base ? hosts.get(base.id)?.ink.canvas || null : null;
  }

  /** The clipping layers resting on this one (they are drawn again after it). */
  function clippedAbove(id) {
    const list = doc.layers();
    const i = list.findIndex((l) => l.id === id);
    if (i < 0 || list[i].clip) return [];
    const out = [];
    for (let j = i + 1; j < list.length && list[j].clip; j++) {
      const entry = hosts.get(list[j].id);
      if (entry) out.push(entry);
    }
    return out;
  }

  /** 아래로 합치기: this layer's lines go into the layer below (on top of its own), and this layer goes; one undo. */
  function mergeDown(layer) {
    const list = doc.layers();
    const i = list.findIndex((l) => l.id === layer.id);
    if (i <= 0 || readOnly()) return;
    const below = list[i - 1];
    const fromName = inkDocOf(layer.id);
    const intoName = inkDocOf(below.id);
    const made = mergeStrokesOps(session.clock, session.doc(fromName), session.doc(intoName), session.memberId);
    session.commit(intoName, made.into.ops);
    session.commit(fromName, made.from.ops);
    const gone = removeLayerOps(session.clock, doc, layer.id);
    session.commit("draw", gone.ops);
    record([...made.into.atoms.map((a) => ({ ...a, doc: intoName })), ...made.from.atoms.map((a) => ({ ...a, doc: fromName })), ...gone.atoms.map((a) => ({ ...a, doc: "draw" }))]);
    active = below.id;
    drawLayers();
    thumbSoon(below.id);
    toast(root, `'${below.name}'에 합쳤어요 (되돌리기로 나눠요)`);
  }

  // What is opened under a layer's row, if anything (one at a time): its actions, or its look
  // (불투명 and 섞기). Nothing at first: the list stays small (the owner, 27 November: "UI를 처음부터
  // 그렇게 뜨고 그러는 거 좀 비효율적" - Procreate's layers: tap the layer for its options, 'N' for its look).
  let opened = null;
  function drawPanel() {
    const list = doc.layers().slice().reverse(); // top first, as one looks at them
    const can = !readOnly();
    if (opened && !list.some((l) => l.id === opened.id)) opened = null;
    panel.replaceChildren(
      h("div", { class: "layers-head" },
        h("h2", { class: "layers-title", text: "레이어" }),
        can && h("button", { class: "chip", id: "layer-add", type: "button", disabled: list.length >= MAX_LAYERS, onclick: () => addLayer() }, icon("plus"), "레이어")),
      h("div", { class: "layers-list", id: "layers-list" }, list.map((layer) => {
        const on = layer.id === active;
        const thumb = thumbs.get(layer.id) || h("canvas", { class: "layer-thumb", width: 45, height: 60, "aria-hidden": "true" });
        thumbs.set(layer.id, thumb);
        thumbSoon(layer.id);
        const open = opened?.id === layer.id ? opened.what : null;
        const look = (layer.mode === "source-over" ? "보통" : BLEND_NAMES[layer.mode]) + " " + Math.round(layer.opacity * 100) + "%";
        const row = h("div", { class: "layer-row" + (on ? " active" : "") + (open ? " open" : ""), data: { layer: layer.id } },
          // Another layer: draw on it. The layer drawn on, again: its actions open (and close).
          h("button", { class: "layer-pick", type: "button", "aria-pressed": String(on), "aria-expanded": String(open === "actions"), "aria-label": layer.name + (on ? " (그리는 레이어, 누르면 할 일)" : " 고르기"),
            onclick: () => {
              if (!on) {
                active = layer.id;
                opened = null;
                return void drawLayers();
              }
              opened = open === "actions" || !can ? null : { id: layer.id, what: "actions" };
              drawPanel();
            } },
            thumb,
            h("span", { class: "layer-text" },
              h("span", { class: "layer-name", text: layer.name }),
              // 알파 잠금 and 클리핑 at a glance (as Procreate marks them), under the name.
              (layer.lock || layer.clip) && h("span", { class: "layer-marks" },
                layer.clip && h("span", { data: { mark: "clip" }, text: "↳ 클리핑" }),
                layer.lock && h("span", { data: { mark: "lock" }, text: "알파 잠금" })))),
          // Its look (섞기 and 불투명) in a word; pressed, the slider and the ways of blending open under it.
          can && h("button", { class: "layer-look", type: "button", data: { look: layer.id }, "aria-expanded": String(open === "look"), "aria-label": "섞기와 불투명 " + look,
            onclick: () => { opened = open === "look" ? null : { id: layer.id, what: "look" }; drawPanel(); } }, look),
          h("button", { class: "icon-btn layer-eye", type: "button", data: { eye: layer.id }, "aria-pressed": String(layer.visible), "aria-label": layer.visible ? "숨기기" : "보이기",
            onclick: () => change(layer.id, { visible: !layer.visible }) }, icon(layer.visible ? "eye" : "eyeOff")));
        if (open === "look") row.append(layerLook(layer));
        else if (open === "actions") row.append(layerActions(layer, list));
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

  /** A layer's look: 불투명 and how it blends with what is under it. */
  function layerLook(layer) {
    const pct = h("span", { class: "layer-pct", text: Math.round(layer.opacity * 100) + "%" });
    const opacity = h("input", { type: "range", class: "layer-opacity", id: "layer-opacity", min: 0, max: 100, step: 1, value: Math.round(layer.opacity * 100), "aria-label": "불투명도",
      oninput: () => { const el = hosts.get(layer.id)?.el; if (el) el.style.opacity = String(opacity.value / 100); pct.textContent = opacity.value + "%"; },
      onchange: () => change(layer.id, { opacity: Number(opacity.value) / 100 }) });
    const mode = h("select", { class: "input layer-blend", id: "layer-blend", "aria-label": "섞는 방식", onchange: () => change(layer.id, { mode: mode.value }) },
      BLEND_MODES.map((m) => h("option", { value: m, selected: m === layer.mode, text: BLEND_NAMES[m] })));
    return h("div", { class: "layer-controls" }, h("label", { class: "layer-label" }, "불투명", opacity, pct), mode);
  }

  /** What a layer can be asked to do (Procreate's layer options, the few that matter here). */
  function layerActions(layer, list) {
    const at = list.findIndex((l) => l.id === layer.id); // 0 is the top
    return h("div", { class: "layer-controls" },
      h("div", { class: "layer-actions" },
        h("button", { class: "chip", id: "layer-up", type: "button", disabled: at === 0, onclick: () => apply(moveLayerOps(session.clock, doc, layer.id, 1)) }, "↑ 위로"),
        h("button", { class: "chip", id: "layer-down", type: "button", disabled: at === list.length - 1, onclick: () => apply(moveLayerOps(session.clock, doc, layer.id, -1)) }, "↓ 아래로"),
        h("button", { class: "chip", id: "layer-rename", type: "button", onclick: () => rename(layer) }, "이름"),
        h("button", { class: "chip", id: "layer-lock", type: "button", "aria-pressed": String(!!layer.lock), title: "칠한 곳 안에만 그려요", onclick: () => change(layer.id, { lock: !layer.lock }) }, "알파 잠금"),
        h("button", { class: "chip", id: "layer-clip", type: "button", "aria-pressed": String(!!layer.clip), disabled: at === list.length - 1, title: "아래 레이어에 그린 곳 안에만 보여요", onclick: () => change(layer.id, { clip: !layer.clip }) }, "클리핑"),
        h("button", { class: "chip", id: "layer-merge", type: "button", disabled: at === list.length - 1, onclick: () => mergeDown(layer) }, "아래로 합치기"),
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

  /** cont: a part of one line drawn in pieces (its look changed mid-line): one step with the parts before it. */
  function record(atoms, cont = null) {
    if (atoms.length) undo.record(atoms, { now: Date.now(), typing: false, group: cont || null });
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
      fixed: true,
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
    paintLayers(g, doc.layers().map((layer) => ({ ...layer, strokes: session.doc(inkDocOf(layer.id)).strokes() })), w, hgt, [w / PAGE_W, 0, 0, hgt / PAGE_H, 0, 0]);
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
    /** 비서's 바구니: drawings (from any room, a whiteboard's too) land on the layer being drawn on. */
    takes(item) {
      return !readOnly() && ((item.kind === "ink" && !!item.strokes?.length) || (item.kind === "board-items" && !!item.strokes?.length));
    },
    put(item) {
      const layer = doc.layers().find((l) => l.id === active);
      if (!layer) return;
      const entry = layerHost(layer);
      setTool("lasso");
      landInk(entry.kit, item.kind === "ink" ? item.strokes : boardStrokesCarried(item.strokes));
    },
    close() {
      alive = false;
      stopOutside?.();
      for (const off of offs) off();
      view.destroy();
      stopTaps();
      stopPick();
      for (const { ink } of hosts.values()) ink.destroy();
      liveInk.close();
      offBand();
      releasePieces(inkTools);
      inkTools.remove();
      toolbar.remove();
    },
  };
}
