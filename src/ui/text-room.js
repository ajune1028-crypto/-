// The shared sheets of a daily text room: one sheet per day, newest at the bottom.

import { h, icon, iconButton, mount, toast, openSheet } from "./dom.js";
import { shrinkPhoto } from "./photo.js";
import { watchPickers } from "./picker-watch.js";
import { watchFingers } from "./fingers.js";
import { onThemeChange } from "./theme.js";
import { SheetEditor } from "./editor.js";
import { UndoStack } from "../core/undo.js";
import { invertOps, spliceOps, attachOps, rangeOps, unrangeOps, attachSoundOps } from "../core/edit.js";
import { MARK_COLORS, MAX_SOUND_MS } from "../core/crdt.js";
import { fileOps } from "../core/files.js";
import { toBase64, fromBase64 } from "../core/b64.js";
import { encodeAdpcm, decodeAdpcm } from "../audio/adpcm.js";
import { audioContext } from "../audio/engine.js";
import { decodeAudioFile } from "../audio/decode.js";
import { resample, louder } from "../audio/dsp.js";
import { keepRawTake, takeWhere } from "./keep-take.js";
import { MicRecorder, micSupport, micProblem } from "../audio/recorder.js";
import { soundPickers, waysIn, pickerHelp, micRefused } from "./sound-in.js";
import { dayKey } from "../core/time.js";
import { getSettings, setSetting } from "../identity.js";
import { buzz } from "./chime.js";
import { InkLayer, inkColor, drawInkTools as drawInkToolsInto } from "./ink.js";
import { LiveInk } from "./live-ink.js";
import { INK_COLORS, strokeOps, eraseOps, invertInkOps } from "../core/ink.js";

const FIRST_SHEETS = 7;
const PRESENCE_EVERY_MS = 80;
// A recording hidden in words is kept as ADPCM at this rate: a clear voice at 6 kB a second.
const SOUND_RATE = 12000;
const MARK_NAMES = { red: "빨강", orange: "주황", yellow: "노랑", green: "초록", blue: "파랑", navy: "남색", purple: "보라" };
const timeOf = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

