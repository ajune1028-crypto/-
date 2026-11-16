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

import { h, icon, iconButton, segmented, toggle, openSheet, toast, closeOnOutside } from "./dom.js";
import { currentTheme, onThemeChange } from "./theme.js";
import { Timeline, timeText } from "./song-view.js";
import { openNoteEditor } from "./note-editor.js";
import { UndoStack } from "../core/undo.js";
import { memberColor, INK, PALETTE } from "../core/paint.js";
import {
  MAX_ROWS, MAX_TAKE_MS, SongDoc, sourceOp, addClipOps, setClipOps, removeClipOps, splitClipOps, invertSongOps, tempoOps, CLIP_SPEEDS, clipSpan,
  joinClipOps, joinWithSourceOps, combinedSource,
  packMs, noteInSeconds,
} from "../core/song.js";
import { getSettings, setSetting, roomEntry } from "../identity.js";
import { stepMs, beatMs, barMs, barBeat, snapMs, estimateTempo, tapTempo, METERS, GRIDS, MIN_BPM, MAX_BPM } from "../core/beat.js";
import { copyItem, clipboardItem } from "../clipboard.js";
import { audioContext, SongPlayer } from "../audio/engine.js";
import { Analyzer, analyzeSamples } from "../audio/analyze.js";
import { MicRecorder, micSupport, micProblem } from "../audio/recorder.js";
import { decodeAudioFile, bufferFromSamples } from "../audio/decode.js";
import { encodeWav, decodeWav } from "../audio/wav.js";
import { resample, toMono, louder } from "../audio/dsp.js";
import { toBase64, scalePeaks } from "../audio/peaks.js";
import { newBlobId } from "../sync/blobs.js";
import { keepTake, takeWhere } from "./keep-take.js";
import { soundTitle } from "./names.js";
import { buzz } from "./chime.js";
import { reachableRooms, meIn } from "./room-actions.js";
import { KEEP_RATE, soundPickers, waysIn as soundWays, pickerHelp as noChooserHelp, micRefused } from "./sound-in.js";
import { RoomSession } from "../sync/session.js";
import { addItemOps, cardFromClip, keptFields, setItemOps } from "../core/board.js";

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
  let menuView = "main"; // the clip menu's words, or "tints" (색)
  let editor = null;
  let closeAdd = null;
  const peerRecs = new Map(); // peer key → { row, at, since, name, color }
  // 올가미 in the song room (the owner: "노래 만들기에서도 올가미 기능도 있어야… 센스 있게"): the
  // clips a drawn loop went round, worked on together until let go.
  let group = new Set();
  let groupMenu = null;
  let groupView = "main";
  let groupRepeat = false;

  body.classList.add("song-body");
  const timeline = new Timeline({
    seek: (ms) => seek(ms),
    tapEmpty: (ms, row) => {
      selectedRow = Math.min(row, Math.max(0, song.rowCount() - 1));
      select(null);
      seek(ms);
    },
    // A tap is a place too (the owner: "15초에 거기 가가지고 그 한번 터치해서… 분할 누르면 거기 딱"):
    // stopped, the playhead comes to where the clip was touched, unless it already stood
    // inside that clip (put there on the time bar first). A tap on the chosen clip aims again.
    select: (id, ms) => {
      if (ms != null && !rec && !player?.playing && (selected === id || !insideClip(id))) seek(ms);
      select(id);
    },
    move: (id, start, row) => (group.has(id) && group.size > 1 ? moveGroup(id, start, row) : moveClip(id, start, row)),
    lasso: (ids) => {
      setLasso(false);
      group = new Set(ids.filter((id) => song.clip(id) && !song.clip(id).removed));
      if (!group.size) toast(root, "둘러싼 클립이 없어요. 클립들을 크게 둘러 주세요", 2400);
      select(null);
      draw();
    },
    canMove: (id) => !readOnly() && !song.clip(id)?.locked,
    zoomed: () => { placeMenu(); positionGroupMenu(); },
    rowMute: (row) => muteRow(row),
    rowSolo: (row) => soloRowToggle(row),
    buzz: (ms) => buzz(app, ms),
  });
  body.append(timeline.el);
  timeline.el.addEventListener("scroll", () => { placeMenu(); positionGroupMenu(); });

  // ---- controls ------------------------------------------------------------------

  // The time, and under it the song's 박자; a tap opens the 박자 sheet.
  const clockTime = h("span", { class: "clock-time", id: "song-clock", text: "0:00.0" });
  const beatLabel = h("span", { class: "clock-beat", id: "beat-label", text: "♩ 박자" });
  const clock = h("button", { class: "song-clock", id: "beat", type: "button", "aria-label": "박자 (빠르기, 박자표, 메트로놈)", onclick: () => openBeatSheet(), data: { contrast: "" } }, clockTime, beatLabel);
  const zoomOut = iconButton("zoom-out", "zoomOut", "좁게 보기", () => timeline.setZoom(timeline.pps / 1.4, playhead));
  const zoomIn = iconButton("zoom-in", "zoomIn", "넓게 보기", () => timeline.setZoom(timeline.pps * 1.4, playhead));
  const lassoButton = iconButton("song-lasso", "lasso", "올가미 (둘러서 여러 클립 고르기)", () => setLasso(!timeline.lassoOn));
  function setLasso(on) {
    timeline.setLasso(on);
    lassoButton.setAttribute("aria-pressed", String(!!on));
    if (on) toast(root, "클립들을 손가락으로 둘러 그리세요", 1800);
  }
  const modeSwitch = segmented([["original", "원본", "mode-original"], ["piano", "피아노", "mode-piano"]], settings().songMode, (mode) => setMode(mode), "mode");
  // They lie straight on the room's background: they read it (white, black or a deeper black).
  for (const el of [zoomOut, zoomIn, lassoButton, modeSwitch]) el.dataset.contrast = "";
  modeSwitch.classList.add("mode-switch");
  modeSwitch.setAttribute("aria-label", "듣는 방식");
  frame.top.append(h("div", { class: "song-top" }, h("div", { class: "song-top-left" }, clock, zoomOut, zoomIn, lassoButton), modeSwitch));

  const startButton = iconButton("to-start", "start", "처음으로", () => seek(0), "처음");
  const playButton = iconButton("play", "play", "재생", () => togglePlay(), "재생");
  const recordButton = iconButton("record", "record", "녹음", () => toggleRecord(), "녹음");
  recordButton.classList.add("rec-btn");
  const addButton = iconButton("import", "upload", "소리 넣기", () => openAddSheet(), "넣기");
  const undoButton = iconButton("undo", "undo", "실행취소", () => step("undo"), "되돌리기");
  const redoButton = iconButton("redo", "redo", "다시실행", () => step("redo"), "다시하기");
  const speedButton = h("button", { class: "icon-btn speed-btn", id: "speed", type: "button", "aria-label": "재생 빠르기", data: { cap: "빠르기" }, onclick: () => nextSpeed() });
  const toneButton = iconButton("tone", "sun", "피아노 음색", () => setTone(settings().pianoTone === "dark" ? "bright" : "dark"), "음색");
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
  // 옆 패널 (the owner chose it for an iPad lying down): on a wide screen the chosen clip's words
  // and actions stand at the side instead of floating over the rows; with nothing chosen, what the
  // song is. The timeline keeps the rest of the width, so nothing is covered.
  const side = h("aside", { class: "song-side", id: "song-side", "aria-label": "고른 클립" });
  body.append(side);
  const wideSide = matchMedia("(min-width: 1000px) and (min-height: 600px) and (orientation: landscape)");
  const onWide = () => { if (alive) { menu?.stopGuard?.(); menu?.remove(); menu = null; draw(); } };
  wideSide.addEventListener?.("change", onWide);

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

  /** A clip's colour: its own (색), else the colour of whoever recorded it. */
  function clipColor(clip) {
    return clip.tint != null ? memberColor(clip.tint, currentTheme()) : colorOf(clip.by);
  }
  /**
   * What a clip is (the owner: "녹음 직사각형 이름이 안 나와", "mp3 가지고 왔으면 그것의 이름과
   * 어떤 mp3인지"): its file's name and kind, or 녹음 N for a take made here, and who put it in.
   */
