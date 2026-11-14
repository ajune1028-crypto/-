// The song room: sing or hum, and it becomes piano notes with the timing you
// sang. Takes become clips on rows; rows play together; clips can be copied,
// pasted, muted, split, moved and deleted, and every step can be undone.
//
// Top right: 원본 | 피아노 decides what you hear and see (the recording's
// waveform, or note bars by pitch). The tone button switches the piano
// between 밝게 and 어둡게. Both are this device's own choice.

import { h, icon, iconButton, segmented, toggle, openSheet, toast } from "./dom.js";
import { currentTheme, onThemeChange } from "./theme.js";
import { Timeline, timeText } from "./song-view.js";
import { UndoStack } from "../core/undo.js";
import { memberColor, INK } from "../core/paint.js";
import { MAX_ROWS, MAX_TAKE_MS, sourceOp, addClipOps, setClipOps, removeClipOps, splitClipOps, invertSongOps } from "../core/song.js";
import { getSettings, setSetting } from "../identity.js";
import { copyItem, clipboardItem } from "../clipboard.js";
import { audioContext, SongPlayer } from "../audio/engine.js";
import { Analyzer, analyzeSamples } from "../audio/analyze.js";
import { MicRecorder, micSupport, micProblem } from "../audio/recorder.js";
import { decodeAudioFile, bufferFromSamples } from "../audio/decode.js";
import { encodeWav, decodeWav } from "../audio/wav.js";
import { resample, toMono } from "../audio/dsp.js";
import { toBase64 } from "../audio/peaks.js";
import { noteLabel } from "../audio/notes.js";
import { newBlobId } from "../sync/blobs.js";

const KEEP_RATE = 24000; // recordings are kept at this rate: clear voice, a quarter of CD size
const MIN_TAKE_MS = 250;
const PRESENCE_EVERY_MS = 120;
const LIVE_EVERY_MS = 150;

