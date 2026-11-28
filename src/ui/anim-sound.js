// 소리 줄 (specs/2026-11-28-anim-sound-design.md): sounds laid under the flipbook's frames, as FlipaClip
// and Procreate Dreams lay sound under their timelines. A sound is a clip of the room's own song
// document (the 노래 방's: its notes, waveform and original voice travel the same ways), standing at a
// time in ms: when 1초에 몇 장 changes, the frames move against it and the sound stays where it was put.
// In: 소리 넣기 (here while the frames play, the phone's recorder app, a file: the 노래 방's ways),
// 비서's recordings and the 바구니's clips. A tap on a sound: 듣기 · 피아노/원본 · 지우기; held, it moves
// along the frames (to a frame's start).

import { h, icon, toast, openSheet } from "./dom.js";
import { wavePath, timeText } from "./song-view.js";
import { KEEP_RATE, soundPickers, waysIn, micRefused, pickerHelp } from "./sound-in.js";
import { audioContext, SongPlayer } from "../audio/engine.js";
import { encodeWav } from "../audio/wav.js";
import { resample, louder } from "../audio/dsp.js";
import { bufferFromSamples, decodeAudioFile } from "../audio/decode.js";
import { analyzeSamples } from "../audio/analyze.js";
import { MicRecorder, micSupport } from "../audio/recorder.js";
import { toBase64, fromBase64 } from "../audio/peaks.js";
import { newBlobId } from "../sync/blobs.js";
import { keepTake, takeWhere } from "./keep-take.js";
import { shareTake, takeSound } from "./share-take.js";
import { SongDoc, sourceOp, addClipOps, setClipOps, removeClipOps, packMs, MAX_TAKE_MS, clipSpan } from "../core/song.js";
import { msAtTick, passMs } from "../core/anim.js";
import { clipboardItem } from "../clipboard.js";
import { getSettings, setSetting } from "../identity.js";

const SVG = "http://www.w3.org/2000/svg";
const ROWS_SHOWN = 3;

/**
 * The 소리 줄 of an 애니메이션 방. kit: { app, session, root, anim (AnimDoc), strip (the frames' strip),
 * cellOf(frameId) → the frame's cell, tickNow() → the first tick of the frame being drawn, colorOf(member),
 * readOnly(), alive(), openMenu(anchor, menu) → close, record(atoms) (undo), onPlayWith(fromMs) → starts
 * the frames from that time while it records }.
 */