/** A colour dot's words: whose colour it is in this room, if anyone's. */
  function dotLabel(i) {
    const who = session.room.members().filter((m) => m.color === i).map((m) => m.name);
    return who.length ? `${who.join(", ")}의 색` : "색 " + (i + 1);
  }
  const dotLetter = (i) => session.room.members().find((m) => m.color === i)?.name?.slice(0, 1) || "";

    function clipName(clip) {
    const src = song.source(clip.src);
    if (!src) return { title: "", kind: null, long: null, who: "" };
    let fallback = "녹음";
    if (!src.name) {
      const takes = [...new Set(song.layout().map((c) => c.src))].map((id) => song.source(id)).filter((s) => s && !s.name).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
      fallback = "녹음 " + (takes.findIndex((s) => s.id === src.id) + 1);
    }
    return { ...soundTitle(src.name, fallback), who: session.room.member(src.by)?.name || "" };
  }


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
      clips, source: (id) => song.source(id), notesOf: (id) => song.notesOf(id), color: clipColor, name: clipName, group, mode: settings().songMode, showWave: settings().showWave,
      selected, selectedRow, peers: peerSelections(), rows: Math.max(song.rowCount(), rec ? rec.row + 1 : 1, ...[...peerRecs.values()].map((r) => r.row + 1)),
      end: Math.max(song.end(), rec ? rec.start + rec.ms : 0), hasAudio: (id) => !!audio.get(id) || hasLocalBlob(id),
      recording: rec && { row: rec.row, start: rec.start, ms: rec.ms, notes: rec.notes },
      others: [...peerRecs.values()].map((r) => ({ row: r.row, start: r.at, ms: performance.now() - r.since, name: r.name, color: r.color })),
      playhead, empty, tempo: song.tempo(), heads: rowHeads(),
    };
  }

  // ---- 줄 머리: who is on each row, 음소거 for the row, 혼자 듣기 --------------------------
  let soloRow = null; // the row heard alone on this device (null: all of them)
  let soloView = null;

  function rowHeads() {
    const rows = new Map();
    for (const c of song.layout()) {
      let r = rows.get(c.lane);
      if (!r) rows.set(c.lane, (r = { row: c.lane, by: [], muted: true }));
      if (!c.muted) r.muted = false;
      if (!r.by.includes(c.by)) r.by.push(c.by);
    }
    return [...rows.values()].map((r) => ({
      row: r.row, muted: r.muted, solo: soloRow === r.row, readOnly: readOnly(),
      colors: r.by.slice(0, 3).map(colorOf),
      names: r.by.map((by) => session.room.member(by)?.name || "누군가").join(", "),
    }));
  }

  /** 음소거 for the whole row, for everyone (as a clip's 음소거 is); one undo step. */
  function muteRow(row) {
    if (readOnly()) return;
    const clips = song.layout().filter((c) => c.lane === row);
    if (!clips.length) return;
    const mute = clips.some((c) => !c.muted);
    const atoms = [];
    for (const c of clips) {
      if (!!c.muted === mute) continue;
      const made = setClipOps(session.clock, song, c.id, { muted: mute });
      if (!made?.ops?.length) continue;
      session.commit("song", made.ops);
      atoms.push(...made.atoms);
    }
    record(atoms);
    toast(root, mute ? `${row + 1}번 줄을 음소거했어요` : `${row + 1}번 줄 소리를 켰어요`, 1600);
    draw();
  }

  /** 혼자 듣기: only this row plays (on this device); again, all of them. */
  function soloRowToggle(row) {
    soloRow = soloRow === row ? null : row;
    soloView = null;
    if (soloRow !== null) {
      const only = soloRow;
      // The song as it is, with only this row's clips: the player reads it as it reads the song.
      soloView = Object.create(song);
      soloView.layout = () => song.layout().filter((c) => c.lane === only);
      soloView.clips = () => soloView.layout();
    }
    toast(root, soloRow === null ? "모든 줄을 들어요" : `${soloRow + 1}번 줄만 들어요`, 1600);
    draw();
  }

  /** What ▶ plays: the song, or one row of it while that row is heard alone. */
  const heard = () => soloView || song;

  function draw() {
    if (!alive) return;
    trackPeerRecordings();
    timeline.render(model());
    placeGroupMenu();
    const showStart = loaded && !song.layout().length && !rec && !readOnly();
    if (showStart && !start.childNodes.length) start.append(h("p", { class: "start-title", text: "소리를 넣어 보세요" }), h("p", { class: "help", text: "흥얼거린 음과 길이 그대로 피아노 음이 돼요." }), ...waysIn("start-"));
    start.hidden = !showStart;
    drawButtons();
    placeMenu();
    drawSide();
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
    player = new SongPlayer(ctx, { song: () => heard(), audioFor: (id) => audio.get(id) || null, onEnd: () => { playhead = player.position; stopFrames(); draw(); } });
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
    if (playhead >= heard().end() && heard().end() > 0) playhead = 0;
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
      } else if (player?.playing) {
        playhead = player.position;
        // What sounds now glows.
        const now = heard().layout().filter((c) => !c.muted && c.start <= playhead && playhead < c.start + c.length).map((c) => c.id);
        if (now.join() !== sounding.join()) timeline.markPlaying(sounding = now);
      } else {
        if (sounding.length) timeline.markPlaying(sounding = []);
        return void draw();
      }
      timeline.setPlayhead(playhead);
      timeline.follow(playhead);
      clockTime.textContent = timeText(playhead);
      frameReq = requestAnimationFrame(tick);
    };
    frameReq = requestAnimationFrame(tick);
  }

  function stopFrames() {
    cancelAnimationFrame(frameReq);
    if (sounding.length && !soloClip) timeline.markPlaying(sounding = []);
  }

  // ▶ 듣기 in a clip's menu: just that clip, on a player of its own. Again stops it.
  let sounding = [];
  let soloClip = null;
  let soloPlayer = null;
  async function playClipAlone(id) {
    if (soloPlayer?.playing) {
      const was = soloClip;
      stopSolo();
      if (was === id) return;
    }
    if (player?.playing) await togglePlay();
    const clip = song.clip(id);
    const src = clip && song.source(clip.src);
    const ctx = src && (await ready());
    if (!ctx) return;
    const one = new SongDoc();
    one.apply({ t: "src", id: src.id, dur: src.dur, notes: song.notesOf(src.id).map(packMs), peaks: src.peaks || "", by: src.by, at: 0, ...(src.blob ? { blob: src.blob } : {}) });
    one.apply({ t: "clip", id: clip.id, src: src.id, row: 0, start: 0, offset: clip.offset, length: clip.length, by: clip.by, at: 0 });
    if ((clip.speed || 1) !== 1) one.apply({ t: "cset", id: "2@solo", c: clip.id, f: { speed: clip.speed } });
    soloPlayer?.close();
    soloPlayer = new SongPlayer(ctx, { song: () => one, audioFor: (sid) => audio.get(sid) || null, onEnd: () => stopSolo() });
    soloPlayer.setMode(settings().songMode);
    soloPlayer.setTone(settings().pianoTone);
    soloPlayer.setSpeed(settings().songSpeed || 1);
    soloClip = id;
    soloPlayer.play(0);
    timeline.markPlaying(sounding = [id]);
    placeMenu();
  }

  function stopSolo() {
    soloPlayer?.stop();
    soloClip = null;
    timeline.markPlaying(sounding = []);
    if (alive) placeMenu();
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
      drawButtons();
      // Not allowed: one tap brings the browser's own question back; anything else, the other ways in.
      if (err?.name === "NotAllowedError" || err?.name === "SecurityError") return void micRefused({ app, root, err, retry: () => toggleRecord() });
      toast(root, micProblem(err) + " 폰 녹음 앱으로도 넣을 수 있어요.", 4200);
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
    // A take sung softly (the phone far away) is made loud enough to hear; its waveform follows.
    const up = louder(take.samples);
    result.peaks = scalePeaks(result.peaks, up.gain);
    await addTake({ samples: up.samples, rate: take.rate, result, start: begin, row: r.row, name: null });
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
      samples = louder(samples).samples;
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
    keepTake(app, { name, result, blob, where: takeWhere(app, session.roomId) });
  }

  // ---- clips ----------------------------------------------------------------------

  function select(id) {
    if (id !== selected) menuView = "main";
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

  // ---- 올가미: the gathered clips ------------------------------------------------------

  /** The group's own bar over the rows: what can be done with the gathered clips together. */
  function placeGroupMenu() {
    for (const id of [...group]) if (!song.clip(id) || song.clip(id).removed) group.delete(id);
    if (!group.size || rec) {
      groupMenu?.remove();
      groupMenu = null;
      groupView = "main";
      return;
    }
    if (!groupMenu) {
      groupMenu = h("div", { class: "group-menu", id: "group-menu", role: "toolbar", "aria-label": "올가미로 고른 클립" });
      body.append(groupMenu);
    }
    const clips = [...group].map((id) => song.clip(id));
    const can = !readOnly() && clips.every((c) => !c.locked);
    const one = (id, text, fn, show = true) => show && h("button", { type: "button", id, text, onclick: (e) => { e.stopPropagation(); fn(); } });
    if (groupView === "tints" && can) {
      groupMenu.replaceChildren(...PALETTE.map((_, i) => h("button", { type: "button", class: "menu-dot", data: { tint: String(i) }, "aria-label": dotLabel(i), text: dotLetter(i),
        style: { background: memberColor(i, currentTheme()) }, onclick: (e) => { e.stopPropagation(); groupView = "main"; groupSet(() => ({ tint: i })); } })),
      one("group-tint-none", "기본", () => { groupView = "main"; groupSet(() => ({ tint: null })); }),
      one("group-tint-back", "←", () => { groupView = "main"; placeGroupMenu(); }));
      return;
    }
    const muted = clips.every((c) => c.muted);
    groupMenu.replaceChildren(...[
      h("span", { class: "group-count", text: `클립 ${clips.length}개` }),
      one("group-play", groupSolo ? "■ 멈춤" : "▶ 듣기", () => playGroup()),
      one("group-repeat", groupRepeat ? "반복 끄기" : "반복", () => { groupRepeat = !groupRepeat; if (groupRepeat && !groupSolo) playGroup(); placeGroupMenu(); }),
      one("group-mute", muted ? "소리 켜기" : "음소거", () => groupSet(() => ({ muted: !muted })), can),
      one("group-speed", `빠르기 ${clips[0].speed || 1}×`, () => {
        const next = CLIP_SPEEDS[(CLIP_SPEEDS.indexOf(clips[0].speed || 1) + 1) % CLIP_SPEEDS.length];
        groupSet(() => ({ speed: next }));
      }, can),
      one("group-tint", "색", () => { groupView = "tints"; placeGroupMenu(); }, can),
      one("group-copy", "복사", () => copyGroup()),
      one("group-delete", "지우기", () => { const atoms = []; for (const c of clips) { const made = removeClipOps(session.clock, song, c.id); if (made?.ops?.length) { session.commit("song", made.ops); atoms.push(...made.atoms); } } record(atoms); group = new Set(); draw(); }, can),
      one("group-close", "✕", () => { group = new Set(); stopGroup(); draw(); }),
    ].filter(Boolean));
    positionGroupMenu();
  }

  /** The group's menu goes just below the gathered clips (above them when there is no room), never over them. */
  function positionGroupMenu() {
    if (!groupMenu) return;
    const area = body.getBoundingClientRect();
    const rects = [...group].map((id) => timeline.el.querySelector(`.clip[data-id="${id}"]`)?.getBoundingClientRect()).filter(Boolean);
    if (!rects.length) return;
    const w = groupMenu.offsetWidth;
    const hgt = groupMenu.offsetHeight;
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    let y = bottom - area.top + 6;
    if (y + hgt > area.height - 4) y = top - area.top - hgt - 6;
    if (y < 4) y = Math.max(4, area.height - hgt - 4);
    const mid = (Math.max(area.left, Math.min(...rects.map((r) => r.left))) + Math.min(area.right, Math.max(...rects.map((r) => r.right)))) / 2;
    groupMenu.style.left = Math.max(4, Math.min(area.width - w - 4, mid - area.left - w / 2)) + "px";
    groupMenu.style.top = y + "px";
  }

  /** The same change to every gathered clip, as one undo step. */
  function groupSet(fields) {
    const atoms = [];
    for (const id of group) {
      const made = setClipOps(session.clock, song, id, fields(song.clip(id)));
      if (!made?.ops?.length) continue;
      session.commit("song", made.ops);
      atoms.push(...made.atoms);
    }
    record(atoms);
    draw();
  }

  /** Dragging one gathered clip takes them all by the same time and rows (if they all fit there). */
  function moveGroup(id, at, row) {
    const lead = song.layout().find((c) => c.id === id);
    if (!lead || readOnly()) return;
    const step = gridStep();
    if (step) at = Math.max(0, Math.round(snapMs(at, step)));
    const dt = at - lead.start;
    const dr = Math.min(row, MAX_ROWS - 1) - lead.lane;
    const moving = song.layout().filter((c) => group.has(c.id));
    if (moving.some((c) => c.locked)) return void toast(root, "잠긴 클립이 있어서 옮길 수 없어요");
    const place = moving.map((c) => ({ id: c.id, start: c.start + dt, row: c.lane + dr, span: clipSpan(c) }));
    if (place.some((p) => p.start < 0 || p.row < 0 || p.row >= MAX_ROWS)) return void toast(root, "그 자리에는 놓을 수 없어요");
    // Every one must lie clear of the clips that stay.
    const stay = song.layout().filter((c) => !group.has(c.id));
    const clash = place.some((p) => stay.some((c) => c.lane === p.row && p.start < c.start + clipSpan(c) && c.start < p.start + p.span));
    if (clash) return void toast(root, "그 자리에는 다른 클립이 있어요");
    const atoms = [];
    for (const p of place) {
      const made = setClipOps(session.clock, song, p.id, { start: p.start, row: p.row });
      if (!made?.ops?.length) continue;
      session.commit("song", made.ops);
      atoms.push(...made.atoms);
    }
    record(atoms);
    draw();
  }

  let groupSolo = null; // the player of the gathered clips alone
  /** ▶ of the group: only the gathered clips, as they stand to each other; with 반복, again and again. */
  async function playGroup() {
    if (groupSolo?.playing) return void stopGroup();
    if (player?.playing) await togglePlay();
    if (soloPlayer?.playing) stopSolo();
    const ctx = await ready();
    if (!ctx || !group.size) return;
    const clips = song.layout().filter((c) => group.has(c.id));
    const from = Math.min(...clips.map((c) => c.start));
    const part = new SongDoc();
    let n = 0;
    for (const c of clips) {
      const src = song.source(c.src);
      if (!src) continue;
      if (!part.source(src.id)) part.apply({ t: "src", id: src.id, dur: src.dur, notes: song.notesOf(src.id).map(packMs), peaks: src.peaks || "", by: src.by, at: 0, ...(src.blob ? { blob: src.blob } : {}) });
      part.apply({ t: "clip", id: c.id, src: src.id, row: c.lane, start: c.start - from, offset: c.offset, length: c.length, by: c.by, at: 0 });
      const f = {};
      if ((c.speed || 1) !== 1) f.speed = c.speed;
      if (c.muted) f.muted = true;
      if (Object.keys(f).length) part.apply({ t: "cset", id: `${++n}@group`, c: c.id, f });
    }
    groupSolo?.close();
    groupSolo = new SongPlayer(ctx, { song: () => part, audioFor: (sid) => audio.get(sid) || null, onEnd: () => {
      if (groupRepeat && group.size && alive) return void groupSolo.play(0);
      stopGroup();
    } });
    groupSolo.setMode(settings().songMode);
    groupSolo.setTone(settings().pianoTone);
    groupSolo.setSpeed(settings().songSpeed || 1);
    groupSolo.play(0);
    timeline.markPlaying(sounding = clips.map((c) => c.id));
    placeGroupMenu();
  }

  function stopGroup() {
    groupSolo?.stop();
    groupSolo = null;
    timeline.markPlaying(sounding = []);
    if (alive) placeGroupMenu();
  }

  /** 복사 of the group: put down again at the playhead (here or in another song room), as they stood. */
  function copyGroup() {
    const clips = song.layout().filter((c) => group.has(c.id));
    const from = Math.min(...clips.map((c) => c.start));
    const top = Math.min(...clips.map((c) => c.lane));
    copyItem(app.store, {
      kind: "song-clips", room: session.roomId,
      clips: clips.map((c) => {
        const src = song.source(c.src);
        return { dx: c.start - from, dy: c.lane - top, offset: c.offset, length: c.length, speed: c.speed || 1, tint: c.tint ?? null, muted: !!c.muted, src: c.src,
          source: { duration: src.dur / 1000, notes: song.notesOf(src.id).map(noteInSeconds), peaks: src.peaks, blob: src.blob, name: src.name } };
      }),
    });
    toast(root, `클립 ${clips.length}개를 복사했어요. 클립을 눌러 '붙여넣기'로 넣어요`, 2600);
  }

  function moveClip(id, at, row) {
    const clip = song.clip(id);
    if (!clip || clip.locked || readOnly()) return;
    const lane = Math.min(row, MAX_ROWS - 1);
    const step = gridStep();
    if (step) at = Math.max(0, Math.round(snapMs(at, step)));
    // On the row it was dropped on, it may not lie over another clip: it goes to the nearest
    // gap where it fits on that row (against its neighbour); when none is near, the row below.
    const span = clipSpan(clip);
    const asked = at;
    const near = song.nearestGap(at, span, lane, id, Math.max(2000, span));
    if (near !== null) at = near;
    const place = near !== null ? lane : song.freeRow(at, span, lane, id);
    if (place === null) return void toast(root, "그 자리에는 놓을 수 없어요");
    if (place === clip.row && at === clip.start) return;
    // Put against a neighbour (or a row down): a short buzz says it took its place.
    if (at !== asked || place !== lane) buzz(app, 10);
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
      kind: "song-clip", room: session.roomId, src: src.id, offset: clip.offset, length: clip.length, speed: clip.speed || 1, tint: clip.tint ?? null,
      source: { duration: src.dur / 1000, notes: song.notesOf(src.id).map(noteInSeconds), peaks: src.peaks, blob: src.blob, name: src.name },
    });
    toast(root, "복사했어요. 다른 노래 방에도 붙여넣을 수 있어요", 2400);
    draw();
  }

  function pasteClip() {
    const item = clipboardItem(app.store, "song-clip");
    if (!item || readOnly()) return;
    if (!song.canAddClip()) return void toast(root, "클립은 방 하나에 200개까지예요");
    const speed = CLIP_SPEEDS.includes(item.speed) ? item.speed : 1;
    const row = song.freeRow(playhead, Math.round(item.length / speed), selectedRow);
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
    // Its own speed and colour come along (one undo still takes the clip away).
    const looks = { ...(speed !== 1 ? { speed } : {}), ...(Number.isInteger(item.tint) && item.tint >= 0 && item.tint <= 7 ? { tint: item.tint } : {}) };
    if (Object.keys(looks).length) session.commit("song", setClipOps(session.clock, song, clip.id, looks).ops);
    record(clip.atoms);
    selectedRow = row;
    select(clip.id);
  }

  /** 붙여넣기 of copied clips (an 올가미's): at the playhead, as they stood to each other; one undo step. */
  function pasteGroup() {
    const item = clipboardItem(app.store, "song-clips");
    if (!item || readOnly()) return;
    const ops = [];
    const atoms = [];
    const made = new Map(); // a source from another room, once
    const placed = [];
    for (const c of item.clips) {
      if (!song.canAddClip()) break;
      let srcId = item.room === session.roomId && song.source(c.src) ? c.src : made.get(c.src);
      if (!srcId) {
        const src = sourceOp(session.clock, song, { ...c.source, by: session.memberId, at: Date.now() });
        ops.push(src);
        song.apply(src);
        srcId = src.id;
        made.set(c.src, srcId);
      }
      const span = Math.round(c.length / (CLIP_SPEEDS.includes(c.speed) ? c.speed : 1));
      const start = playhead + c.dx;
      const row = song.freeRow(start, span, selectedRow + c.dy) ?? null;
      if (row === null) continue;
      const clip = addClipOps(session.clock, song, { src: srcId, row, start, offset: c.offset, length: c.length, by: session.memberId, at: Date.now() });
      for (const op of clip.ops) song.apply(op);
      ops.push(...clip.ops);
      atoms.push(...clip.atoms);
      const looks = {};
      if ((c.speed || 1) !== 1 && CLIP_SPEEDS.includes(c.speed)) looks.speed = c.speed;
      if (Number.isInteger(c.tint)) looks.tint = c.tint;
      if (c.muted) looks.muted = true;
      if (Object.keys(looks).length) {
        const set = setClipOps(session.clock, song, clip.id, looks);
        for (const op of set.ops) song.apply(op);
        ops.push(...set.ops);
      }
      placed.push(clip.id);
    }
    if (!ops.length) return void toast(root, "이 자리에는 줄이 더 없어요");
    session.commit("song", ops);
    record(atoms);
    group = new Set(placed);
    select(null);
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
    if (!plan) {
      const c = song.clip(id);
      const next = song.nextOnRow(id);
      return void toast(root, next && (next.speed || 1) !== (c?.speed || 1) ? "빠르기가 다른 클립은 이을 수 없어요" : next && (c?.speed || 1) !== 1 ? "빠르기를 바꾼 클립은 같은 녹음끼리만 이을 수 있어요" : "이 줄에서 뒤에 이을 클립이 없어요");
    }
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
    return !!c && playhead > c.start + 50 && playhead < c.start + clipSpan(c) - 50;
  }

  // The small menu by a chosen clip.
  function placeMenu() {
    if (!selected || rec) {
      menu?.stopGuard?.();
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
    const docked = wideSide.matches;
    if (!menu) {
      menu = h("div", { class: "clip-menu" + (docked ? " side" : ""), id: "clip-menu", role: "toolbar", "aria-label": "클립 메뉴" });
      (docked ? side : body).append(menu);
      // A tap anywhere else only puts the menu away; the chosen clip, the time bar (to place
      // the playhead for 분할) and the tool bars still work. At the side it covers nothing, so a
      // tap elsewhere does what it does (another clip is chosen at once).
      if (!docked) {
        menu.stopGuard = closeOnOutside(
          (t) => menu?.contains(t) || !!document.querySelector(`.clip[data-id="${selected}"]`)?.contains(t) || !!t.closest?.("#ruler"),
          () => select(null), menu);
      }
    }
    // Only what can be done now is there: no greyed words (본질 5, "가리지 않는다").
    const item = (id, text, onclick, can = true) => can && h("button", { type: "button", id, text, onclick: (e) => { e.stopPropagation(); onclick(); } });
    // 색: the people colours in place of the menu (small, so it covers little), and 기본 (the recorder's).
    const named = clipName(clip);
    if (menuView === "tints" && !locked) {
      const now = clip.tint ?? null;
      // Whose it is, so a colour that is a person's is not taken for theirs (the owner: "색깔 들어가면은
      // 누구 건지도 알 수 있게끔"): the maker's name by their colour, and on each dot that is someone's here, their first letter.
      const owner = session.room.member(song.source(clip.src)?.by || clip.by);
      menu.replaceChildren(...[
        h("p", { class: "menu-info", id: "clip-owner" }, h("span", { class: "menu-swatch", style: { background: colorOf(song.source(clip.src)?.by || clip.by) } }), `${owner?.name || "누군가"}의 녹음 · 기본은 ${owner?.name || "그 사람"}의 색`),
        ...PALETTE.map((_, i) => h("button", { type: "button", class: "menu-dot", data: { tint: String(i) }, "aria-label": dotLabel(i), title: dotLabel(i), "aria-pressed": String(now === i),
          text: dotLetter(i), style: { background: memberColor(i, currentTheme()) }, onclick: (e) => { e.stopPropagation(); menuView = "main"; apply(setClipOps(session.clock, song, clip.id, { tint: i })); draw(); } })),
        item("clip-tint-none", "기본", () => { menuView = "main"; apply(setClipOps(session.clock, song, clip.id, { tint: null })); draw(); }, now !== null),
        item("clip-tint-back", "←", () => { menuView = "main"; placeMenu(); }),
      ].filter(Boolean));
    } else menu.replaceChildren(...[
      // What it is: its name, what it came from, who put it in.
      h("p", { class: "menu-info", id: "clip-info", text: [named.title, named.long, named.who && named.who + "이(가) 넣음"].filter(Boolean).join(" · ") }),
      item("clip-play", soloClip === clip.id ? "■ 멈춤" : "▶ 듣기", () => playClipAlone(clip.id), !rec),
      item("clip-split", "분할", () => splitClip(clip.id), !locked && insideClip(clip.id)),
      item("clip-copy", "복사", () => copyClip(clip.id)),
      item("clip-paste", "붙여넣기", () => (clipboardItem(app.store, "song-clips") ? pasteGroup() : pasteClip()), !!(clipboardItem(app.store, "song-clip") || clipboardItem(app.store, "song-clips")) && !readOnly()),
      item("clip-mute", clip.muted ? "소리 켜기" : "음소거", () => toggleMute(clip.id), !readOnly()),
      // Its own 빠르기 (1×, 1.5×, 2×, 3×, 0.5×), on top of the whole song's.
      item("clip-speed", `빠르기 ${clip.speed || 1}×`, () => { apply(setClipOps(session.clock, song, clip.id, { speed: CLIP_SPEEDS[(CLIP_SPEEDS.indexOf(clip.speed || 1) + 1) % CLIP_SPEEDS.length] })); draw(); }, !locked && !readOnly()),
      !locked && h("button", { type: "button", id: "clip-tint", onclick: (e) => { e.stopPropagation(); menuView = "tints"; placeMenu(); } },
        h("span", { class: "menu-swatch", style: { background: clipColor(clip) } }), "색"),
      item("clip-join", "잇기", () => joinClip(clip.id), !locked && !!next && !next.locked && !busy),
      item("clip-notes", "음 편집", () => editNotes(clip.id)),
      item("clip-send", "보내기", () => sendClip(clip.id)),
      item("clip-lock", clip.locked ? "잠금 풀기" : "잠금", () => toggleLock(clip.id), !readOnly()),
      item("clip-delete", "삭제", () => deleteClip(clip.id), !locked),
    ].filter(Boolean));
    if (docked) return;
    const w = menu.offsetWidth;
    const hgt = menu.offsetHeight;
    let left = box.left - area.left + box.width / 2 - w / 2;
    left = Math.max(6, Math.min(area.width - w - 6, left));
    let top = box.top - area.top - hgt - 6;
    if (top < 4) top = box.bottom - area.top + 6;
    menu.style.left = left + "px";
    menu.style.top = Math.max(4, Math.min(top, area.height - hgt - 4)) + "px";
  }

  /** The side panel with nothing chosen: what the song is, and how to see a clip here. */
  function drawSide() {
    if (!wideSide.matches) return;
    let rest = side.querySelector("#side-summary");
    if (menu) return void rest?.remove();
    if (!rest) {
      rest = h("div", { class: "side-summary", id: "side-summary" });
      side.prepend(rest);
    }
    const clips = song.layout();
    const people = [...new Set(clips.map((c) => c.by))].map((by) => session.room.member(by)?.name).filter(Boolean);
    const key = [clips.length, song.rowCount(), Math.round(song.end() / 100), people.join()].join("|");
    if (rest.dataset.key === key) return;
    rest.dataset.key = key;
    rest.replaceChildren(
      h("p", { class: "side-title", text: "이 노래" }),
      h("p", { class: "side-facts", text: clips.length ? `클립 ${clips.length}개 · 줄 ${Math.max(1, song.rowCount() - 1)}개 · ${timeText(song.end())}` : "아직 클립이 없어요" }),
      people.length > 0 && h("p", { class: "side-facts", text: people.join(", ") + "이(가) 불렀어요" }),
      h("p", { class: "help", text: "클립을 누르면 그 클립의 이름과 할 일이 여기에 나와요." }));
  }

  /** 보내기: puts the clip on a whiteboard as a song card, straight into that room. */
  function sendClip(id) {
    const clip = song.clip(id);
    const src = clip && song.source(clip.src);
    if (!src) return;
    // My whiteboards: the ones this device remembers, and the ones made on my other devices
    // (home lists those too; they were missing here, so 보내기 said there were none).
    openSheet(root, "화이트보드로 보내기", (panel, close) => {
      const wait = h("p", { class: "help", id: "boards-wait", text: "화이트보드를 찾는 중…" });
      panel.append(wait);
      reachableRooms(app, ["creative-board"]).then(({ mine, others }) => {
        wait.remove();
        if (!mine.length && !others.length) return void panel.append(h("p", { class: "help", id: "no-boards", text: "화이트보드 방이 아직 없어요. 홈의 창작 +에서 만들 수 있어요." }));
        const pick = (r) => h("button", { class: "kind", type: "button", data: { room: r.id }, onclick: () => { close(); deliver(r, clip, src); } }, h("span", { class: "kind-name", text: r.name || "화이트보드" }));
        panel.append(h("div", { class: "kinds", id: "send-boards" }, mine.map(pick)));
        if (others.length) panel.append(h("p", { class: "group-label", text: "다른 기기에서 만든 방" }), h("div", { class: "kinds", id: "send-boards-others" }, others.map(pick)));
      });
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
      const source = { duration: src.dur / 1000, notes: song.notesOf(src.id).map(noteInSeconds), peaks: src.peaks, blob: src.blob, name: src.name };
      const data = cardFromClip({ source, offset: clip.offset, length: clip.length });
      // In a whiteboard this device has not opened yet, I come in as myself (my name, colour and code).
      const by = roomEntry(app.store, room.id)?.memberId || meIn(app, other, room, session.me);
      const made = addItemOps(other.clock, target, { kind: "song", x: right ? right.x + right.w + 60 : 40, y: right ? right.y : 40, data, by });
      other.commit("board", made.ops);
      const keep = keptFields("song", { speed: clip.speed, tint: clip.tint }, data);
      if (Object.keys(keep).length) other.commit("board", setItemOps(other.clock, target, made.id, keep).ops);
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
      song, clipId: id, clock: session.clock, color: clipColor(clip),
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
    if (e.target.closest?.("input, textarea, [contenteditable]") || root.querySelector(".scrim:not(.closing)")) return;
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
    /** 레퍼런스 → 이 방에 붙이기: a recording becomes a clip at the playhead (its sound is already on this device). */
    insertSound(memo) {
      if (readOnly() || !song.canAddClip()) return void toast(root, "여기에는 붙일 수 없어요");
      const length = Math.max(1, Math.round(memo.dur * 1000));
      const row = song.freeRow(playhead, length, selectedRow);
      if (row === null) return void toast(root, "이 자리에는 줄이 더 없어요");
      const by = session.memberId;
      const src = sourceOp(session.clock, song, { duration: memo.dur, notes: memo.notes, peaks: memo.peaks, by, at: Date.now(), blob: memo.blob, name: memo.name });
      localBlobs.set(memo.blob, true);
      const clip = addClipOps(session.clock, song, { src: src.id, row, start: playhead, length, by, at: Date.now() });
      session.commit("song", [src, ...clip.ops]);
      record(clip.atoms);
      selectedRow = row;
      select(clip.id);
    },
    close() {
      alive = false;
      wideSide.removeEventListener?.("change", onWide);
      menu?.stopGuard?.();
      stopFrames();
      clearTimeout(presenceTimer);
      clearInterval(friendTimer);
      if (rec) rec.recorder.stop();
      rec = null;
      player?.close();
      soloPlayer?.close();
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