export function mountSongRoom(body, app, session, frame) {
  const song = session.doc("song");
  const root = app.root;
  const undo = new UndoStack(100, 0);
  const audio = new Map(); // source id → AudioBuffer, or null when this device has no recording
  const settings = () => getSettings(app.store);
  let loaded = false;
  let selected = null;
  let selectedRow = 0;
  let playhead = 0;
  let player = null;
  let rec = null;
  let busy = null;
  let frameReq = 0;
  let alive = true;
  let menu = null;

  body.classList.add("song-body");
  const timeline = new Timeline({
    seek: (ms) => seek(ms),
    tapEmpty: (ms, row) => {
      selectedRow = Math.min(row, Math.max(0, song.rowCount() - 1));
      select(null);
      seek(ms);
    },
    select: (id) => select(selected === id ? null : id),
    move: (id, start, row) => moveClip(id, start, row),
    canMove: (id) => !readOnly() && !song.clip(id)?.locked,
    zoomed: () => placeMenu(),
  });
  body.append(timeline.el);
  timeline.el.addEventListener("scroll", () => placeMenu());

  // ---- controls ------------------------------------------------------------------

  const clock = h("span", { class: "song-clock", id: "song-clock", text: "0:00.0" });
  const zoomOut = iconButton("zoom-out", "zoomOut", "좁게 보기", () => timeline.setZoom(timeline.pps / 1.4, playhead));
  const zoomIn = iconButton("zoom-in", "zoomIn", "넓게 보기", () => timeline.setZoom(timeline.pps * 1.4, playhead));
  const modeSwitch = segmented([["original", "원본", "mode-original"], ["piano", "피아노", "mode-piano"]], settings().songMode, (mode) => setMode(mode), "mode");
  modeSwitch.classList.add("mode-switch");
  modeSwitch.setAttribute("aria-label", "듣는 방식");
  frame.top.append(h("div", { class: "song-top" }, h("div", { class: "song-top-left" }, clock, zoomOut, zoomIn), modeSwitch));

  const startButton = iconButton("to-start", "start", "처음으로", () => seek(0));
  const playButton = iconButton("play", "play", "재생", () => togglePlay());
  const recordButton = iconButton("record", "record", "녹음", () => toggleRecord());
  recordButton.classList.add("rec-btn");
  const importButton = iconButton("import", "upload", "소리 가져오기", () => pickFile());
  const undoButton = iconButton("undo", "undo", "실행취소", () => step("undo"));
  const redoButton = iconButton("redo", "redo", "다시실행", () => step("redo"));
  const toneButton = iconButton("tone", "sun", "피아노 음색", () => setTone(settings().pianoTone === "dark" ? "bright" : "dark"));
  const toolbar = h("div", { class: "toolbar song-tools", id: "song-tools" }, startButton, playButton, recordButton, importButton, undoButton, redoButton, toneButton);
  body.after(toolbar);
  const fileInput = h("input", { type: "file", accept: "audio/*,.wav,.mp3,.m4a,.aac,.ogg,.webm", id: "song-file", hidden: true, onchange: () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) importFile(file);
  } });
  body.append(fileInput);
  const status = h("div", { class: "song-status", id: "song-status", role: "status", hidden: true });
  body.append(status);

  const readOnly = () => !!app.transport?.readOnly || !!session.transport.readOnly;
  const mic = micSupport();

  // ---- drawing ------------------------------------------------------------------

  function colorOf(by) {
    const m = session.room.member(by);
    return m ? memberColor(m.color, currentTheme()) : INK[currentTheme()];
  }

  function peerSelections() {
    const map = new Map();
    for (const p of session.peers) {
      if (p.isMe || !p.state || typeof p.state.sel !== "string") continue;
      const m = session.room.member(p.state.m);
      if (m) map.set(p.state.sel, memberColor(m.color, currentTheme()));
    }
    return map;
  }

  function model() {
    const clips = song.layout();
    let empty = null;
    if (loaded && !clips.length && !rec) {
      empty = mic.ok
        ? "아래 빨간 녹음 버튼을 누르고 흥얼거려 보세요.\n부른 음과 길이 그대로 피아노 음이 돼요."
        : "아래 버튼으로 녹음 파일을 가져와 보세요.\n부른 음과 길이 그대로 피아노 음이 돼요.";
    }
    if (!loaded) empty = "노래를 불러오는 중…";
    return {
      clips, source: (id) => song.source(id), color: colorOf, mode: settings().songMode, showWave: settings().showWave,
      selected, selectedRow, peers: peerSelections(), rows: Math.max(song.rowCount(), rec ? rec.row + 1 : 1),
      end: Math.max(song.end(), rec ? rec.start + rec.ms : 0), hasAudio: (id) => !!audio.get(id) || hasLocalBlob(id),
      recording: rec && { row: rec.row, start: rec.start, ms: rec.ms, notes: rec.notes },
      playhead, empty,
    };
  }

  function draw() {
    if (!alive) return;
    timeline.render(model());
    drawButtons();
    placeMenu();
  }

  function drawButtons() {
    const playing = !!player?.playing && !rec;
    playButton.replaceChildren(icon(playing ? "pause" : "play"));
    playButton.setAttribute("aria-label", playing ? "멈춤" : "재생");
    playButton.setAttribute("aria-pressed", String(playing));
    recordButton.replaceChildren(icon(rec ? "stop" : "record"));
    recordButton.setAttribute("aria-label", rec ? "녹음 끝내기" : "녹음");
    recordButton.classList.toggle("on", !!rec);
    recordButton.hidden = !mic.ok;
    importButton.hidden = mic.ok;
    recordButton.disabled = importButton.disabled = readOnly() || !!busy;
    undoButton.disabled = !undo.canUndo || !!rec;
    redoButton.disabled = !undo.canRedo || !!rec;
    const dark = settings().pianoTone === "dark";
    toneButton.replaceChildren(icon(dark ? "moon" : "sun"));
    toneButton.setAttribute("aria-label", "피아노 음색: " + (dark ? "어둡게" : "밝게"));
    toneButton.dataset.tone = dark ? "dark" : "bright";
    for (const b of modeSwitch.children) b.setAttribute("aria-pressed", String(b.dataset.value === settings().songMode));
    clock.textContent = timeText(playhead);
  }

  function showStatus(text) {
    status.hidden = !text;
    status.textContent = text || "";
  }

  // ---- the recordings on this device --------------------------------------------------

  const localBlobs = new Map(); // blob id → true/false once looked up
  function hasLocalBlob(srcId) {
    const src = song.source(srcId);
    if (!src?.blob) return false;
    if (!localBlobs.has(src.blob)) {
      localBlobs.set(src.blob, false);
      app.blobs.get(src.blob).then((rec) => {
        localBlobs.set(src.blob, !!rec);
        if (rec) draw();
      });
    }
    return localBlobs.get(src.blob);
  }

  /** Decodes every recording this device holds, so 원본 can play them. */
  async function loadRecordings(ctx) {
    for (const src of song.sources.values()) {
      if (audio.has(src.id) || !src.blob) continue;
      const stored = await app.blobs.get(src.blob);
      const wav = stored && decodeWav(stored.data);
      audio.set(src.id, wav ? bufferFromSamples(ctx, toMono(wav.channels), wav.rate) : null);
    }
  }

  async function ready() {
    const ctx = await audioContext();
    if (!ctx) {
      toast(root, "이 브라우저는 소리를 낼 수 없어요");
      return null;
    }
    if (!player) {
      player = new SongPlayer(ctx, { song: () => song, audioFor: (id) => audio.get(id) || null, onEnd: () => { playhead = player.position; stopFrames(); draw(); } });
      player.setMode(settings().songMode);
      player.setTone(settings().pianoTone);
    }
    if (settings().songMode === "original") await loadRecordings(ctx);
    return ctx;
  }

  // ---- playing ------------------------------------------------------------------

  async function togglePlay() {
    if (rec) return;
    if (player?.playing) {
      player.stop();
      playhead = player.position;
      stopFrames();
      return void draw();
    }
    if (!(await ready())) return;
    if (playhead >= song.end() && song.end() > 0) playhead = 0;
    player.play(playhead);
    runFrames();
    draw();
  }

  function seek(ms) {
    playhead = Math.max(0, Math.round(ms));
    if (player?.playing && !rec) player.seek(playhead);
    timeline.setPlayhead(playhead);
    drawButtons();
    placeMenu();
  }

  function runFrames() {
    cancelAnimationFrame(frameReq);
    const tick = () => {
      if (!alive) return;
      if (rec) {
        rec.ms = Math.max(rec.ms, rec.recorder.seconds * 1000);
        playhead = rec.start + rec.ms;
        if (rec.ms >= MAX_TAKE_MS) {
          toast(root, "한 번에 3분까지 녹음해요");
          toggleRecord();
        }
        // Finding notes in the whole take so far is the costly part: a few times a second is enough.
        const now = performance.now();
        if (now - rec.lastLook > LIVE_EVERY_MS) {
          rec.lastLook = now;
          rec.notes = rec.analyzer.notes();
          timeline.render(model());
        } else timeline.drawRecording(model().recording);
      } else if (player?.playing) playhead = player.position;
      else return void draw();
      timeline.setPlayhead(playhead);
      timeline.follow(playhead);
      clock.textContent = timeText(playhead);
      frameReq = requestAnimationFrame(tick);
    };
    frameReq = requestAnimationFrame(tick);
  }

  function stopFrames() {
    cancelAnimationFrame(frameReq);
  }

  function setMode(mode) {
    setSetting(app.store, "songMode", mode);
    player?.setMode(mode);
    if (mode === "original" && player) ready().then(() => draw());
    app.events.emit("settings");
    draw();
  }

  function setTone(tone) {
    setSetting(app.store, "pianoTone", tone);
    player?.setTone(tone);
    toast(root, tone === "dark" ? "피아노: 어둡게" : "피아노: 밝게", 1400);
    app.events.emit("settings");
    drawButtons();
  }

  // ---- recording ----------------------------------------------------------------

  async function toggleRecord() {
    if (rec) return stopRecording();
    if (readOnly() || busy) return;
    if (!mic.ok) return pickFile();
    if (!song.canAddClip()) return void toast(root, "클립은 방 하나에 200개까지예요");
    const ctx = await ready();
    if (!ctx) return;
    const row = song.freeRow(playhead, 1, selectedRow);
    if (row === null) return void toast(root, "이 자리에는 줄이 더 없어요. 다른 시간에서 녹음해 주세요");
    const recorder = new MicRecorder(ctx);
    const analyzer = new Analyzer(ctx.sampleRate);
    busy = "mic";
    drawButtons();
    try {
      await recorder.start((chunk) => analyzer.push(chunk));
    } catch (err) {
      busy = null;
      console.warn(err);
      toast(root, micProblem(err), 4200);
      return void drawButtons();
    }
    busy = null;
    if (!alive) return void recorder.stop();
    const overdub = song.layout().some((c) => !c.muted && c.start + c.length > playhead);
    rec = { recorder, analyzer, row, start: playhead, ms: 0, overdub, notes: [], lastLook: 0 };
    select(null);
    if (!app.store.get("hint:earphones", false)) {
      app.store.set("hint:earphones", true);
      toast(root, "이어폰을 쓰면 다른 소리가 섞이지 않아요", 3600);
    }
    // The other clips play along while you sing.
    player.play(playhead, { keepGoing: true });
    session.setPresence(presence());
    runFrames();
    draw();
  }

  async function stopRecording() {
    const r = rec;
    if (!r) return;
    rec = null;
    player?.stop();
    stopFrames();
    const take = await r.recorder.stop();
    const result = r.analyzer.finish();
    session.setPresence(presence());
    if (take.samples.length < (take.rate * MIN_TAKE_MS) / 1000) {
      toast(root, "녹음이 너무 짧아요");
      return void draw();
    }
    // What you heard while singing reached you late, and your voice reached the
    // page late again: move the take back by that much.
    const shift = r.overdub ? r.recorder.latency() * 1000 + Number(settings().syncMs || 0) : 0;
    const start = Math.max(0, Math.round(r.start - shift));
    await addTake({ samples: take.samples, rate: take.rate, result, start, row: r.row, name: null });
    playhead = start + Math.round(result.duration * 1000);
    draw();
  }

  // ---- importing ----------------------------------------------------------------

  async function pickFile() {
    if (readOnly() || busy || rec) return;
    // Woken here, inside the tap: the file picker's answer comes too late for that.
    await audioContext();
    fileInput.click();
  }

  async function importFile(file) {
    if (busy) return;
    if (!song.canAddClip()) return void toast(root, "클립은 방 하나에 200개까지예요");
    const ctx = await ready();
    if (!ctx) return;
    busy = "import";
    drawButtons();
    showStatus("소리를 읽는 중…");
    try {
      let { samples, rate } = await decodeAudioFile(ctx, file);
      if (samples.length > (rate * MAX_TAKE_MS) / 1000) {
        samples = samples.subarray(0, Math.round((rate * MAX_TAKE_MS) / 1000));
        toast(root, "앞의 3분만 가져왔어요", 3200);
      }
      const result = await analyzeSamples(samples, rate, { onProgress: (p) => showStatus(`음을 찾는 중… ${Math.round(p * 100)}%`) });
      const row = song.freeRow(playhead, Math.max(1, Math.round(result.duration * 1000)), selectedRow);
      if (row === null) throw Object.assign(new Error("no room"), { reason: "rows" });
      await addTake({ samples, rate, result, start: playhead, row, name: file.name });
      if (!result.notes.length) toast(root, "음을 찾지 못했어요. 원본으로 들을 수 있어요", 3600);
    } catch (err) {
      console.warn(err);
      toast(root, err?.reason === "rows" ? "이 자리에는 줄이 더 없어요" : "이 파일은 읽을 수 없어요", 3600);
    } finally {
      busy = null;
      showStatus(null);
      draw();
    }
  }

  /** Keeps the recording on this device, then adds its sound and a clip to the song. */
  async function addTake({ samples, rate, result, start, row, name }) {
    const ctx = await audioContext();
    const kept = rate === KEEP_RATE ? samples : resample(samples, rate, KEEP_RATE);
    const blob = newBlobId();
    await app.blobs.put(blob, encodeWav(kept, KEEP_RATE), "audio/wav");
    localBlobs.set(blob, true);
    const by = session.memberId;
    const src = sourceOp(session.clock, song, { duration: result.duration, notes: result.notes, peaks: toBase64(result.peaks), by, at: Date.now(), blob, name });
    if (ctx) audio.set(src.id, bufferFromSamples(ctx, samples, rate));
    const length = Math.max(1, Math.round(result.duration * 1000));
    const place = song.freeRow(start, length, row) ?? row;
    const clip = addClipOps(session.clock, song, { src: src.id, row: place, start, length, by, at: Date.now() });
    session.commit("song", [src, ...clip.ops]);
    record(clip.atoms);
    selectedRow = place;
    select(clip.id);
  }

  // ---- clips ----------------------------------------------------------------------

  function select(id) {
    selected = id && song.clip(id) && !song.clip(id).removed ? id : null;
    if (selected) selectedRow = song.layout().find((c) => c.id === selected)?.lane ?? selectedRow;
    session.setPresence(presence());
    draw();
  }

  const presence = () => ({ m: session.memberId, sel: selected, rec: rec ? rec.row : null });

  function record(atoms) {
    if (!atoms.length) return;
    undo.record(atoms, { now: Date.now(), typing: false });
    drawButtons();
  }

  function apply(made) {
    if (!made || !made.ops.length) return false;
    session.commit("song", made.ops);
    record(made.atoms);
    return true;
  }

  function step(dir) {
    const atoms = dir === "undo" ? undo.undo() : undo.redo();
    if (!atoms) return;
    session.commit("song", invertSongOps(song, session.clock, atoms, dir));
    if (selected && song.clip(selected)?.removed) selected = null;
    draw();
  }

  function moveClip(id, start, row) {
    const clip = song.clip(id);
    if (!clip || clip.locked || readOnly()) return;
    const lane = Math.min(row, MAX_ROWS - 1);
    const place = song.freeRow(start, clip.length, lane, id);
    if (place === null) return void toast(root, "그 자리에는 놓을 수 없어요");
    if (place === clip.row && start === clip.start) return;
    apply(setClipOps(session.clock, song, id, { start, row: place }));
    selected = id;
    selectedRow = place;
    draw();
  }

  function copyClip(id) {
    const clip = song.clip(id);
    const src = clip && song.source(clip.src);
    if (!src) return;
    copyItem(app.store, {
      kind: "song-clip", room: session.roomId, src: src.id, offset: clip.offset, length: clip.length,
      source: { duration: src.dur / 1000, notes: src.notes.map((n) => ({ t: n.t / 1000, d: n.d / 1000, p: n.p, v: n.v })), peaks: src.peaks, blob: src.blob, name: src.name },
    });
    toast(root, "복사했어요. 다른 노래 방에도 붙여넣을 수 있어요", 2400);
    draw();
  }

  function pasteClip() {
    const item = clipboardItem(app.store, "song-clip");
    if (!item || readOnly()) return;
    if (!song.canAddClip()) return void toast(root, "클립은 방 하나에 200개까지예요");
    const row = song.freeRow(playhead, item.length, selectedRow);
    if (row === null) return void toast(root, "이 자리에는 줄이 더 없어요");
    const ops = [];
    let srcId = item.room === session.roomId && song.source(item.src) ? item.src : null;
    if (!srcId) {
      // From another room: the sound comes along (its notes and waveform; the recording stays on this device).
      const src = sourceOp(session.clock, song, { ...item.source, by: session.memberId, at: Date.now() });
      ops.push(src);
      srcId = src.id;
    }
    const clip = addClipOps(session.clock, song, { src: srcId, row, start: playhead, offset: item.offset, length: item.length, by: session.memberId, at: Date.now() });
    session.commit("song", [...ops, ...clip.ops]);
    record(clip.atoms);
    selectedRow = row;
    select(clip.id);
  }

  function toggleMute(id) {
    const clip = song.clip(id);
    if (clip) apply(setClipOps(session.clock, song, id, { muted: !clip.muted }));
    draw();
  }

  function splitClip(id) {
    const made = splitClipOps(session.clock, song, id, playhead, session.memberId);
    if (!made) return void toast(root, "재생 위치를 클립 안으로 옮긴 뒤에 나눠 주세요");
    apply(made);
    draw();
  }

  function deleteClip(id) {
    if (apply(removeClipOps(session.clock, song, id))) selected = null;
    draw();
  }

  function insideClip(id) {
    const c = song.layout().find((x) => x.id === id);
    return !!c && playhead > c.start + 50 && playhead < c.start + c.length - 50;
  }

  // The small menu above a chosen clip.
  function placeMenu() {
    if (!selected || rec) {
      menu?.remove();
      menu = null;
      return;
    }
    const clip = song.clip(selected);
    if (!clip || clip.removed) return;
    const box = timeline.clipBox(selected);
    const area = body.getBoundingClientRect();
    if (!box) return;
    const locked = clip.locked || readOnly();
    if (!menu) {
      menu = h("div", { class: "clip-menu", id: "clip-menu", role: "toolbar", "aria-label": "클립 메뉴" });
      body.append(menu);
    }
    const item = (id, text, onclick, disabled = false) => h("button", { type: "button", id, text, disabled, onclick: (e) => { e.stopPropagation(); onclick(); } });
    menu.replaceChildren(
      item("clip-copy", "복사", () => copyClip(clip.id)),
      item("clip-paste", "붙여넣기", () => pasteClip(), !clipboardItem(app.store, "song-clip") || readOnly()),
      item("clip-mute", clip.muted ? "소리 켜기" : "음소거", () => toggleMute(clip.id), readOnly()),
      item("clip-split", "분할", () => splitClip(clip.id), locked || !insideClip(clip.id)),
      item("clip-notes", "음 보기", () => showNotes(clip.id)),
      item("clip-delete", "삭제", () => deleteClip(clip.id), locked));
    const w = menu.offsetWidth;
    const hgt = menu.offsetHeight;
    let left = box.left - area.left + box.width / 2 - w / 2;
    left = Math.max(6, Math.min(area.width - w - 6, left));
    let top = box.top - area.top - hgt - 6;
    if (top < 4) top = box.bottom - area.top + 6;
    menu.style.left = left + "px";
    menu.style.top = Math.min(top, area.height - hgt - 4) + "px";
  }

  /** "음 보기": every note of a clip with its name, when it starts and how long it was sung. */
  function showNotes(id) {
    const clip = song.clip(id);
    const src = clip && song.source(clip.src);
    if (!src) return;
    const notes = src.notes
      .map((n) => ({ ...n, s: Math.max(n.t, clip.offset), e: Math.min(n.t + n.d, clip.offset + clip.length) }))
      .filter((n) => n.e - n.s >= 20);
    openSheet(root, "음 보기", (panel) => {
      if (!notes.length) return void panel.append(h("p", { class: "help", text: "이 클립에서는 음을 찾지 못했어요. 원본으로 들을 수 있어요." }));
      panel.append(
        h("p", { class: "help", text: `음 ${notes.length}개. 누르면 그 음이 피아노로 울려요.` }),
        h("ol", { class: "note-list", id: "note-list" }, notes.map((n) => h("li", {},
          h("button", { type: "button", class: "note-row", onclick: async () => { if (await ready()) player.preview(n.p, Math.min(1.2, (n.e - n.s) / 1000)); } },
            h("span", { class: "note-name", text: noteLabel(n.p) }),
            h("span", { class: "note-at", text: timeText(clip.start + n.s - clip.offset) }),
            h("span", { class: "note-len", text: ((n.e - n.s) / 1000).toFixed(2) + "초" }))))));
    });
  }

  // ---- settings sheet ----------------------------------------------------------------

  function settingsSection(close) {
    const s = settings();
    const sync = h("input", { type: "range", id: "set-sync", min: "-300", max: "300", step: "10", value: String(s.syncMs || 0), class: "range" });
    const syncText = h("span", { class: "help", id: "sync-text", text: syncLabel(s.syncMs || 0) });
    sync.addEventListener("input", () => {
      setSetting(app.store, "syncMs", Number(sync.value));
      syncText.textContent = syncLabel(Number(sync.value));
    });
    return h("div", { class: "section" }, h("p", { class: "section-title", text: "노래" }),
      h("div", { class: "form" },
        h("div", { class: "row" }, h("span", { class: "label", text: "피아노 음색" }),
          segmented([["bright", "밝게", "tone-bright"], ["dark", "어둡게", "tone-dark"]], s.pianoTone, (v) => setTone(v), "toneChoice")),
        toggle("set-wave", "피아노로 볼 때 원본 파형도 흐리게 보기", s.showWave, (on) => { setSetting(app.store, "showWave", on); app.events.emit("settings"); draw(); }),
        h("div", { class: "row" }, h("label", { for: "set-sync", text: "싱크 보정: 겹쳐 녹음한 소리가 늦거나 이르게 놓일 때" }), sync, syncText),
        h("button", { class: "btn quiet", id: "settings-import", type: "button", text: "소리 가져오기 (녹음 파일)", onclick: () => { close(); pickFile(); } })));
  }

  const syncLabel = (v) => (v === 0 ? "자동" : v > 0 ? `${v}ms 앞으로 당겨요` : `${-v}ms 뒤로 밀어요`);

  // ---- keys ---------------------------------------------------------------------------

  function onKey(e) {
    if (e.target.closest?.("input, textarea, [contenteditable]") || root.querySelector(".scrim")) return;
    const cmd = e.metaKey || e.ctrlKey;
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if ((e.key === "Backspace" || e.key === "Delete") && selected) { e.preventDefault(); deleteClip(selected); }
    else if (cmd && e.key.toLowerCase() === "z") { e.preventDefault(); step(e.shiftKey ? "redo" : "undo"); }
    else if (cmd && e.key.toLowerCase() === "c" && selected) copyClip(selected);
    else if (cmd && e.key.toLowerCase() === "v") pasteClip();
  }

  // ---- life ---------------------------------------------------------------------------

  let presenceTimer = null;
  const offs = [
    session.on("change", ({ doc }) => {
      if (doc !== "song" && doc !== "room") return;
      if (selected && (!song.clip(selected) || song.clip(selected).removed)) selected = null;
      draw();
    }),
    session.on("peers", () => {
      clearTimeout(presenceTimer);
      presenceTimer = setTimeout(draw, PRESENCE_EVERY_MS);
    }),
    session.on("status", drawButtons),
    session.on("sent", drawButtons),
    app.events.on("settings", draw),
    onThemeChange(draw),
  ];
  const onVisibility = () => {
    if (document.visibilityState !== "hidden") return;
    if (rec) stopRecording();
    else if (player?.playing) togglePlay();
  };
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("keydown", onKey);
  const onResize = () => draw();
  window.addEventListener("resize", onResize);

  session.load("song").then(() => {
    loaded = true;
    draw();
  });
  draw();

  return {
    close() {
      alive = false;
      stopFrames();
      clearTimeout(presenceTimer);
      if (rec) rec.recorder.stop();
      rec = null;
      player?.close();
      for (const off of offs) off();
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      toolbar.remove();
      frame.top.replaceChildren();
      body.classList.remove("song-body");
    },
    settings: settingsSection,
  };
}
