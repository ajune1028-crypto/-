// The song room: sing or hum, and it becomes piano notes with the timing you
// sang. Takes become clips on rows; rows play together; clips can be copied,
// pasted, muted, split, joined, locked, moved and deleted, their notes edited,
// and every step undone.
//
// Sound comes in three ways, all on screen from the start: recording in the
// app (where the page may use the microphone), recording with the phone's
// own recorder app (Samsung 녹음 and the like, through the file picker's
// capture), and picking a file. Top right, 원본 | 피아노 decides what is heard
// and seen; the speed button plays 0.5x to 3x; the tone button switches the
// piano between 밝게 and 어둡게. Those three are this device's own choice.

import { h, icon, iconButton, segmented, toggle, openSheet, toast } from "./dom.js";
import { currentTheme, onThemeChange } from "./theme.js";
import { Timeline, timeText } from "./song-view.js";
import { openNoteEditor } from "./note-editor.js";
import { UndoStack } from "../core/undo.js";
import { memberColor, INK } from "../core/paint.js";
import {
  MAX_ROWS, MAX_TAKE_MS, sourceOp, addClipOps, setClipOps, removeClipOps, splitClipOps, invertSongOps, tempoOps,
  joinClipOps, joinWithSourceOps, combinedSource,
} from "../core/song.js";
import { getSettings, setSetting, roomEntry } from "../identity.js";
import { stepMs, beatMs, barMs, barBeat, snapMs, estimateTempo, tapTempo, METERS, GRIDS, MIN_BPM, MAX_BPM } from "../core/beat.js";
import { copyItem, clipboardItem } from "../clipboard.js";
import { audioContext, SongPlayer } from "../audio/engine.js";
import { Analyzer, analyzeSamples } from "../audio/analyze.js";
import { MicRecorder, micSupport, micProblem } from "../audio/recorder.js";
import { decodeAudioFile, bufferFromSamples } from "../audio/decode.js";
import { encodeWav, decodeWav } from "../audio/wav.js";
import { resample, toMono } from "../audio/dsp.js";
import { toBase64 } from "../audio/peaks.js";
import { newBlobId } from "../sync/blobs.js";
import { KEEP_RATE, soundPickers, waysIn as soundWays, pickerHelp as noChooserHelp } from "./sound-in.js";
import { RoomSession } from "../sync/session.js";
import { addItemOps, cardFromClip } from "../core/board.js";

