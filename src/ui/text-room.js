// The shared sheets of a daily text room: one sheet per day, newest at the bottom.

import { h, iconButton, mount, toast } from "./dom.js";
import { onThemeChange } from "./theme.js";
import { SheetEditor } from "./editor.js";
import { UndoStack } from "../core/undo.js";
import { invertOps } from "../core/edit.js";
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
  const pen = { tool: null, color: "black", width: 2 };
  const penButton = iconButton("pen", "pen", "그리기", () => setTool(pen.tool ? null : "pen"));
  const inkTools = h("div", { class: "ink-tools", id: "ink-tools", hidden: true, role: "toolbar", "aria-label": "그리기 도구" });
  const toolbar = h("div", { class: "toolbar" }, undoButton, redoButton, colorsButton, penButton);
  body.append(list);
  body.after(inkTools, toolbar);

  function setTool(tool) {
    pen.tool = tool;
    for (const editor of editors.values()) {
      editor.ink?.setTool(tool);
      editor.ink?.setStyle(pen);
    }
    drawInkTools();
    buttons();
  }

  function drawInkTools() {
    inkTools.hidden = !pen.tool;
    if (!pen.tool) return;
    const choose = (patch) => { Object.assign(pen, patch); setTool(pen.tool === "eraser" && patch.color ? "pen" : pen.tool); };
    inkTools.replaceChildren(
      ...INK_COLORS.map((c) => h("button", { class: "ink-color", type: "button", data: { ink: c }, "aria-label": c, "aria-pressed": String(pen.tool === "pen" && pen.color === c),
        style: { background: inkColor(c) }, onclick: () => choose({ color: c }) })),
      ...[1, 2, 3].map((w) => h("button", { class: "ink-width", type: "button", data: { width: String(w) }, "aria-label": "굵기 " + w, "aria-pressed": String(pen.width === w),
        onclick: () => choose({ width: w }) }, h("span", { style: { width: 0.2 + w * 0.18 + "rem", height: 0.2 + w * 0.18 + "rem" } }))),
      iconButton("eraser", "eraser", "지우개", () => setTool(pen.tool === "eraser" ? "pen" : "eraser")));
    inkTools.querySelector("#eraser").setAttribute("aria-pressed", String(pen.tool === "eraser"));
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
      editor = new SheetEditor({ app, session, day, isToday: day === today, zone, record, onCaret, tell: (text) => toast(app.root, text) });
      editor.setReadOnly(!!app.transport.readOnly);
      editors.set(day, editor);
      const inkDoc = "k:" + day;
      editor.ink = new InkLayer({
        host: editor.paper,
        ink: () => session.doc(inkDoc),
        onStroke: ({ pts, color, width }) => {
          const made = strokeOps(session.clock, session.doc(inkDoc), { pts, color, width, by: session.memberId });
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

  return () => {
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
}
