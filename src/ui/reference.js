// 레퍼런스: this person's own notes and recordings, on this device only.
// Opened from home and from every room's bar. Notes can be copied or put into
// a room; recordings (made in the app, in the phone's recorder app, or picked
// from files) can be heard, and put into a song room as a clip or onto a
// whiteboard as a song card. Nothing here is sent anywhere until it is put in.
// Removing a recording from the list keeps its sound on the device: a clip or
// card made from it may still play it.

import { h, openFloat, openSheet, segmented, toast } from "./dom.js";
import { exampleTake } from "../audio/example.js";
import { putSoundInto, reachableRooms } from "./room-actions.js";
import { getSettings, setSetting } from "../identity.js";
import { kindInfo } from "./kinds.js";
import { RoomSession } from "../sync/session.js";
import { timeText } from "./song-view.js";
import { KEEP_RATE, soundPickers, waysIn, pickerHelp, micRefused } from "./sound-in.js";
import { refNotes, addRefNote, removeRefNote, refSounds, addRefSound, removeRefSound } from "../reference.js";
import { clipboardItem } from "../clipboard.js";
import { MAX_TAKE_MS } from "../core/song.js";
import { audioContext } from "../audio/engine.js";
import { analyzeSamples } from "../audio/analyze.js";
import { decodeAudioFile } from "../audio/decode.js";
import { MicRecorder, micSupport, micProblem } from "../audio/recorder.js";
import { encodeWav } from "../audio/wav.js";
import { resample, louder } from "../audio/dsp.js";
import { toBase64 } from "../audio/peaks.js";
import { newBlobId } from "../sync/blobs.js";
import { solfege } from "../audio/notes.js";

/**
 * insert(text): the room takes a note; insertSound(sound): the room takes a recording
 * (a song room as a clip, a whiteboard as a card). Either may be missing.
 */