const MIN_TAKE_MS = 250;
const PRESENCE_EVERY_MS = 120;
const LIVE_EVERY_MS = 150;
export const SPEEDS = [1, 1.5, 2, 3, 0.5];

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
  let editor = null;
  let closeAdd = null;
  const peerRecs = new Map(); // peer key → { row, at, since, name, color }

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

  // The time, and under it the song's 박자; a tap opens the 박자 sheet.
  const clockTime = h("span", { class: "clock-time", id: "song-clock", text: "0:00.0" });
  const beatLabel = h("span", { class: "clock-beat", id: "beat-label", text: "♩ 박자" });
  const clock = h("button", { class: "song-clock", id: "beat", type: "button", "aria-label": "박자 (빠르기, 박자표, 메트로놈)", onclick: () => openBeatSheet() }, clockTime, beatLabel);
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
  const addButton = iconButton("import", "upload", "소리 넣기", () => openAddSheet());
  const undoButton = iconButton("undo", "undo", "실행취소", () => step("undo"));
  const redoButton = iconButton("redo", "redo", "다시실행", () => step("redo"));
  const speedButton = h("button", { class: "icon-btn speed-btn", id: "speed", type: "button", "aria-label": "재생 빠르기", onclick: () => nextSpeed() });
  const toneButton = iconButton("tone", "sun", "피아노 음색", () => setTone(settings().pianoTone === "dark" ? "bright" : "dark"));
  const toolbar = h("div", { class: "toolbar song-tools", id: "song-tools" }, startButton, playButton, recordButton, addButton, undoButton, redoButton, speedButton, toneButton);
  body.after(toolbar);

  // The pickers (opened by <label>s; a tap that opens nothing gets a way out, see sound-in.js).
  const { inputs: pickers, stop: stopPickerWatch } = soundPickers("song", {
    onFile: (file) => { closeAdd?.(); importFile(file); },
    onSilent: () => { if (alive) { closeAdd?.(); noChooserHelp({ app, roomId: session.roomId, root, mic }); } },
  });
  body.append(...pickers);
  const status = h("div", { class: "song-status", id: "song-status", role: "status", hidden: true });
  const start = h("div", { class: "song-start", id: "song-start", hidden: true });
  body.append(status, start);

  const readOnly = () => !!app.transport?.readOnly || !!session.transport.readOnly;
  const mic = micSupport();

  /** The three ways in, as buttons. Used by the start card and the 소리 넣기 sheet. */
  function waysIn(prefix, after = () => {}) {
    return soundWays({ app, roomId: session.roomId, root, name: "song", prefix, mic, canRecord: !readOnly(), onRecord: () => { after(); toggleRecord(); } });
  }

  function openAddSheet() {
    if (readOnly() || rec) return;
    closeAdd?.();
    closeAdd = openSheet(root, "소리 넣기", (panel, close, onClose) => {
      panel.append(h("div", { class: "form", id: "add-sound" }, ...waysIn("add-", close)));
      onClose(() => { closeAdd = null; });
    });
  }

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

  /** Friends recording right now: where they started, growing from when this screen heard of it. */
  function trackPeerRecordings() {
    const live = new Set();
    for (const p of session.peers) {
      const r = p.state?.rec;
      if (p.isMe || !r || typeof r !== "object" || !Number.isFinite(r.row) || !Number.isFinite(r.at)) continue;
      live.add(p.key);
      const m = session.room.member(p.state.m);
      if (!peerRecs.has(p.key)) peerRecs.set(p.key, { row: r.row, at: r.at, since: performance.now() });
      Object.assign(peerRecs.get(p.key), { name: m?.name || "친구", color: m ? memberColor(m.color, currentTheme()) : "#e5484d" });
    }
    for (const key of [...peerRecs.keys()]) if (!live.has(key)) peerRecs.delete(key);
  }

  function model() {
    const clips = song.layout();
    let empty = null;
    if (!loaded) empty = "노래를 불러오는 중…";
    return {
      clips, source: (id) => song.source(id), notesOf: (id) => song.notesOf(id), color: colorOf, mode: settings().songMode, showWave: settings().showWave,
      selected, selectedRow, peers: peerSelections(), rows: Math.max(song.rowCount(), rec ? rec.row + 1 : 1, ...[...peerRecs.values()].map((r) => r.row + 1)),
      end: Math.max(song.end(), rec ? rec.start + rec.ms : 0), hasAudio: (id) => !!audio.get(id) || hasLocalBlob(id),
      recording: rec && { row: rec.row, start: rec.start, ms: rec.ms, notes: rec.notes },
      others: [...peerRecs.values()].map((r) => ({ row: r.row, start: r.at, ms: performance.now() - r.since, name: r.name, color: r.color })),
      playhead, empty, tempo: song.tempo(),
    };
  }

  function draw() {
    if (!alive) return;
    trackPeerRecordings();
    timeline.render(model());
    const showStart = loaded && !song.layout().length && !rec && !readOnly();
    if (showStart && !start.childNodes.length) start.append(h("p", { class: "start-title", text: "소리를 넣어 보세요" }), h("p", { class: "help", text: "흥얼거린 음과 길이 그대로 피아노 음이 돼요." }), ...waysIn("start-"));
    start.hidden = !showStart;
    drawButtons();
    placeMenu();
    editor?.refresh();
  }

  function drawButtons() {
    const playing = !!player?.playing && !rec;
    playButton.replaceChildren(icon(playing ? "pause" : "play"));
    playButton.setAttribute("aria-label", playing ? "멈춤" : "재생");
    playButton.setAttribute("aria-pressed", String(playing));
    recordButton.replaceChildren(icon(rec ? "stop" : "record"));
    recordButton.setAttribute("aria-label", rec ? "녹음 끝내기" : "녹음");
    recordButton.classList.toggle("on", !!rec);
    recordButton.classList.toggle("no-mic", !mic.ok);
    recordButton.disabled = readOnly() || (!!busy && !rec);
    addButton.disabled = readOnly() || !!busy || !!rec;
    undoButton.disabled = !undo.canUndo || !!rec;
    redoButton.disabled = !undo.canRedo || !!rec;
    speedButton.textContent = speedLabel(settings().songSpeed || 1);
    speedButton.setAttribute("aria-label", "재생 빠르기 " + speedLabel(settings().songSpeed || 1));
    const dark = settings().pianoTone === "dark";
    toneButton.replaceChildren(icon(dark ? "moon" : "sun"));
    toneButton.setAttribute("aria-label", "피아노 음색: " + (dark ? "어둡게" : "밝게"));
    toneButton.dataset.tone = dark ? "dark" : "bright";
    for (const b of modeSwitch.children) b.setAttribute("aria-pressed", String(b.dataset.value === settings().songMode));
    clockTime.textContent = timeText(playhead);
    const tempo = song.tempo();
    if (tempo) {
      const at = barBeat(playhead, tempo);
      beatLabel.textContent = `♩${tempo.bpm} · ${at.bar}.${at.beat}`;
    } else beatLabel.textContent = "♩ 박자";
  }

  const speedLabel = (s) => (s === 1 ? "1×" : String(s) + "×");

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
      app.blobs.get(src.blob).then((kept) => {
        localBlobs.set(src.blob, !!kept);
        if (kept) draw();
      });
    }
    return localBlobs.get(src.blob);
  }

  /** A sound's recording as samples at KEEP_RATE, or null when this device does not have it. */
  async function samplesOf(srcId) {
    const src = song.source(srcId);
    if (!src?.blob) return null;
    const kept = await app.blobs.get(src.blob);
    const wav = kept && decodeWav(kept.data);
    if (!wav) return null;
    const mono = toMono(wav.channels);
    return wav.rate === KEEP_RATE ? mono : resample(mono, wav.rate, KEEP_RATE);
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

  function makePlayer(ctx) {
    if (player) return player;
    player = new SongPlayer(ctx, { song: () => song, audioFor: (id) => audio.get(id) || null, onEnd: () => { playhead = player.position; stopFrames(); draw(); } });
    player.setMode(settings().songMode);
    player.setTone(settings().pianoTone);
    player.setSpeed(settings().songSpeed || 1);
    app.player = player; // for the scenarios: is the metronome clicking?
    return player;
  }

  /** Wakes the sound (from a tap) and has the player ready. */
  async function ready() {
    const ctx = await audioContext();
    if (!ctx) {
      toast(root, "이 브라우저는 소리를 낼 수 없어요");
      return null;
    }
    makePlayer(ctx);
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
    player.setMetronome(metronome());
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
      clockTime.textContent = timeText(playhead);
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

  function nextSpeed() {
    const now = settings().songSpeed || 1;
    const speed = SPEEDS[(SPEEDS.indexOf(now) + 1) % SPEEDS.length];
    setSetting(app.store, "songSpeed", speed);
    if (player && settings().songMode === "original" && speed !== 1) showStatus("빠르기를 맞추는 중…");
    // Stretching a long recording takes a moment; let the words show first.
    setTimeout(() => {
      player?.setSpeed(speed);
      showStatus(null);
    }, 30);
    toast(root, "재생 빠르기 " + speedLabel(speed), 1400);
    drawButtons();
  }

  // ---- recording ----------------------------------------------------------------

  async function toggleRecord() {
    if (rec) return stopRecording();
    if (readOnly() || busy) return;
    // Where the page may not use the microphone, say why and offer the phone's recorder.
    if (!mic.ok) return openAddSheet();
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
      toast(root, micProblem(err) + " 폰 녹음 앱으로도 넣을 수 있어요.", 4200);
      drawButtons();
      return void openAddSheet();
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
    // The other clips play along while you sing (and the metronome, when it is on).
    player.setMetronome(metronome());
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
    const begin = Math.max(0, Math.round(r.start - shift));
    await addTake({ samples: take.samples, rate: take.rate, result, start: begin, row: r.row, name: null });
    playhead = begin + Math.round(result.duration * 1000);
    draw();
  }

  // ---- importing ----------------------------------------------------------------

  async function importFile(file) {
    if (busy) return;
    if (!song.canAddClip()) return void toast(root, "클립은 방 하나에 200개까지예요");
    // Reading a file needs no sound, so nothing here waits for the audio to wake.
    const ctx = await audioContext({ wake: false });
    if (!ctx) return void toast(root, "이 브라우저는 소리 파일을 읽을 수 없어요");
    makePlayer(ctx);
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
  async function addTake({ samples, rate, result, start: at, row, name }) {
    const ctx = await audioContext({ wake: false });
    const kept = rate === KEEP_RATE ? samples : resample(samples, rate, KEEP_RATE);
    const blob = newBlobId();
    await app.blobs.put(blob, encodeWav(kept, KEEP_RATE), "audio/wav");
    localBlobs.set(blob, true);
    const by = session.memberId;
    const src = sourceOp(session.clock, song, { duration: result.duration, notes: result.notes, peaks: toBase64(result.peaks), by, at: Date.now(), blob, name });
    if (ctx) audio.set(src.id, bufferFromSamples(ctx, samples, rate));
    const length = Math.max(1, Math.round(result.duration * 1000));
    const place = song.freeRow(at, length, row) ?? row;
    const clip = addClipOps(session.clock, song, { src: src.id, row: place, start: at, length, by, at: Date.now() });
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

  const presence = () => ({ m: session.memberId, sel: selected, rec: rec ? { row: rec.row, at: rec.start } : null });

  function record(atoms) {
    if (!atoms.length) return;
    undo.record(atoms, { now: Date.now(), typing: false });
    drawButtons();
  }

  function apply(made) {
    if (!made || !made.ops || !made.ops.length) return false;
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

  function moveClip(id, at, row) {
    const clip = song.clip(id);
    if (!clip || clip.locked || readOnly()) return;
    const lane = Math.min(row, MAX_ROWS - 1);
    const step = gridStep();
    if (step) at = Math.max(0, Math.round(snapMs(at, step)));
    const place = song.freeRow(at, clip.length, lane, id);
    if (place === null) return void toast(root, "그 자리에는 놓을 수 없어요");
    if (place === clip.row && at === clip.start) return;
    apply(setClipOps(session.clock, song, id, { start: at, row: place }));
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
      source: { duration: src.dur / 1000, notes: song.notesOf(src.id).map((n) => ({ t: n.t / 1000, d: n.d / 1000, p: n.p, v: n.v })), peaks: src.peaks, blob: src.blob, name: src.name },
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

  /** 잇기: this clip and the next one on its row become one. */
  async function joinClip(id) {
    const plan = joinClipOps(session.clock, song, id, session.memberId);
    if (!plan) return void toast(root, "이 줄에서 뒤에 이을 클립이 없어요");
    if (plan.ops) {
      apply(plan);
      return void draw();
    }
    const { a, b } = plan.combine;
    if (a.locked || b.locked) return void toast(root, "잠긴 클립은 이을 수 없어요");
    busy = "join";
    showStatus("잇는 중…");
    try {
      const combined = combinedSource(song, a, b);
      // The joined recording too, when this device has both.
      let blob = null;
      let pcm = null;
      const [one, two] = await Promise.all([samplesOf(a.src), samplesOf(b.src)]);
      if (one && two) {
        const at = (ms) => Math.round((ms / 1000) * KEEP_RATE);
        pcm = new Float32Array(at(b.start + b.length - a.start));
        pcm.set(one.subarray(at(a.offset), at(a.offset + a.length)), 0);
        pcm.set(two.subarray(at(b.offset), at(b.offset + b.length)).subarray(0, pcm.length - at(b.start - a.start)), at(b.start - a.start));
        blob = newBlobId();
        await app.blobs.put(blob, encodeWav(pcm, KEEP_RATE), "audio/wav");
        localBlobs.set(blob, true);
      }
      const src = sourceOp(session.clock, song, { ...combined, by: session.memberId, at: Date.now(), blob, name: "이은 소리" });
      const made = joinWithSourceOps(session.clock, song, a, b, src, session.memberId);
      const ctx = await audioContext({ wake: false });
      if (pcm && ctx) audio.set(src.id, bufferFromSamples(ctx, pcm, KEEP_RATE));
      apply(made);
      selected = made.id;
    } finally {
      busy = null;
      showStatus(null);
      draw();
    }
  }

  /** 잠금: nobody moves, cuts or deletes it; whoever locked it and the room's owner can unlock. */
  function toggleLock(id) {
    const clip = song.clip(id);
    if (!clip) return;
    const me = session.memberId;
    if (clip.locked) {
      const owner = session.room.meta("createdBy") === me;
      if (clip.lockBy && clip.lockBy !== me && !owner) return void toast(root, "잠근 사람과 방장만 풀 수 있어요");
      apply(setClipOps(session.clock, song, id, { locked: false, lockBy: null }));
    } else apply(setClipOps(session.clock, song, id, { locked: true, lockBy: me }));
    draw();
  }

  function deleteClip(id) {
    if (song.clip(id)?.locked) return void toast(root, "잠긴 클립은 지울 수 없어요");
    if (apply(removeClipOps(session.clock, song, id))) selected = null;
    draw();
  }

  function insideClip(id) {
    const c = song.layout().find((x) => x.id === id);
    return !!c && playhead > c.start + 50 && playhead < c.start + c.length - 50;
  }

  // The small menu by a chosen clip.
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
    const next = song.nextOnRow(clip.id);
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
      item("clip-join", "잇기", () => joinClip(clip.id), locked || !next || next.locked || !!busy),
      item("clip-notes", "음 편집", () => editNotes(clip.id)),
      item("clip-send", "보내기", () => sendClip(clip.id)),
      item("clip-lock", clip.locked ? "잠금 풀기" : "잠금", () => toggleLock(clip.id), readOnly()),
      item("clip-delete", "삭제", () => deleteClip(clip.id), locked));
    const w = menu.offsetWidth;
    const hgt = menu.offsetHeight;
    let left = box.left - area.left + box.width / 2 - w / 2;
    left = Math.max(6, Math.min(area.width - w - 6, left));
    let top = box.top - area.top - hgt - 6;
    if (top < 4) top = box.bottom - area.top + 6;
    menu.style.left = left + "px";
    menu.style.top = Math.max(4, Math.min(top, area.height - hgt - 4)) + "px";
  }

  /** 보내기: puts the clip on a whiteboard as a song card, straight into that room. */
  function sendClip(id) {
    const clip = song.clip(id);
    const src = clip && song.source(clip.src);
    if (!src) return;
    const boards = app.store.get("rooms", []).filter((r) => r.kind === "creative-board");
    openSheet(root, "화이트보드로 보내기", (panel, close) => {
      if (!boards.length) return void panel.append(h("p", { class: "help", id: "no-boards", text: "화이트보드 방이 아직 없어요. 홈의 창작 +에서 만들 수 있어요." }));
      panel.append(h("div", { class: "kinds", id: "send-boards" }, boards.map((r) => h("button", { class: "kind", type: "button", data: { room: r.id }, onclick: () => { close(); deliver(r, clip, src); } },
        h("span", { class: "kind-name", text: r.name })))));
    });
  }

  async function deliver(room, clip, src) {
    showStatus("보내는 중…");
    let other = null;
    try {
      const transport = await app.transportFor(room.id);
      other = new RoomSession({ transport, roomId: room.id, store: app.store });
      if ((await other.open()) !== "ok") throw new Error("room did not open");
      const target = await other.load("board");
      const items = target.items();
      const right = items.reduce((a, b) => (!a || b.x + b.w > a.x + a.w ? b : a), null);
      const source = { duration: src.dur / 1000, notes: song.notesOf(src.id).map((n) => ({ t: n.t / 1000, d: n.d / 1000, p: n.p, v: n.v })), peaks: src.peaks, blob: src.blob, name: src.name };
      const data = cardFromClip({ source, offset: clip.offset, length: clip.length });
      const by = roomEntry(app.store, room.id)?.memberId || session.memberId;
      other.commit("board", addItemOps(other.clock, target, { kind: "song", x: right ? right.x + right.w + 60 : 40, y: right ? right.y : 40, data, by }).ops);
      for (let i = 0; i < 40 && other.pending; i++) await new Promise((r) => setTimeout(r, 100));
      toast(root, `'${room.name}' 화이트보드로 보냈어요`);
    } catch (err) {
      console.warn(err);
      toast(root, "보내지 못했어요. 그 화이트보드를 한 번 열었다가 다시 해 주세요.", 3600);
    } finally {
      other?.close();
      showStatus(null);
    }
  }

  /** 음 편집: the clip's notes as a piano roll. Edits go through the undo stack like any other step. */
  function editNotes(id) {
    const clip = song.clip(id);
    if (!clip) return;
    editor = openNoteEditor(root, {
      song, clipId: id, clock: session.clock, color: colorOf(clip.by),
      commit: (made) => apply(made),
      preview: async (p, seconds) => { if (await ready()) player.preview(p, seconds); },
      canEdit: () => !readOnly() && !song.clip(id)?.locked,
      beat: () => beatGrid(),
    });
  }

  // ---- 박자: tempo, meter, metronome, the grid --------------------------------------------

  const metronome = () => (settings().metronome ? song.tempo() : null);

  /** The grid step to snap to (ms), or null when there is no tempo or snapping is off. */
  function gridStep() {
    const tempo = song.tempo();
    return tempo && settings().snap !== false ? stepMs(tempo, settings().grid || 8) : null;
  }

  /** What 음 편집 needs of the grid, or null without a tempo. */
  function beatGrid() {
    const tempo = song.tempo();
    if (!tempo) return null;
    return { step: stepMs(tempo, settings().grid || 8), beat: beatMs(tempo), bar: barMs(tempo), snap: settings().snap !== false };
  }

  /** Every note's start on the timeline (ms), for finding the tempo. */
  function noteStarts() {
    const out = [];
    for (const c of song.layout()) {
      if (c.muted) continue;
      for (const n of song.notesOf(c.src)) if (n.t >= c.offset && n.t < c.offset + c.length) out.push(c.start + n.t - c.offset);
    }
    return out.sort((a, b) => a - b);
  }

  /** The 박자 sheet. Changes are heard and seen at once; closing it keeps them as one undo step. */
  function openBeatSheet() {
    if (rec) return;
    closeAdd?.();
    const before = song.tempo();
    let tempo = before || { bpm: 100, beats: 4, unit: 4 };
    const live = (next) => {
      tempo = next;
      session.commit("song", tempoOps(session.clock, song, tempo, session.memberId).ops);
      if (player) player.setMetronome(metronome());
      draw();
    };
    openSheet(root, "박자", (panel, close, onClose) => {
      const s = settings();
      const input = h("input", { class: "input bpm-input", id: "bpm-input", type: "number", inputMode: "numeric", min: String(MIN_BPM), max: String(MAX_BPM), value: String(tempo.bpm), "aria-label": "빠르기 (BPM)" });
      const setBpm = (bpm) => {
        const v = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)));
        input.value = String(v);
        live({ ...tempo, bpm: v });
      };
      input.addEventListener("change", () => setBpm(Number(input.value) || tempo.bpm));
      const taps = [];
      const tap = () => {
        const t = performance.now();
        if (taps.length && t - taps[taps.length - 1] > 2500) taps.length = 0;
        taps.push(t);
        const bpm = tapTempo(taps.slice(-8));
        if (bpm) setBpm(bpm);
      };
      const guess = () => {
        const bpm = estimateTempo(noteStarts());
        if (bpm) setBpm(bpm);
        else toast(root, "음이 네 개는 있어야 빠르기를 찾을 수 있어요");
      };
      const meters = segmented(METERS.map(([b, u]) => [`${b}/${u}`, `${b}/${u}`, `meter-${b}-${u}`]), `${tempo.beats}/${tempo.unit}`, (v) => {
        const [beats, unit] = v.split("/").map(Number);
        live({ ...tempo, beats, unit });
      });
      const grids = segmented(GRIDS.map((g) => [String(g), "1/" + g, "grid-" + g]), String(s.grid || 8), (v) => { setSetting(app.store, "grid", Number(v)); draw(); });
      panel.append(h("div", { class: "form", id: "beat-sheet" },
        h("div", { class: "bpm-row" },
          h("span", { class: "bpm-mark", text: "♩ =" }),
          h("button", { type: "button", class: "chip", id: "bpm-down", text: "−", "aria-label": "느리게", onclick: () => setBpm(tempo.bpm - 1) }),
          input,
          h("button", { type: "button", class: "chip", id: "bpm-up", text: "+", "aria-label": "빠르게", onclick: () => setBpm(tempo.bpm + 1) })),
        h("div", { class: "elsewhere" },
          h("button", { type: "button", class: "btn quiet small", id: "tap-tempo", text: "탭으로 맞추기", onclick: tap }),
          h("button", { type: "button", class: "btn quiet small", id: "guess-tempo", text: "노래에서 찾기", onclick: guess })),
        h("p", { class: "label", text: "박자표" }), meters,
        h("p", { class: "label", text: "격자 (옮길 때 붙는 단위, 박자 맞추기)" }), grids,
        toggle("metronome", "메트로놈: 재생하고 녹음할 때 박마다 소리", !!s.metronome, (on) => { setSetting(app.store, "metronome", on); player?.setMetronome(metronome()); }),
        toggle("snap", "격자에 붙이기: 클립과 음을 옮길 때", s.snap !== false, (on) => setSetting(app.store, "snap", on)),
        h("button", { type: "button", class: "btn quiet small", id: "tempo-off", text: "박자 끄기", onclick: () => { live(null); close(); } })));
      onClose(() => {
        const after = song.tempo();
        if (JSON.stringify(after) === JSON.stringify(before)) return;
        const off = { bpm: 0, beats: 4, unit: 4 };
        record([{ k: "tempo", prev: before || off, next: after || off, by: session.memberId }]);
        draw();
      });
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
        h("button", { class: "btn quiet", id: "settings-import", type: "button", text: "소리 넣기 (녹음·녹음 앱·파일)", onclick: () => { close(); openAddSheet(); } })));
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
  // While a friend records, their growing placeholder needs a steady redraw.
  const friendTimer = setInterval(() => { if (peerRecs.size) draw(); }, 250);
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
      clearInterval(friendTimer);
      if (rec) rec.recorder.stop();
      rec = null;
      player?.close();
      editor?.close();
      closeAdd?.();
      stopPickerWatch();
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
