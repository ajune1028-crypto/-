// The shared sheets of a daily text room: one sheet per day, newest at the bottom.

import { h, icon, iconButton, mount, toast } from "./dom.js";
import { watchPickers } from "./picker-watch.js";
import { watchFingers } from "./fingers.js";
import { onThemeChange } from "./theme.js";
import { SheetEditor } from "./editor.js";
import { UndoStack } from "../core/undo.js";
import { invertOps, spliceOps, attachOps, detachOps } from "../core/edit.js";
import { MAX_ATT_CHARS } from "../core/crdt.js";
import { dayKey } from "../core/time.js";
import { getSettings, setSetting } from "../identity.js";
import { InkLayer, inkColor } from "./ink.js";
import { INK_COLORS, strokeOps, eraseOps, invertInkOps } from "../core/ink.js";

const FIRST_SHEETS = 7;
const PRESENCE_EVERY_MS = 80;

export function mountTextRoom(body, app, session) {
  const zone = () => session.room.meta("tz") || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const undo = new UndoStack();
  const editors = new Map();
  let today = dayKey(Date.now(), zone());
  let older = 0;
  let settled = false;

  const list = h("div", { class: "sheets", id: "sheets" });
  const undoButton = iconButton("undo", "undo", "실행취소", () => step("undo"));
  const redoButton = iconButton("redo", "redo", "다시실행", () => step("redo"));
  const colorsButton = iconButton("toggle-colors", "palette", "사람마다 다른 색으로 보기", () => {
    setSetting(app.store, "colors", !getSettings(app.store).colors);
    app.events.emit("settings");
  });
  // Drawing: the pen button turns every sheet into a drawing surface, with its own small tool row.
  // The brush and the kind of eraser are remembered on this device.
  const pen = { tool: null, color: "black", width: 2, brush: getSettings(app.store).inkBrush || "pen" };
  const eraserKind = () => (getSettings(app.store).inkEraser === "stroke" ? "eraser-stroke" : "eraser");
  const penButton = iconButton("pen", "pen", "그리기", () => setTool(pen.tool ? null : "pen"));
  const inkTools = h("div", { class: "ink-tools", id: "ink-tools", hidden: true, role: "toolbar", "aria-label": "그리기 도구" });
  // 사진: choose words, then a photo; it hides in them and they sparkle (2 s hold brings it out).
  const photoInput = h("input", { type: "file", accept: "image/*", id: "photo-file", class: "vh", tabindex: "-1" });
  const photoButton = h("label", { class: "icon-btn", id: "photo", for: "photo-file", role: "button", "aria-label": "고른 글자에 사진 숨기기" }, icon("photo"));
  let chosen = null; // { editor, ch, to }: the words last chosen
  photoButton.addEventListener("click", (e) => {
    if (chosen && !readOnlyNow()) return;
    e.preventDefault();
    toast(app.root, readOnlyNow() ? "이 방은 읽기만 할 수 있어요" : "사진을 숨길 글자를 먼저 길게 눌러 고르세요", 3200);
  });
  photoInput.addEventListener("change", async () => {
    const file = photoInput.files?.[0];
    photoInput.value = "";
    if (!file || !chosen) return;
    const target = chosen;
    const photo = await shrinkPhoto(file).catch(() => null);
    if (!photo) return void toast(app.root, "이 사진은 읽을 수 없어요", 3200);
    const made = attachOps(target.editor.sheet, session.clock, { ch: target.ch, to: target.to, data: photo.data, w: photo.w, h: photo.h, by: session.memberId });
    session.commit(target.editor.doc, made.ops);
    toast(app.root, "사진을 숨겼어요. 반짝이는 글자를 2초 꾹 누르면 나와요", 3600);
  });
  const stopPhotoWatch = watchPickers([photoInput], () => toast(app.root, "사진 고르는 창이 열리지 않았어요. Claude 앱이라면 크롬에서 같은 방을 열어 주세요.", 4200));
  const readOnlyNow = () => !!session.transport.readOnly;
  const toolbar = h("div", { class: "toolbar" }, undoButton, redoButton, colorsButton, penButton, photoButton);
  body.append(photoInput);
  body.append(list);
  body.after(inkTools, toolbar);

  // Two fingers zoom the page, words and drawings together; Ctrl+wheel or a trackpad
  // pinch on a computer. The page keeps its width while zoomed, so nothing reflows and
  // drawings stay with their words; the spot between the fingers stays under them.
  const MIN_PAGE = 1; // never smaller than the screen: no blank space beside the page
  const MAX_PAGE = 3;
  let pageZoom = 1;
  body.classList.add("text-body");
  function setPageZoom(z, cx, cy) {
    let next = Math.min(MAX_PAGE, Math.max(MIN_PAGE, z));
    if (Math.abs(next - 1) < 0.03) next = 1;
    if (Math.abs(next - pageZoom) < 0.001) return;
    const r = body.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    const ax = (cx ?? r.left + r.width / 2) - r.left;
    const ay = (cy ?? r.top + r.height / 2) - r.top;
    // Where the column starts in the scrolled content (its own zoom does not move it),
    // and the page point under the fingers in the column's own units.
    const ox = l.left - r.left + body.scrollLeft;
    const oy = l.top - r.top + body.scrollTop;
    const px = (body.scrollLeft + ax - ox) / pageZoom;
    const py = (body.scrollTop + ay - oy) / pageZoom;
    if (pageZoom === 1) {
      // Zoomed, the page keeps its width (no reflow) and is at least a screen tall, so it
      // can grow around the fingers even when little is written.
      list.style.width = list.offsetWidth + "px";
      list.style.minHeight = body.clientHeight + "px";
    }
    pageZoom = next;
    list.style.zoom = pageZoom === 1 ? "" : String(pageZoom);
    if (pageZoom === 1) {
      list.style.width = "";
      list.style.minHeight = "";
    }
    body.scrollLeft = ox + px * pageZoom - ax;
    body.scrollTop = oy + py * pageZoom - ay;
    repaintSoon();
  }
  // While two fingers zoom, the drawings and carets are repainted once per frame, not per move.
  let repaintQueued = false;
  function repaintSoon() {
    if (repaintQueued) return;
    repaintQueued = true;
    requestAnimationFrame(() => {
      repaintQueued = false;
      for (const editor of editors.values()) {
        editor.ink?.render();
        editor.drawCarets?.();
      }
    });
  }
  // A second finger stops a line being drawn: two fingers mean zoom.
  const fingers = watchFingers(body, () => { for (const editor of editors.values()) editor.ink?.cancelTouch(); });
  let pinch = null;
  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const onTouchStart = (e) => { if (e.touches.length === 2) pinch = { d: spread(e.touches), z: pageZoom }; };
  const onTouchMove = (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    setPageZoom(pinch.z * (spread(e.touches) / pinch.d), (e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2);
  };
  const onTouchEnd = (e) => { if (e.touches.length < 2) pinch = null; };
  const onWheel = (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setPageZoom(pageZoom * Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
  };
  body.addEventListener("touchstart", onTouchStart, { passive: true });
  body.addEventListener("touchmove", onTouchMove, { passive: false });
  body.addEventListener("touchend", onTouchEnd);
  body.addEventListener("wheel", onWheel, { passive: false });

  function setTool(tool) {
    pen.tool = tool;
    for (const editor of editors.values()) {
      editor.ink?.setTool(tool);
      editor.ink?.setStyle(pen);
    }
    drawInkTools();
    buttons();
    for (const editor of editors.values()) editor.ink?.render();
  }

  function drawInkTools() {
    inkTools.hidden = !pen.tool;
    if (!pen.tool) return;
    const erasing = pen.tool !== "pen";
    const choose = (patch) => { Object.assign(pen, patch); setTool("pen"); };
    const brushes = [["pen", "펜"], ["pencil", "연필"], ["marker", "마커"], ["highlighter", "형광펜"]];
    inkTools.replaceChildren(
      h("div", { class: "ink-row" },
        ...brushes.map(([b, name]) => h("button", { class: "ink-brush", type: "button", data: { brush: b }, "aria-pressed": String(!erasing && pen.brush === b), text: name,
          onclick: () => { setSetting(app.store, "inkBrush", b); choose({ brush: b }); } })),
        iconButton("eraser", "eraser", "지우개", () => setTool(erasing ? "pen" : eraserKind())),
        erasing && h("div", { class: "seg ink-erase", role: "group", "aria-label": "지우개 방식" },
          ...[["eraser", "부분"], ["eraser-stroke", "획"]].map(([kind, name]) => h("button", { type: "button", data: { erase: kind }, "aria-pressed": String(pen.tool === kind), text: name,
            onclick: () => { setSetting(app.store, "inkEraser", kind === "eraser-stroke" ? "stroke" : "area"); setTool(kind); } })))),
      h("div", { class: "ink-row" },
        ...INK_COLORS.map((c) => h("button", { class: "ink-color", type: "button", data: { ink: c }, "aria-label": c, "aria-pressed": String(!erasing && pen.color === c),
          style: { background: inkColor(c) }, onclick: () => choose({ color: c }) })),
        ...[1, 2, 3].map((w) => h("button", { class: "ink-width", type: "button", data: { width: String(w) }, "aria-label": "굵기 " + w, "aria-pressed": String(pen.width === w),
          onclick: () => { pen.width = w; setTool(pen.tool); } }, h("span", { style: { width: 0.2 + w * 0.18 + "rem", height: 0.2 + w * 0.18 + "rem" } })))));
    inkTools.querySelector("#eraser").setAttribute("aria-pressed", String(erasing));
  }

  function buttons() {
    undoButton.disabled = !undo.canUndo;
    redoButton.disabled = !undo.canRedo;
    colorsButton.setAttribute("aria-pressed", String(getSettings(app.store).colors));
    penButton.setAttribute("aria-pressed", String(!!pen.tool));
  }

  const record = (atoms, typing) => {
    undo.record(atoms, { now: Date.now(), typing });
    buttons();
  };

  function step(dir) {
    const atoms = dir === "undo" ? undo.undo() : undo.redo();
    if (!atoms) return;
    const byDoc = new Map();
    for (const atom of atoms) {
      if (!byDoc.has(atom.doc)) byDoc.set(atom.doc, []);
      byDoc.get(atom.doc).push(atom);
    }
    for (const [doc, group] of byDoc) {
      if (doc.startsWith("k:")) session.commit(doc, invertInkOps(session.doc(doc), session.clock, group, dir));
      else session.commit(doc, invertOps(session.sheet(doc.slice(2)), session.clock, group, dir));
    }
    buttons();
  }

  // Where my caret is, told to the others at most every 80 ms.
  let caret = null;
  let presenceTimer = null;
  const onCaret = (editor, charId) => {
    if (charId === null) {
      if (caret && caret.d !== editor.day) return;
      caret = null;
    } else caret = { d: editor.day, i: charId };
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = null;
      session.setPresence({ m: session.memberId, d: caret ? caret.d : null, i: caret ? caret.i : null });
    }, PRESENCE_EVERY_MS);
  };

  // When this viewer may not write, the sheets become read-only and the tools go away.
  function applyAccess() {
    const readOnly = !!app.transport.readOnly;
    toolbar.hidden = readOnly;
    for (const editor of editors.values()) editor.setReadOnly(readOnly);
  }

  function editorFor(day) {
    let editor = editors.get(day);
    if (!editor) {
      editor = new SheetEditor({
        app, session, day, isToday: day === today, zone, record, onCaret, tell: (text) => toast(app.root, text),
        onReveal: (att, from) => revealPhoto(day, att, from),
        onSelect: (ed) => {
          const range = ed.selectionRange();
          if (range) chosen = { editor: ed, ...range };
        },
      });
      editor.setReadOnly(!!app.transport.readOnly);
      editors.set(day, editor);
      const inkDoc = "k:" + day;
      editor.ink = new InkLayer({
        host: editor.paper,
        blocked: () => fingers.pinching,
        // While the pen is on, today's paper leaves room to draw below the words.
        room: () => (day === today ? body.clientHeight * 0.6 : 0),
        ink: () => session.doc(inkDoc),
        onStroke: ({ pts, color, width, brush }) => {
          const made = strokeOps(session.clock, session.doc(inkDoc), { pts, color, width, brush, by: session.memberId });
          session.commit(inkDoc, made.ops);
          record(made.atoms.map((atom) => ({ ...atom, doc: inkDoc })), false);
        },
        onErase: (id) => {
          const made = eraseOps(session.clock, session.doc(inkDoc), id);
          session.commit(inkDoc, made.ops);
          record(made.atoms.map((atom) => ({ ...atom, doc: inkDoc })), false);
        },
      });
      editor.ink.setTool(pen.tool);
      editor.ink.setStyle(pen);
      session.load(inkDoc).then(() => editor.ink?.render());
      session.loadSheet(day).then(() => {
        if (!editors.has(day)) return;
        editor.render();
        editor.syncInput();
        if (!settled && day === today) {
          settled = true;
          body.scrollTop = body.scrollHeight;
        }
      });
    }
    return editor;
  }

  function drawList() {
    const now = dayKey(Date.now(), zone());
    if (now !== today) {
      today = now;
      for (const editor of editors.values()) {
        editor.ink?.destroy();
        editor.destroy();
      }
      editors.clear();
    }
    const past = session.days().filter((day) => day < today);
    const shown = past.slice(-(FIRST_SHEETS + older));
    const days = [...shown, today];
    for (const [day, editor] of editors) {
      if (days.includes(day)) continue;
      editor.ink?.destroy();
      editor.destroy();
      editors.delete(day);
    }
    const more = past.length > shown.length && h("button", { class: "pill", id: "older", type: "button", text: "이전 날짜 더 보기", onclick: () => {
      const before = body.scrollHeight;
      older += FIRST_SHEETS;
      drawList();
      body.scrollTop += body.scrollHeight - before;
    } });
    mount(list, more, days.map((day) => editorFor(day).el));
    for (const editor of editors.values()) editor.render();
  }

  const renderAll = () => {
    for (const editor of editors.values()) {
      editor.render();
      editor.ink?.render();
    }
    buttons();
  };

  const offs = [
    session.on("change", ({ doc }) => {
      if (doc === "room") return void renderAll();
      if (doc.startsWith("k:")) return void editors.get(doc.slice(2))?.ink?.render();
      const editor = editors.get(doc.slice(2));
      if (!editor) return void drawList();
      editor.render();
      editor.syncInput();
    }),
    session.on("peers", () => { for (const editor of editors.values()) editor.drawCarets(); }),
    session.on("status", applyAccess),
    session.on("sent", applyAccess),
    app.events.on("settings", renderAll),
    onThemeChange(renderAll),
  ];
  const midnight = setInterval(() => { if (dayKey(Date.now(), zone()) !== today) drawList(); }, 30000);
  const onResize = () => renderAll();
  window.addEventListener("resize", onResize);

  drawList();
  buttons();

  /** Puts text at the end of today's sheet, as its own line (레퍼런스 → 이 방에 붙이기). */
  function insertText(text) {
    const sheet = session.sheet(today);
    const ids = sheet.ids().slice();
    const before = sheet.text();
    const add = (before && !before.endsWith("\n") ? "\n" : "") + text;
    const made = spliceOps(sheet, session.clock, { by: session.memberId, now: Date.now() }, ids, ids.length, 0, add, false);
    session.commit("s:" + today, made.ops);
    record(made.atoms.map((atom) => ({ ...atom, doc: "s:" + today })), false);
  }

  /** The photo hidden in sparkling words comes out of them. */
  function revealPhoto(day, att, from) {
    document.getElementById("photo-reveal")?.remove();
    const who = session.room.member(att.by)?.name || "누군가";
    const editor = editors.get(day);
    const shut = () => {
      box.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => { if (e.key === "Escape") shut(); };
    // A tap on the dark around the photo closes it; the lift of the finger that held the word does not
    // (its press began before the photo was there).
    let pressedHere = false;
    const box = h("div", { class: "reveal", id: "photo-reveal", role: "dialog", "aria-label": "숨겨 둔 사진",
      onpointerdown: (e) => { pressedHere = e.target === box; },
      onclick: (e) => { if (e.target === box && pressedHere) shut(); } },
      h("span", { class: "reveal-burst", "aria-hidden": "true" }),
      h("img", { class: "reveal-img", src: att.data, alt: "숨겨 둔 사진", width: att.w, height: att.h }),
      h("p", { class: "reveal-who", text: `${who} 님이 숨겨 둔 사진` }),
      h("div", { class: "reveal-actions" },
        !readOnlyNow() && editor && h("button", { class: "btn quiet small", id: "photo-remove", type: "button", text: "사진 빼기", onclick: () => {
          session.commit(editor.doc, detachOps(editor.sheet, session.clock, att.id).ops);
          shut();
          toast(app.root, "사진을 뺐어요");
        } }),
        h("button", { class: "btn small", id: "photo-close", type: "button", text: "닫기", onclick: () => shut() })));
    // The photo flies out of the word towards the middle of the screen.
    box.style.setProperty("--dx", Math.round(from.left + from.width / 2 - innerWidth / 2) + "px");
    box.style.setProperty("--dy", Math.round(from.top + from.height / 2 - innerHeight / 2) + "px");
    app.root.append(box);
    document.addEventListener("keydown", onKey);
  }

  const close = () => {
    document.getElementById("photo-reveal")?.remove();
    stopPhotoWatch();
    photoInput.remove();
    body.removeEventListener("touchstart", onTouchStart);
    body.removeEventListener("touchmove", onTouchMove);
    body.removeEventListener("touchend", onTouchEnd);
    body.removeEventListener("wheel", onWheel);
    body.classList.remove("text-body");
    fingers.stop();
    for (const off of offs) off();
    clearInterval(midnight);
    clearTimeout(presenceTimer);
    window.removeEventListener("resize", onResize);
    for (const editor of editors.values()) {
      editor.ink?.destroy();
      editor.destroy();
    }
    toolbar.remove();
    inkTools.remove();
    list.remove();
  };
  return { close, insertText };
}

/** A photo made small enough to travel with the words (a JPEG data URL), or null. */
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    for (const side of [720, 560, 440, 340, 260]) {
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * k));
      const h = Math.max(1, Math.round(img.naturalHeight * k));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      for (const q of [0.72, 0.6, 0.48]) {
        const data = canvas.toDataURL("image/jpeg", q);
        if (data.length <= MAX_ATT_CHARS) return { data, w, h };
      }
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