export function mountTextRoom(body, app, session) {
  const zone = () => session.room.meta("tz") || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const undo = new UndoStack();
  const editors = new Map();
  let today = dayKey(Date.now(), zone());
  let older = 0;
  let settled = false;

  const list = h("div", { class: "sheets", id: "sheets" });
  const undoButton = iconButton("undo", "undo", "실행취소", () => step("undo"), "되돌리기");
  const redoButton = iconButton("redo", "redo", "다시실행", () => step("redo"), "다시하기");
  const colorsButton = iconButton("toggle-colors", "palette", "사람마다 다른 색으로 보기", () => {
    setSetting(app.store, "colors", !getSettings(app.store).colors);
    app.events.emit("settings");
  }, "사람 색");
  // Drawing: the pen button turns every sheet into a drawing surface, with its own small tool row.
  // The brush and the kind of eraser are remembered on this device.
  const pen = { tool: null, color: "black", width: 2, brush: getSettings(app.store).inkBrush || "pen" };
  // Friends' lines while they draw them, and their pointer's light (같이: as it happens).
  const liveInk = new LiveInk(session);
  const penButton = iconButton("pen", "pen", "그리기", () => setTool(pen.tool ? null : "pen"), "그리기");
  const inkTools = h("div", { class: "ink-tools", id: "ink-tools", hidden: true, role: "toolbar", "aria-label": "그리기 도구" });
  // 사진: choose words, then a photo; it hides in them and they sparkle (2 s hold brings it out).
  const photoInput = h("input", { type: "file", accept: "image/*", id: "photo-file", class: "vh", tabindex: "-1" });
  const photoButton = h("label", { class: "icon-btn", id: "photo", for: "photo-file", role: "button", "aria-label": "글자에 사진 숨기기", data: { cap: "사진" } }, icon("photo"));
  // The words a photo goes into: the ones chosen, else the word at the caret, else today's last word.
  let chosen = null; // { editor, ch, to }
  photoButton.addEventListener("click", (e) => {
    if (!readOnlyNow()) {
      if (!chosen) {
        const ed = editors.get(today);
        const word = ed?.wordAround(Infinity);
        if (word) chosen = { editor: ed, ...word };
      }
      if (chosen) return;
    }
    e.preventDefault();
    toast(app.root, readOnlyNow() ? "이 방은 읽기만 할 수 있어요" : "먼저 글을 써 주세요. 사진은 글자 속에 숨어요", 3200);
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
    record(made.atoms.map((atom) => ({ ...atom, doc: target.editor.doc })), false);
    toast(app.root, "사진을 숨겼어요. 반짝이는 글자를 2초 꾹 누르면 나와요", 3600);
  });
  const stopPhotoWatch = watchPickers([photoInput], () => toast(app.root, "사진 고르는 창이 열리지 않았어요. Claude 앱이라면 크롬에서 같은 방을 열어 주세요.", 4200));
  const readOnlyNow = () => !!session.transport.readOnly;
  const toolbar = h("div", { class: "toolbar" }, undoButton, redoButton, colorsButton, penButton, photoButton);
  // Chosen words get their own row (the first description's 선택 도구): 표시 in 빨주노초파남보,
  // a photo or a recording hidden in them, 잠금.
  const selTools = h("div", { class: "sel-tools", id: "sel-tools", hidden: true, role: "toolbar", "aria-label": "고른 글자" });
  let sel = null; // { editor, ch, to } while words are chosen
  const mic = micSupport();
  let closeSound = null;
  let soundTarget = null;
  const { inputs: soundInputs, stop: stopSoundPickers } = soundPickers("text", {
    onFile: (file) => { closeSound?.(); importSound(soundTarget, file); },
    onSilent: () => { closeSound?.(); pickerHelp({ app, roomId: session.roomId, root: app.root, mic }); },
  });
  body.append(photoInput, ...soundInputs);
  body.append(list);
  body.after(selTools, inkTools, toolbar);

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
    drawSel();
    buttons();
    for (const editor of editors.values()) editor.ink?.render();
  }

  function drawInkTools() {
    drawInkToolsInto(inkTools, { pen, setTool, store: app.store });
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
        onReveal: (att, from) => (att.kind === "sound" ? revealSound(day, att, from) : revealPhoto(day, att, from)),
        onSelect: (ed) => {
          const range = ed.selectionRange();
          const word = range || ed.wordAround();
          if (word) chosen = { editor: ed, ...word };
          const before = sel;
          sel = range ? { editor: ed, ...range } : null;
          if (before?.ch !== sel?.ch || before?.to !== sel?.to || before?.editor !== sel?.editor) drawSel();
        },
      });
      editor.setReadOnly(!!app.transport.readOnly);
      editors.set(day, editor);
      const inkDoc = "k:" + day;
      editor.ink = new InkLayer({
        host: editor.paper,
        share: liveInk.on(inkDoc),
        steady: () => getSettings(app.store).inkSteady ?? 1,
        blocked: () => fingers.pinching,
        shapes: () => getSettings(app.store).inkShapes !== false,
        onShape: () => buzz(app),
        // While the pen is on, today's paper leaves room to draw below the words (a short page
        // already reaches the bottom of the screen; a long one grows past its last line).
        room: () => (day === today ? editor.draw.offsetHeight + body.clientHeight * 0.6 : 0),
        ink: () => session.doc(inkDoc),
        onStroke: ({ pts, color, width, brush, shape }) => {
          const made = strokeOps(session.clock, session.doc(inkDoc), { pts, color, width, brush, shape, by: session.memberId });
          session.commit(inkDoc, made.ops);
          record(made.atoms.map((atom) => ({ ...atom, doc: inkDoc })), false);
          return made.ops[0]?.id;
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
      if (doc === "files") return;
      const editor = editors.get(doc.slice(2));
      if (!editor) return void drawList();
      editor.render();
      editor.syncInput();
      if (sel?.editor === editor) drawSel();
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

  // Words stay chosen while the row is used; leaving the sheets for anything else puts it away.
  const onFocusOut = () => setTimeout(() => {
    const active = document.activeElement;
    if (sel && !list.contains(active) && !selTools.contains(active) && !document.querySelector(".scrim:not(.closing)")) {
      sel = null;
      drawSel();
    }
  }, 250);
  list.addEventListener("focusout", onFocusOut);

  drawList();
  buttons();

  // ---- chosen words: 표시, 사진, 녹음, 잠금 ------------------------------------------------

  const isOwner = () => session.room.meta("createdBy") === session.memberId;
  /** The ranges (marks, locks) that share letters with the chosen words. */
  function touching(list, target) {
    const pos = new Map(target.editor.sheet.ids().map((id, i) => [id, i]));
    const span = (r) => {
      const a = pos.get(r.ch);
      const b = pos.get(r.to);
      return a === undefined || b === undefined ? null : [Math.min(a, b), Math.max(a, b)];
    };
    const mine = span(target);
    if (!mine) return [];
    return list.filter((r) => {
      const s = span(r);
      return s && s[0] <= mine[1] && s[1] >= mine[0];
    });
  }

  function drawSel() {
    selTools.hidden = !sel || readOnlyNow() || !!pen.tool;
    if (selTools.hidden) return void selTools.replaceChildren();
    const sheet = sel.editor.sheet;
    const marks = touching(sheet.marks(), sel);
    const locks = touching(sheet.locks(), sel);
    const freeable = locks.filter((l) => l.by === session.memberId || isOwner());
    selTools.replaceChildren(
      h("div", { class: "sel-row" },
        h("span", { class: "sel-label", text: "표시" }),
        ...MARK_COLORS.map((c) => h("button", { class: "sel-color", type: "button", data: { hl: c }, "aria-label": "표시 " + MARK_NAMES[c], onclick: () => markSel(c) })),
        marks.length > 0 && h("button", { class: "chip", id: "sel-unmark", type: "button", text: "지우기", onclick: () => undoRanges("mark", marks) })),
      h("div", { class: "sel-row" },
        h("label", { class: "chip", id: "sel-photo", for: "photo-file", role: "button" }, icon("photo"), "사진"),
        h("button", { class: "chip", id: "sel-sound", type: "button", onclick: () => openSoundSheet(sel) }, icon("record"), "녹음"),
        locks.length
          ? freeable.length > 0 && h("button", { class: "chip", id: "sel-unlock", type: "button", onclick: () => undoRanges("lock", freeable) }, icon("lock"), "잠금 풀기")
          : h("button", { class: "chip", id: "sel-lock", type: "button", onclick: () => lockSel() }, icon("lock"), "잠금")));
    // The words stay chosen while a button here is pressed.
    for (const b of selTools.querySelectorAll("button, label")) b.addEventListener("pointerdown", (e) => e.preventDefault());
  }

  function commitRange(target, made, done) {
    if (!made.ops.length) return;
    session.commit(target.editor.doc, made.ops);
    record(made.atoms.map((atom) => ({ ...atom, doc: target.editor.doc })), false);
    if (done) toast(app.root, done, 2600);
    drawSel();
  }

  function markSel(c) {
    if (!sel || readOnlyNow()) return;
    commitRange(sel, rangeOps(sel.editor.sheet, session.clock, "mark", { ch: sel.ch, to: sel.to, c, by: session.memberId }));
  }

  function lockSel() {
    if (!sel || readOnlyNow()) return;
    commitRange(sel, rangeOps(sel.editor.sheet, session.clock, "lock", { ch: sel.ch, to: sel.to, by: session.memberId }), "잠갔어요. 잠근 사람과 방장만 풀 수 있어요");
  }

  function undoRanges(t, list) {
    if (!sel || readOnlyNow()) return;
    const target = sel;
    const ops = [];
    const atoms = [];
    for (const r of list) {
      const made = unrangeOps(target.editor.sheet, session.clock, t, r.id);
      ops.push(...made.ops);
      atoms.push(...made.atoms);
    }
    commitRange(target, { ops, atoms }, t === "lock" ? "잠금을 풀었어요" : null);
  }

  // A recording hidden in words: in the app, from the phone's recorder app, or from a file.
  function openSoundSheet(target) {
    target = target || chosen;
    if (!target || readOnlyNow()) return void toast(app.root, "먼저 녹음을 숨길 글자를 고르세요", 2600);
    soundTarget = target;
    closeSound?.();
    closeSound = openSheet(app.root, "글자에 녹음 숨기기", (panel, close, onClose) => {
      const ways = h("div", { class: "form", id: "text-sound" },
        h("p", { class: "help", text: "녹음이 고른 글자 속에 숨어요. 반짝이는 글자를 2초 꾹 누르면 들려요. 1분까지 돼요." }),
        ...waysIn({ app, roomId: session.roomId, root: app.root, name: "text", prefix: "text-", mic, canRecord: !readOnlyNow(), onRecord: () => recordInto(target, ways, close) }));
      panel.append(ways);
      onClose(() => {
        closeSound = null;
        stopRecording?.();
      });
    });
  }

  let stopRecording = null;
  async function recordInto(target, ways, close) {
    if (stopRecording) return;
    const ctx = await audioContext();
    if (!ctx) return;
    const recorder = new MicRecorder(ctx);
    try {
      await recorder.start();
    } catch (err) {
      return void micRefused({ app, root: app.root, err, retry: () => recordInto(target, ways, close) });
    }
    const time = h("span", { class: "ref-rec-time", id: "text-rec-time", text: "0:00" });
    const row = h("div", { class: "ref-recording" }, h("span", { class: "dot-rec" }), time,
      h("button", { class: "btn", id: "text-rec-stop", type: "button", text: "멈추고 숨기기", onclick: () => finish(true) }));
    ways.prepend(row);
    const timer = setInterval(() => {
      time.textContent = timeOf(recorder.seconds * 1000);
      if (recorder.seconds * 1000 >= MAX_SOUND_MS) finish(true);
    }, 200);
    let over = false;
    async function finish(keep) {
      if (over) return;
      over = true;
      stopRecording = null;
      clearInterval(timer);
      row.remove();
      const take = await recorder.stop();
      if (!keep) return;
      close();
      hideSound(target, take.samples, take.rate);
    }
    stopRecording = () => finish(false);
  }

  async function importSound(target, file) {
    if (!target || readOnlyNow()) return;
    try {
      const ctx = await audioContext({ wake: false });
      if (!ctx) throw new Error("no audio");
      const { samples, rate } = await decodeAudioFile(ctx, file);
      hideSound(target, samples, rate);
    } catch (err) {
      console.warn(err);
      toast(app.root, "이 파일은 읽을 수 없어요", 3600);
    }
  }

  /** The sound goes into the room as a file in parts; the words point at it and sparkle. */
  function hideSound(target, samples, rate) {
    const max = Math.round((rate * MAX_SOUND_MS) / 1000);
    if (samples.length > max) samples = samples.subarray(0, max);
    if (samples.length < rate * 0.3) return void toast(app.root, "녹음이 너무 짧아요");
    samples = louder(samples).samples;
    // Kept in 레퍼런스 녹음 too (in the background), like every take.
    keepRawTake(app, samples, rate, { name: "숨긴 녹음", where: takeWhere(app, session.roomId) });
    const kept = rate === SOUND_RATE ? samples : resample(samples, rate, SOUND_RATE);
    const file = fileOps(session.clock, { type: "audio/adpcm", data: toBase64(encodeAdpcm(kept, SOUND_RATE)), by: session.memberId });
    session.commit("files", file.ops);
    const made = attachSoundOps(target.editor.sheet, session.clock, { ch: target.ch, to: target.to, file: file.id, dur: (kept.length / SOUND_RATE) * 1000, by: session.memberId });
    session.commit(target.editor.doc, made.ops);
    record(made.atoms.map((atom) => ({ ...atom, doc: target.editor.doc })), false);
    toast(app.root, "녹음을 숨겼어요. 반짝이는 글자를 2초 꾹 누르면 들려요", 3600);
  }

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

  /**
   * A reveal closes on a tap around it (not the lift of the finger that held the word,
   * whose press began before it was there), on a swipe down, and on Escape.
   */
  function revealBox(id, label, from, children, onShut = () => {}) {
    for (const old of document.querySelectorAll(".reveal")) old.remove();
    let pressedHere = null;
    const shut = () => {
      box.remove();
      document.removeEventListener("keydown", onKey);
      onShut();
    };
    const onKey = (e) => { if (e.key === "Escape") shut(); };
    const box = h("div", { class: "reveal", id, role: "dialog", "aria-label": label,
      onpointerdown: (e) => { pressedHere = { around: e.target === box, y: e.clientY }; },
      onpointerup: (e) => { if (pressedHere && e.clientY - pressedHere.y > 80) shut(); },
      onclick: (e) => { if (e.target === box && pressedHere?.around) shut(); } }, ...children);
    box.style.setProperty("--dx", Math.round(from.left + from.width / 2 - innerWidth / 2) + "px");
    box.style.setProperty("--dy", Math.round(from.top + from.height / 2 - innerHeight / 2) + "px");
    app.root.append(box);
    document.addEventListener("keydown", onKey);
    return shut;
  }

  /** The recording hidden in sparkling words: a round player that plays at once; a tap pauses. */
  function revealSound(day, att, from) {
    const who = session.room.member(att.by)?.name || "누군가";
    const editor = editors.get(day);
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    ring.setAttribute("viewBox", "0 0 100 100");
    ring.setAttribute("class", "orb-ring");
    ring.innerHTML = '<circle class="orb-track" cx="50" cy="50" r="46" /><circle class="orb-done" cx="50" cy="50" r="46" pathLength="100" stroke-dasharray="0 100" />';
    const face = h("span", { class: "orb-face" }, icon("pause"));
    const orb = h("button", { class: "sound-orb", id: "sound-orb", type: "button", "aria-label": "멈춤", onclick: () => toggle() }, ring, face);
    const line = h("p", { class: "reveal-who", id: "sound-who", text: `${who} 님이 숨겨 둔 녹음 · ${timeOf(att.dur)}` });
    let play = null; // { ctx, src, startedAt, offset }
    let buffer = null;
    let paused = false;
    let frame = 0;
    const shut = revealBox("sound-reveal", "숨겨 둔 녹음", from, [
      h("span", { class: "reveal-burst", "aria-hidden": "true" }), orb, line,
      h("div", { class: "reveal-actions" },
        !readOnlyNow() && editor && h("button", { class: "btn quiet small", id: "sound-remove", type: "button", text: "녹음 빼기", onclick: () => {
          const made = unrangeOps(editor.sheet, session.clock, "att", att.id);
          session.commit(editor.doc, made.ops);
          record(made.atoms.map((atom) => ({ ...atom, doc: editor.doc })), false);
          shut();
          toast(app.root, "녹음을 뺐어요");
        } }),
        h("button", { class: "btn small", id: "sound-close", type: "button", text: "닫기", onclick: () => shut() })),
    ], () => stop());
    const done = ring.querySelector(".orb-done");
    const show = (f) => done.setAttribute("stroke-dasharray", `${Math.round(Math.min(1, f) * 1000) / 10} 100`);
    function stop() {
      cancelAnimationFrame(frame);
      try { play?.src.stop(); } catch { /* already over */ }
      play = null;
    }
    async function start(offset = 0) {
      const ctx = await audioContext();
      if (!ctx || !buffer) return;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0, offset);
      play = { ctx, src, startedAt: ctx.currentTime - offset, offset };
      src.onended = () => {
        if (play?.src !== src) return;
        play = null;
        paused = false;
        orb.classList.remove("on");
        face.replaceChildren(icon("play"));
        orb.setAttribute("aria-label", "다시 듣기");
        show(1);
      };
      orb.classList.add("on");
      face.replaceChildren(icon("pause"));
      orb.setAttribute("aria-label", "멈춤");
      const tick = () => {
        if (!play) return;
        show((play.ctx.currentTime - play.startedAt) / buffer.duration);
        frame = requestAnimationFrame(tick);
      };
      tick();
    }
    function toggle() {
      if (!buffer) return;
      if (play) {
        const at = play.ctx.currentTime - play.startedAt;
        stop();
        paused = at;
        orb.classList.remove("on");
        face.replaceChildren(icon("play"));
        orb.setAttribute("aria-label", "이어 듣기");
        return;
      }
      start(typeof paused === "number" && paused < buffer.duration ? paused : 0);
      paused = false;
    }
    // The sound may still be arriving in parts; it plays as soon as it is whole.
    const tryLoad = async () => {
      const files = await session.load("files");
      const file = files.file(att.file);
      if (!file) {
        line.textContent = `녹음을 받는 중이에요 ${Math.round(files.progress(att.file) * 100)}%`;
        return false;
      }
      const pcm = decodeAdpcm(fromBase64(file.data));
      const ctx = await audioContext();
      if (!pcm || !ctx) {
        line.textContent = "이 녹음은 열 수 없어요";
        return true;
      }
      buffer = ctx.createBuffer(1, pcm.samples.length, pcm.rate);
      buffer.copyToChannel(pcm.samples, 0);
      line.textContent = `${who} 님이 숨겨 둔 녹음 · ${timeOf(att.dur)}`;
      start(0);
      return true;
    };
    tryLoad().then((ok) => {
      if (ok) return;
      const off = session.on("change", ({ doc }) => {
        if (doc !== "files" || !document.getElementById("sound-reveal")) return void (document.getElementById("sound-reveal") || off());
        tryLoad().then((now) => { if (now) off(); });
      });
    });
  }

  /** The photo hidden in sparkling words comes out of them, over a soft glow of itself. */
  function revealPhoto(day, att, from) {
    const who = session.room.member(att.by)?.name || "누군가";
    const editor = editors.get(day);
    const shut = revealBox("photo-reveal", "숨겨 둔 사진", from, [
      h("img", { class: "reveal-glow", src: att.data, alt: "", "aria-hidden": "true" }),
      h("span", { class: "reveal-burst", "aria-hidden": "true" }),
      h("img", { class: "reveal-img", src: att.data, alt: "숨겨 둔 사진", width: att.w, height: att.h }),
      h("p", { class: "reveal-who", text: `${who} 님이 숨겨 둔 사진` }),
      h("div", { class: "reveal-actions" },
        !readOnlyNow() && editor && h("button", { class: "btn quiet small", id: "photo-remove", type: "button", text: "사진 빼기", onclick: () => {
          const made = unrangeOps(editor.sheet, session.clock, "att", att.id);
          session.commit(editor.doc, made.ops);
          record(made.atoms.map((atom) => ({ ...atom, doc: editor.doc })), false);
          shut();
          toast(app.root, "사진을 뺐어요");
        } }),
        h("button", { class: "btn small", id: "photo-close", type: "button", text: "닫기", onclick: () => shut() })),
    ]);
  }

  const close = () => {
    liveInk.close();
    for (const el of document.querySelectorAll(".reveal")) el.remove();
    closeSound?.();
    stopSoundPickers();
    for (const input of soundInputs) input.remove();
    selTools.remove();
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

