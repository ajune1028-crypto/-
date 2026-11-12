// The shared sheets of a daily text room: one sheet per day, newest at the bottom.

import { h, iconButton, mount, toast } from "./dom.js";
import { onThemeChange } from "./theme.js";
import { SheetEditor } from "./editor.js";
import { UndoStack } from "../core/undo.js";
import { invertOps } from "../core/edit.js";
import { dayKey } from "../core/time.js";
import { getSettings, setSetting } from "../identity.js";

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
  const toolbar = h("div", { class: "toolbar" }, undoButton, redoButton, colorsButton);
  body.append(list);
  body.after(toolbar);

  function buttons() {
    undoButton.disabled = !undo.canUndo;
    redoButton.disabled = !undo.canRedo;
    colorsButton.setAttribute("aria-pressed", String(getSettings(app.store).colors));
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
    for (const [doc, group] of byDoc) session.commit(doc, invertOps(session.sheet(doc.slice(2)), session.clock, group, dir));
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
      for (const editor of editors.values()) editor.destroy();
      editors.clear();
    }
    const past = session.days().filter((day) => day < today);
    const shown = past.slice(-(FIRST_SHEETS + older));
    const days = [...shown, today];
    for (const [day, editor] of editors) {
      if (days.includes(day)) continue;
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
    for (const editor of editors.values()) editor.render();
    buttons();
  };

  const offs = [
    session.on("change", ({ doc }) => {
      if (doc === "room") return void renderAll();
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
    for (const editor of editors.values()) editor.destroy();
    toolbar.remove();
    list.remove();
  };
}