export function openReference(app, { insert = null, insertSound = null, roomId = null, tab = null } = {}) {
  // Its button opens it and, pressed again, closes it. Asked for a tab (home's 녹음), it opens there.
  const open = document.getElementById("reference");
  if (open && !tab) return void open.close?.();
  const mic = micSupport();
  // It floats over the room (top left at first, wherever it was moved since), so the room
  // stays in reach: look at one, work in the other.
  const pos = { get: () => getSettings(app.store).refPos || null, set: (p) => setSetting(app.store, "refPos", p) };
  openFloat(app.root, { id: "reference", title: "레퍼런스 (나만 보기)", pos }, (panel, close, onClose) => {
    const list = h("div", { class: "ref-list", id: "ref-list" });
    const sounds = h("div", { class: "ref-sounds", id: "ref-sounds" });
    const status = h("p", { class: "help", id: "ref-status", role: "status", hidden: true });
    const area = h("textarea", { class: "input note-area", id: "ref-text", rows: 3, placeholder: "가사, 코드, 아이디어… 이 기기의 나만 봐요" });
    let busy = false;
    let audio = null; // the recording being heard: { id, el, url }

    const say = (text) => {
      status.textContent = text || "";
      status.hidden = !text;
    };

    function drawNotes() {
      const notes = refNotes(app.store);
      const clip = clipboardItem(app.store, "song-clip");
      list.replaceChildren(
        clip && h("p", { class: "help ref-clip", id: "ref-clip", text: `복사해 둔 노래 클립: ${clip.source?.name || "녹음"} · ${(clip.length / 1000).toFixed(1)}초 (노래 방이나 화이트보드에 붙일 수 있어요)` }),
        ...(notes.length ? notes.map((n) => h("div", { class: "ref-note", data: { id: n.id } },
          h("p", { class: "ref-body", text: n.text }),
          h("div", { class: "ref-actions" },
            h("button", { class: "chip", type: "button", text: "복사", onclick: () => Promise.resolve().then(() => navigator.clipboard.writeText(n.text)).then(() => toast(app.root, "복사했어요"), () => toast(app.root, "길게 눌러 복사해 주세요")) }),
            insert && h("button", { class: "chip", type: "button", data: { put: n.id }, text: "이 방에 붙이기", onclick: () => { insert(n.text); toast(app.root, "붙였어요"); } }),
            h("button", { class: "chip danger", type: "button", text: "지우기", onclick: () => { removeRefNote(app.store, n.id); drawNotes(); } }))))
          : [h("p", { class: "help", text: "아직 메모가 없어요. 여기 적은 것은 이 기기의 나만 볼 수 있어요." })]));
    }

    /** A recording's notes as small bars by pitch, named when there is room. */
    function bars(s) {
      const ps = s.notes.map((n) => n.p);
      const lo = ps.length ? Math.min(...ps) : 60;
      const hi = ps.length ? Math.max(...ps) : 60;
      const span = Math.max(10, hi - lo + 2);
      return h("div", { class: "pick-notes" }, s.notes.map((n) => h("i", {
        class: "note",
        text: n.d / s.dur >= 0.09 ? solfege(Math.round(n.p)) : "",
        style: { left: (n.t / s.dur) * 100 + "%", width: `max(3px, ${(n.d / s.dur) * 100}%)`, top: `calc(${((hi + (span - (hi - lo)) / 2 - n.p) / span) * 100}% - 0.4rem)`, height: "0.8rem" },
      })));
    }

    function drawSounds() {
      const all = refSounds(app.store);
      sounds.replaceChildren(...(all.length ? all.map((s) => h("div", { class: "ref-sound", data: { id: s.id } },
        h("div", { class: "pick-head" }, h("span", { class: "pick-name", text: s.name }), h("span", { class: "pick-len", text: timeText(s.dur * 1000) })),
        // Made in a room: which one (every take is kept here too).
        s.from && h("p", { class: "ref-from", text: `${s.from.name ? "'" + s.from.name + "'" : "방"}에서` }),
        bars(s),
        h("div", { class: "ref-actions" },
          h("button", { class: "chip", type: "button", id: "ref-play-" + s.id, text: audio?.id === s.id ? "■ 멈춤" : "▶ 듣기", onclick: () => hear(s) }),
          insertSound && h("button", { class: "chip", type: "button", data: { putSound: s.id }, text: "이 방에 붙이기", onclick: () => { stopHearing(); insertSound(s); toast(app.root, "붙였어요"); } }),
          h("button", { class: "chip", type: "button", data: { sendSound: s.id }, text: "보내기", onclick: () => sendSound(s) }),
          h("button", { class: "chip danger", type: "button", text: "지우기", onclick: () => { if (audio?.id === s.id) stopHearing(); removeRefSound(app.store, s.id); drawSounds(); } }))))
        : [h("p", { class: "help", text: "녹음도 남길 수 있어요. 노래 방이나 화이트보드에 바로 붙일 수 있어요." }),
          h("button", { class: "chip", type: "button", id: "ref-example", text: "예시 녹음 넣어 보기", onclick: () => addExample() })]));
    }

    /**
     * An example take (a sung 도레미파솔미도 made here), so a recording can be tried where nothing
     * can be recorded (the Claude page). It goes in once by itself, the first time the list is empty.
     */
    async function addExample() {
      if (busy) return;
      busy = true;
      try {
        app.store.set("exampleTake", true);
        await keep(exampleTake(KEEP_RATE), KEEP_RATE, "예시 녹음 · 도레미파솔미도");
      } finally {
        busy = false;
      }
    }

    /** 보내기: a kept recording into one of my song rooms (a clip after what it holds) or whiteboards (a card). */
    function sendSound(s) {
      stopHearing();
      openSheet(app.root, "어느 방으로 보낼까요?", async (sheet, close) => {
        // My song rooms and whiteboards here, and the ones made on my other devices.
        const found = await reachableRooms(app, ["creative-song", "creative-board"]);
        const rooms = [...found.mine, ...found.others].filter((r) => r.id !== roomId);
        if (!rooms.length) return void sheet.append(h("p", { class: "help", id: "send-none", text: "노래 방이나 화이트보드가 아직 없어요. 홈의 창작 +에서 만들 수 있어요." }));
        sheet.append(h("div", { class: "kinds", id: "send-rooms" }, rooms.map((r) => h("button", { class: "kind", type: "button", data: { sendTo: r.id }, onclick: async () => {
          close();
          try {
            await putSoundInto(app, r, s);
            toast(app.root, `'${r.name}'에 보냈어요`);
          } catch (err) {
            console.warn(err);
            toast(app.root, "보내지 못했어요. 그 방을 한 번 열었다가 다시 해 주세요", 3600);
          }
        } }, h("span", { class: "kind-name", text: r.name }), h("span", { class: "kind-note", text: kindInfo(r.kind)?.name || "" })))));
      });
    }

    function stopHearing() {
      if (!audio) return;
      audio.el.pause();
      URL.revokeObjectURL(audio.url);
      audio = null;
      drawSounds();
    }

    async function hear(s) {
      const again = audio?.id === s.id;
      stopHearing();
      if (again) return;
      const kept = await app.blobs.get(s.blob);
      if (!kept) return void toast(app.root, "이 녹음의 소리를 찾지 못했어요");
      const url = URL.createObjectURL(new Blob([kept.data], { type: kept.type || "audio/wav" }));
      const el = new Audio(url);
      audio = { id: s.id, el, url };
      el.onended = () => stopHearing();
      el.play().catch(() => stopHearing());
      drawSounds();
    }

    /** Notes found, the sound kept on this device, a line in the list. */
    async function keep(samples, rate, name) {
      samples = louder(samples).samples;
      say("음을 찾는 중…");
      const result = await analyzeSamples(samples, rate, { onProgress: (p) => say(`음을 찾는 중… ${Math.round(p * 100)}%`) });
      const kept = rate === KEEP_RATE ? samples : resample(samples, rate, KEEP_RATE);
      const blob = newBlobId();
      await app.blobs.put(blob, encodeWav(kept, KEEP_RATE), "audio/wav");
      addRefSound(app.store, { name, dur: result.duration, notes: result.notes, peaks: toBase64(result.peaks), blob });
      say(null);
      drawSounds();
    }

    async function importFile(file) {
      if (busy) return;
      busy = true;
      say("소리를 읽는 중…");
      try {
        const ctx = await audioContext({ wake: false });
        if (!ctx) throw new Error("no audio");
        let { samples, rate } = await decodeAudioFile(ctx, file);
        if (samples.length > (rate * MAX_TAKE_MS) / 1000) samples = samples.subarray(0, Math.round((rate * MAX_TAKE_MS) / 1000));
        await keep(samples, rate, file.name);
      } catch (err) {
        console.warn(err);
        say(null);
        toast(app.root, "이 파일은 읽을 수 없어요", 3600);
      } finally {
        busy = false;
      }
    }

    let recording = null;
    async function record() {
      if (busy || !mic.ok) return;
      const ctx = await audioContext();
      if (!ctx) return;
      const recorder = new MicRecorder(ctx);
      try {
        await recorder.start();
      } catch (err) {
        return void micRefused({ app, root: app.root, err, retry: () => record() });
      }
      busy = true;
      const time = h("span", { class: "ref-rec-time", id: "ref-rec-time", text: "0:00.0" });
      const stop = h("button", { class: "btn", id: "ref-stop", type: "button", text: "멈추고 남기기", onclick: () => finish() });
      const row = h("div", { class: "ref-recording" }, h("span", { class: "dot-rec" }), time, stop);
      ways.before(row);
      const timer = setInterval(() => {
        time.textContent = timeText(recorder.seconds * 1000);
        if (recorder.seconds * 1000 >= MAX_TAKE_MS) finish();
      }, 200);
      recording = { recorder, timer, row };
      async function finish() {
        if (recording?.recorder !== recorder) return;
        clearInterval(timer);
        row.remove();
        recording = null;
        const take = await recorder.stop();
        try {
          if (take.samples.length < take.rate * 0.25) toast(app.root, "녹음이 너무 짧아요");
          else await keep(take.samples, take.rate, null);
        } finally {
          busy = false;
        }
      }
    }

    const { inputs, stop: stopPickers } = soundPickers("ref", {
      onFile: (file) => importFile(file),
      onSilent: () => pickerHelp({ app, roomId, root: app.root, mic }),
    });
    const ways = h("div", { class: "form ref-ways", id: "ref-ways" },
      ...waysIn({ app, roomId, root: app.root, name: "ref", prefix: "ref-", mic, canRecord: true, onRecord: () => record() }));
    const notesPart = h("div", { class: "form ref-part", id: "ref-notes" }, area,
      h("button", { class: "btn", id: "ref-add", type: "button", text: "메모 남기기", onclick: () => {
        if (!area.value.trim()) return;
        addRefNote(app.store, area.value.trim());
        area.value = "";
        drawNotes();
      } }), list);
    const soundsPart = h("div", { class: "ref-part", id: "ref-sounds-part" }, ...inputs, ways, status, sounds);
    const roomsPart = h("div", { class: "ref-part", id: "ref-rooms" });
    const parts = { notes: notesPart, sounds: soundsPart, rooms: roomsPart };
    const show = (which) => {
      for (const [k, el] of Object.entries(parts)) el.hidden = k !== which;
      if (which === "rooms" && !roomsPart.childElementCount) drawRooms();
      // The first time the recordings are looked at and there are none, the example goes in.
      if (which === "sounds" && !refSounds(app.store).length && !app.store.get("exampleTake", false)) addExample();
    };
    const tabs = segmented([["notes", "메모", "ref-tab-notes"], ["sounds", "녹음", "ref-tab-sounds"], ["rooms", "내 방", "ref-tab-rooms"]], tab || "notes", (v) => show(v), "refTab");
    tabs.classList.add("ref-tabs");
    panel.append(tabs, notesPart, soundsPart, roomsPart);
    show(tab || "notes");
    drawNotes();
    drawSounds();

    // 내 방: my other rooms, to look into and bring things from into this room.
    function drawRooms() {
      const rooms = app.store.get("rooms", []).filter((r) => r.id !== roomId).sort((a, b) => b.at - a.at);
      roomsPart.replaceChildren(...(rooms.length ? rooms.map((r) => {
        const items = h("div", { class: "ref-room-items" });
        const row = h("div", { class: "ref-room", data: { room: r.id } },
          h("div", { class: "pick-head" }, h("span", { class: "pick-name", text: r.name }), h("span", { class: "pick-len", text: kindInfo(r.kind)?.name || "" })),
          h("button", { class: "chip", type: "button", id: "ref-open-" + r.id, text: "보기", onclick: (e) => { e.currentTarget.remove(); lookInto(r, items); } }),
          items);
        return row;
      }) : [h("p", { class: "help", text: "다른 방이 아직 없어요." })]));
    }

    /** A room's words, clips and cards, each with 가져오기 where this room can take it. */
    async function lookInto(room, box) {
      box.replaceChildren(h("p", { class: "help", text: "불러오는 중…" }));
      let other = null;
      const found = [];
      try {
        other = new RoomSession({ transport: await app.transportFor(room.id), roomId: room.id, store: app.store });
        if ((await other.open()) !== "ok") throw new Error("not opened");
        if (room.kind === "creative-song") {
          const song = await other.load("song");
          song.layout().forEach((clip, i) => {
            const src = song.source(clip.src);
            if (!src) return;
            const notes = song.notesOf(src.id).filter((n) => n.t + n.d > clip.offset && n.t < clip.offset + clip.length)
              .map((n) => ({ t: Math.max(0, n.t - clip.offset) / 1000, d: n.d / 1000, p: n.p, v: n.v }));
            found.push({ sound: { name: src.name || "녹음 " + (i + 1), dur: clip.length / 1000, notes, peaks: src.peaks, blob: clip.offset === 0 && clip.length >= src.dur - 5 ? src.blob : undefined } });
          });
        } else if (room.kind === "creative-board") {
          const board = await other.load("board");
          for (const item of board.items()) {
            if (item.kind === "note" && (item.text || "").trim()) found.push({ text: item.text });
            else if (item.kind === "song") {
              const d = item.data;
              found.push({ sound: { name: d.name || "노래", dur: d.dur / 1000, notes: d.notes.map(([t, len, p, v]) => ({ t: t / 1000, d: len / 1000, p, v: v / 100 })), peaks: d.peaks, blob: d.blob } });
            }
          }
        } else {
          // A text room: the lines of its last days, newest first.
          const days = other.days().slice(-3).reverse();
          for (const day of days) {
            const sheet = await other.loadSheet(day);
            for (const line of sheet.text().split("\n").reverse()) if (line.trim()) found.push({ text: line.trim() });
          }
        }
      } catch (err) {
        console.warn(err);
        box.replaceChildren(h("p", { class: "help", text: "이 방을 열지 못했어요" }));
        return;
      } finally {
        other?.close();
      }
      const take = (f) => (f.text ? insert && (() => { insert(f.text); toast(app.root, "가져왔어요"); }) : insertSound && (() => { insertSound(f.sound); toast(app.root, "가져왔어요"); }));
      box.replaceChildren(...(found.length ? found.slice(0, 40).map((f, i) => {
        const act = take(f);
        return h("div", { class: "ref-item" },
          h("p", { text: f.text || `♪ ${f.sound.name} · ${timeText(f.sound.dur * 1000)}` }),
          act && h("button", { class: "chip", type: "button", data: { take: String(i) }, text: "가져오기", onclick: act }),
          f.text && h("button", { class: "chip", type: "button", text: "메모로", onclick: () => { addRefNote(app.store, f.text); drawNotes(); toast(app.root, "레퍼런스 메모에 넣었어요"); } }));
      }) : [h("p", { class: "help", text: "가져올 것이 아직 없어요" })]));
    }
    onClose(() => {
      stopPickers();
      stopHearing();
      if (recording) {
        clearInterval(recording.timer);
        recording.recorder.stop();
        recording = null;
      }
    });
  });
}