export function animSound(kit) {
  const { app, session, root, anim, strip, cellOf, tickNow, colorOf, readOnly, alive, openMenu, record } = kit;
  const song = () => session.doc("song");
  const lane = h("div", { class: "anim-sound", id: "anim-sound", "aria-label": "소리 줄" });
  const addButton = h("button", { class: "anim-add anim-sound-add", id: "anim-sound-add", type: "button", "aria-label": "소리 넣기 (녹음·녹음 앱·파일)", onclick: () => openAdd() }, icon("note"));
  const mic = micSupport();
  let busy = null;
  let player = null;
  let lifted = null;

  // ---- where a time lies along the strip --------------------------------------------------------

  /** The x (in the strip's scrolled content) where a time in ms lies: over the frame showing then. */
  function xAt(ms) {
    const fps = anim.settings().fps;
    const tick = (Math.max(0, ms) * fps) / 1000;
    let t0 = 0;
    let last = null;
    for (const f of anim.frames()) {
      const cell = cellOf(f.id);
      if (!cell) continue;
      if (tick < t0 + f.hold) return cell.offsetLeft + ((tick - t0) / f.hold) * cell.offsetWidth;
      t0 += f.hold;
      last = { cell, hold: f.hold };
    }
    if (!last) return 0;
    // Past the last frame: on at its pace (the part no frame shows is drawn faint).
    const per = last.cell.offsetWidth / last.hold;
    return last.cell.offsetLeft + last.cell.offsetWidth + (tick - t0) * per;
  }

  /** The time at an x along the strip, at a frame's start (where a sound held and moved is let go). */
  function msAtX(x) {
    const fps = anim.settings().fps;
    let t0 = 0;
    let last = null;
    for (const f of anim.frames()) {
      const cell = cellOf(f.id);
      if (!cell) continue;
      const left = cell.offsetLeft;
      if (x < left + cell.offsetWidth) {
        const into = Math.max(0, Math.min(f.hold, Math.round(((x - left) / cell.offsetWidth) * f.hold)));
        return msAtTick(t0 + into, fps);
      }
      t0 += f.hold;
      last = { cell, hold: f.hold };
    }
    if (!last) return 0;
    const per = last.cell.offsetWidth / last.hold;
    return msAtTick(t0 + Math.max(0, Math.round((x - last.cell.offsetLeft - last.cell.offsetWidth) / per)), fps);
  }

  // ---- the lane ----------------------------------------------------------------------------------

  const shapes = new Map(); // clip id → its element
  function draw() {
    const clips = song().clips().filter((c) => !c.removed);
    const rows = Math.min(ROWS_SHOWN, clips.reduce((n, c) => Math.max(n, c.lane + 1), 0));
    strip.classList.toggle("with-sound", rows > 0);
    strip.style.setProperty("--sound-rows", String(Math.max(1, rows)));
    if (!lane.isConnected) strip.append(lane);
    // + 소리 at the strip's end, after the frames' own + and 복제 (moved, not made again).
    if (readOnly()) addButton.remove();
    else if (strip.lastElementChild !== addButton) strip.append(addButton);
    const end = passMs(anim);
    // The strip is the frames': a sound longer than them stops at their end with a short faint tail (it
    // goes on), and one that starts after them is a small faint chip there (found, moved back, or let go).
    const endX = xAt(end);
    const TAIL = 22;
    const keep = new Set();
    for (const c of clips) {
      if (c.lane >= ROWS_SHOWN) continue;
      keep.add(c.id);
      let el = shapes.get(c.id);
      if (!el) {
        el = h("button", { class: "anim-clip", type: "button", data: { clip: c.id } });
        wireClip(el, c.id);
        shapes.set(c.id, el);
        lane.append(el);
      }
      const src = song().source(c.src);
      const span = clipSpan(c);
      const after = c.start >= end;
      const x0 = after ? endX + 4 : xAt(c.start);
      const full = xAt(c.start + span);
      const x1 = after ? x0 + TAIL : Math.min(full, endX + TAIL);
      el.classList.toggle("longer", !after && full > x1 + 1);
      el.classList.toggle("after", after);
      el.style.left = x0 + "px";
      el.style.width = Math.max(6, x1 - x0) + "px";
      el.style.setProperty("--row", String(c.lane));
      el.style.setProperty("--c", colorOf(c.by));
      // What no frame shows (the sound runs on past the last frame) is faint.
      const shown = after ? 0 : Math.max(0, Math.min(1, (endX - x0) / Math.max(1, x1 - x0)));
      el.style.setProperty("--shown", (shown * 100).toFixed(1) + "%");
      el.setAttribute("aria-label", `소리: ${src?.name || "녹음"} ${timeText(span)}`);
      // The waveform of the part shown (to the frames' end and its tail), drawn at that width.
      const seen = after ? 0 : Math.max(1, Math.min(c.length, Math.round(((x1 - x0) / Math.max(1, full - x0)) * c.length)));
      const key = [c.src, c.offset, seen, Math.round(x1 - x0)].join("|");
      if (el.dataset.key !== key) {
        el.dataset.key = key;
        el.replaceChildren(wave(src, { offset: c.offset, length: seen }));
      }
    }
    for (const [id, el] of shapes) if (!keep.has(id)) { el.remove(); shapes.delete(id); }
    // The lane is as wide as the strip's content, so it scrolls with the frames.
    lane.style.width = strip.scrollWidth + "px";
  }

  function wave(src, clip) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "anim-wave");
    svg.setAttribute("preserveAspectRatio", "none");
    if (!src) return svg;
    if (!src.peakBytes) src.peakBytes = fromBase64(src.peaks || "");
    const path = wavePath(src.peakBytes, clip.offset, clip.offset + clip.length);
    if (!path) return svg;
    svg.setAttribute("viewBox", `0 -1 ${Math.max(1, path.n - 1)} 2`);
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", path.d);
    svg.append(p);
    return svg;
  }

  // ---- a sound tapped or held ---------------------------------------------------------------------

  function wireClip(el, id) {
    let press = null;
    el.addEventListener("pointerdown", (e) => {
      if (readOnly() || (e.pointerType === "mouse" && e.button !== 0)) return;
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, timer: setTimeout(() => lift(e), 420) };
    });
    const lift = (e) => {
      if (!press) return;
      const c = song().clip(id);
      if (!c || c.removed) return;
      lifted = { id, el, from: c.start, dx: 0, x0: press.x };
      el.classList.add("lifting");
      try { el.setPointerCapture(press.id); } catch { /* fine */ }
      try { navigator.vibrate?.(10); } catch { /* not every device buzzes */ }
    };
    el.addEventListener("pointermove", (e) => {
      if (!press || e.pointerId !== press.id) return;
      if (!lifted) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) {
          clearTimeout(press.timer);
          press = null; // a swipe: the strip scrolls
        }
        return;
      }
      lifted.dx = e.clientX - lifted.x0;
      el.style.translate = lifted.dx + "px 0";
    });
    const end = (e) => {
      if (!press || e.pointerId !== press.id) return;
      clearTimeout(press.timer);
      press = null;
      if (!lifted) return;
      const { dx, from } = lifted;
      lifted = null;
      el.classList.remove("lifting");
      el.style.translate = "";
      // The click a lift may still make is not a tap (only for a moment: a drag makes none).
      el.dataset.held = String(Date.now());
      if (e.type !== "pointerup") return;
      // Held still and let go: its menu, as a frame's (held and moved: it goes there).
      if (Math.abs(dx) < 4) return void clipMenu(el, id);
      const to = msAtX(xAt(from) + dx);
      if (to !== from) change(setClipOps(session.clock, song(), id, { start: to }));
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (Date.now() - Number(el.dataset.held || 0) < 250) return;
      clipMenu(el, id);
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    // Held, the finger moves the sound, not the strip.
    el.addEventListener("touchmove", (e) => { if (lifted && e.cancelable) e.preventDefault(); }, { passive: false });
  }

  function change(made) {
    if (!made?.ops?.length || readOnly()) return false;
    session.commit("song", made.ops);
    record(made.atoms.map((atom) => ({ ...atom, doc: "song" })));
    draw();
    return true;
  }

  const piano = () => getSettings(app.store).animSound === "piano";

  function clipMenu(el, id) {
    const c = song().clip(id);
    if (!c || c.removed) return;
    const src = song().source(c.src);
    const menu = h("div", { class: "anim-menu", id: "anim-sound-menu", role: "menu" },
      h("div", { class: "anim-menu-row" },
        h("span", { class: "anim-menu-label", text: src?.name || "녹음" }),
        h("button", { class: "chip", type: "button", id: "anim-sound-hear", text: "▶ 듣기", onclick: () => { close(); hearOne(id); } }),
        h("button", { class: "chip", type: "button", id: "anim-sound-mode", "aria-pressed": String(piano()), text: "피아노로", title: "부른 음을 피아노로", onclick: () => { setSetting(app.store, "animSound", piano() ? "original" : "piano"); close(); } }),
        !readOnly() && h("button", { class: "chip danger", type: "button", id: "anim-sound-remove", text: "지우기", onclick: () => { close(); if (change(removeClipOps(session.clock, song(), id))) toast(root, "소리를 지웠어요 (되돌리기로 살려요)"); } })));
    const close = openMenu(el, menu);
  }

  // ---- playing -------------------------------------------------------------------------------------

  const sounds = new Map(); // blob key → AudioBuffer
  const reading = new Map();
  let roomFiles = null;
  session.load("files").then((files) => { roomFiles = files; shareMine(); }, () => {});

  function soundOf(key, ctx) {
    if (sounds.has(key)) return Promise.resolve(sounds.get(key));
    if (!reading.has(key)) {
      reading.set(key, takeSound(app, roomFiles, key).then((sound) => {
        const buf = sound ? bufferFromSamples(ctx, sound.samples, sound.rate) : null;
        if (buf) sounds.set(key, buf);
        reading.delete(key);
        return buf;
      }, () => { reading.delete(key); return null; }));
    }
    return reading.get(key);
  }

  /** The originals for the sounds, as far as they are ready in a moment (the rest play as piano this time). */
  async function originals(ctx, waitMs = 350) {
    const audio = new Map();
    if (piano()) return audio;
    const waits = [];
    for (const c of song().clips()) {
      const key = song().source(c.src)?.blob;
      if (!key) continue;
      waits.push(soundOf(key, ctx).then((buf) => { if (buf) audio.set(c.src, buf); }));
    }
    await Promise.race([Promise.all(waits), new Promise((resolve) => setTimeout(resolve, waitMs))]);
    return audio;
  }

  async function makePlayer(heard = song) {
    const ctx = await audioContext();
    if (!ctx) return null;
    const audio = await originals(ctx);
    player?.close();
    player = new SongPlayer(ctx, { song: heard, audioFor: (id) => audio.get(id) || null, onEnd: () => {} });
    player.setMode(piano() ? "piano" : "original");
    return player;
  }

  /** Plays the sounds from a time in ms (▶ of the frames calls it, and again from 0 as they go round). */
  let asking = 0;
  async function play(fromMs) {
    if (!has()) return null;
    const mine = ++asking;
    const p = await makePlayer();
    if (mine !== asking || !alive()) return null; // stopped (or played again) while it got ready
    p?.play(fromMs);
    glow(null);
    return p;
  }

  function stop() {
    asking++;
    player?.stop();
  }

  // What sounds now lights (as a 노래 방 clip does while it plays).
  let glowing = 0;
  function glow(only) {
    cancelAnimationFrame(glowing);
    const tick = () => {
      const on = !!player?.playing && alive();
      const at = on ? player.position : -1;
      for (const [id, el] of shapes) {
        const c = song().clip(id);
        const lit = on && !!c && (only ? id === only : at >= c.start && at < c.start + clipSpan(c));
        el.classList.toggle("playing", lit);
      }
      if (on) glowing = requestAnimationFrame(tick);
    };
    glowing = requestAnimationFrame(tick);
  }

  /** ▶ 듣기 on one sound: it alone, from its start (as 노래 방 plays a clip alone). */
  async function hearOne(id) {
    const doc = song();
    const c = doc.clip(id);
    const src = c && doc.source(c.src);
    if (!src) return;
    const one = new SongDoc();
    one.apply({ t: "src", id: src.id, dur: src.dur, notes: doc.notesOf(src.id).map(packMs), peaks: src.peaks || "", by: src.by, at: 0, ...(src.blob ? { blob: src.blob } : {}) });
    one.apply({ t: "clip", id: c.id, src: src.id, row: 0, start: 0, offset: c.offset, length: c.length, by: c.by, at: 0 });
    if ((c.speed || 1) !== 1) one.apply({ t: "cset", id: "2@solo", c: c.id, f: { speed: c.speed } });
    const mine = ++asking;
    const p = await makePlayer(() => one);
    if (mine !== asking || !alive()) return;
    p?.play(0);
    glow(id);
  }

  const has = () => song().clips().some((c) => !c.removed && !c.muted);

  // ---- in ---------------------------------------------------------------------------------------

  // A file picked (or a take from the phone's recorder app) puts the 소리 넣기 window away and comes in.
  let closeAdd = null;
  const pickers = soundPickers("anim-sound", { onFile: (file) => { closeAdd?.(); closeAdd = null; importFile(file); }, onSilent: () => pickerHelp({ app, roomId: session.roomId, root, mic }) });
  root.append(...pickers.inputs);

  function openAdd() {
    if (readOnly() || busy) return;
    closeAdd = openSheet(root, "소리 넣기", (panel, closeSheet, onClose) => {
      panel.append(h("div", { class: "form", id: "anim-sound-ways" },
        ...waysIn({ app, roomId: session.roomId, root, name: "anim-sound", prefix: "anim-sound-", mic, canRecord: !readOnly(), onRecord: () => { closeSheet(); recordAlong(); } })));
      onClose(() => { closeAdd = null; });
    });
  }

  /** The time the sound goes to: the start of the frame being drawn. */
  const hereMs = () => msAtTick(Math.max(0, tickNow()), anim.settings().fps);

  async function importFile(file) {
    if (busy || readOnly()) return;
    busy = "import";
    toast(root, "소리를 읽는 중…", 8000);
    try {
      const ctx = await audioContext({ wake: false });
      if (!ctx) throw new Error("no audio");
      let { samples, rate } = await decodeAudioFile(ctx, file);
      if (samples.length > (rate * MAX_TAKE_MS) / 1000) samples = samples.subarray(0, Math.round((rate * MAX_TAKE_MS) / 1000));
      await place(samples, rate, file.name, hereMs());
      // The reading notice gives way at once (it lay over the strip for its whole time).
      toast(root, "소리 줄에 넣었어요", 1600);
    } catch (err) {
      console.warn(err);
      toast(root, "이 파일은 읽을 수 없어요", 3600);
    } finally {
      busy = null;
    }
  }

  /** 여기서 녹음: the frames play from the one being drawn while I speak or sing; the take starts there. */
  async function recordAlong() {
    if (busy || readOnly() || !mic.ok) return;
    const ctx = await audioContext();
    if (!ctx) return;
    const recorder = new MicRecorder(ctx);
    try {
      await recorder.start();
    } catch (err) {
      return void micRefused({ app, root, err, retry: () => recordAlong() });
    }
    busy = "record";
    const start = hereMs();
    kit.onPlayWith?.(start);
    let timer = 0;
    openSheet(root, "녹음 중", (panel, closeSheet, onClose) => {
      const time = h("p", { class: "rec-time", id: "anim-rec-time", text: "0:00.0" });
      panel.append(h("div", { class: "form" }, time,
        h("button", { class: "btn", id: "anim-rec-stop", type: "button", text: "멈추고 소리 줄에 놓기", onclick: () => closeSheet() })));
      timer = setInterval(() => {
        time.textContent = timeText(recorder.seconds * 1000);
        if (recorder.seconds * 1000 >= MAX_TAKE_MS) closeSheet();
      }, 200);
      onClose(async () => {
        clearInterval(timer);
        kit.onStopWith?.();
        const take = await recorder.stop();
        busy = null;
        if (take.samples.length < take.rate * 0.25) return void toast(root, "녹음이 너무 짧아요");
        busy = "import";
        // The take is late by the way in (as in 노래 방's overdub); it goes back by as much.
        const shift = recorder.latency() * 1000 + Number(getSettings(app.store).syncMs || 0);
        try {
          await place(take.samples, take.rate, null, Math.max(0, Math.round(start - shift)));
        } finally {
          busy = null;
        }
      });
    });
  }

  /** Notes and waveform from the sound, the original kept here and sent to friends, a clip at `at`. */
  async function place(samples, rate, name, at) {
    samples = louder(samples).samples;
    const result = await analyzeSamples(samples, rate);
    const kept = rate === KEEP_RATE ? samples : resample(samples, rate, KEEP_RATE);
    const blob = newBlobId();
    await app.blobs.put(blob, encodeWav(kept, KEEP_RATE), "audio/wav");
    if (!alive()) return;
    put({ duration: result.duration, notes: result.notes, peaks: toBase64(result.peaks), blob, name: name || undefined, scale: result.scale }, at);
    keepTake(app, { name, result, blob, where: takeWhere(app, session.roomId) });
  }

  /** A sound (its notes, waveform and kept original) as a clip at `at`, on the first row free there. */
  function put(source, at = hereMs(), { offset = 0, length = null, speed = 1 } = {}) {
    const doc = song();
    if (!doc.canAddClip()) return void toast(root, "소리는 방 하나에 200개까지예요");
    const len = Math.max(1, Math.round(length ?? source.duration * 1000));
    const row = doc.freeRow(at, Math.round(len / (speed || 1)), 0);
    if (row === null) return void toast(root, "이 자리에는 소리 줄이 더 없어요");
    const by = session.memberId;
    const src = sourceOp(session.clock, doc, { ...source, by, at: Date.now() });
    const clip = addClipOps(session.clock, doc, { src: src.id, row, start: at, offset, length: len, by, at: Date.now() });
    session.commit("song", [src, ...clip.ops]);
    if (speed !== 1) session.commit("song", setClipOps(session.clock, doc, clip.id, { speed }).ops);
    record(clip.atoms.map((atom) => ({ ...atom, doc: "song" })));
    if (source.blob) shareTake(app, session, source.blob);
    draw();
    return clip.id;
  }

  /** Each sound's original goes to the room once (whichever device has it sends it). */
  const asked = new Set();
  function shareMine() {
    for (const c of song().clips()) {
      const blob = song().source(c.src)?.blob;
      if (!blob || asked.has(blob)) continue;
      asked.add(blob);
      app.blobs.get(blob).then((kept) => { if (kept && alive()) shareTake(app, session, blob); }, () => {});
    }
  }

  return {
    draw,
    play,
    stop,
    has,
    shareMine,
    /** The sounds playing out also go to `node` (a recording of the video takes them). */
    async playInto(fromMs, node) {
      const p = await play(fromMs);
      if (p && node) p.out.connect(node);
      return p;
    },
    /** 비서's 녹음 → 여기에 놓기: at the frame being drawn. */
    insertSound(memo) {
      if (readOnly()) return void toast(root, "여기에는 붙일 수 없어요");
      put({ duration: memo.dur, notes: memo.notes, peaks: memo.peaks, blob: memo.blob, name: memo.name, scale: memo.scale });
    },
    takes(item) {
      return !readOnly() && item.kind === "song-clip" && !!item.source;
    },
    put(item) {
      const clip = item.kind === "song-clip" ? clipboardItem(app.store, "song-clip") || item : item;
      put({ ...clip.source }, hereMs(), { offset: clip.offset || 0, length: clip.length, speed: clip.speed || 1 });
    },
    close() {
      asking++;
      cancelAnimationFrame(glowing);
      player?.close();
      player = null;
      pickers.stop?.();
      for (const el of pickers.inputs) el.remove();
      lane.remove();
      addButton.remove();
    },
  };
}
