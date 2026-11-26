// 레퍼런스: notes only this person sees. They live on this device and are
// never sent to a room. From any room they can be copied or put into it.
// A first piece of the reference feature (roadmap 5): private rooms,
// recordings and syncing across one's own devices come later.

const KEY = "reference";
const MAX = 300;

export function refNotes(store) {
  return store.get(KEY, []);
}

export function addRefNote(store, text, now = Date.now()) {
  const note = { id: "n" + now.toString(36) + Math.random().toString(36).slice(2, 6), text: String(text).slice(0, 4000), at: now };
  store.set(KEY, [note, ...refNotes(store)].slice(0, MAX));
  return note;
}

export function removeRefNote(store, id) {
  store.set(KEY, refNotes(store).filter((n) => n.id !== id));
}

// Recordings in 레퍼런스: the sound itself stays in this device's file store
// (sync/blobs.js); here only what describes it: name, length, the notes found
// (seconds) and the waveform summary, so it can become a clip or a card.
const SOUNDS = "reference-sounds";
const MAX_SOUNDS = 100;

export function refSounds(store) {
  return store.get(SOUNDS, []);
}

export function addRefSound(store, { name, dur, notes, peaks, blob, from = null, scale = null }, now = Date.now()) {
  // The same recording again (kept when it was made, then put in from a room): one line, at the top.
  const had = blob ? refSounds(store).find((s) => s.blob === blob) : null;
  if (had) {
    store.set(SOUNDS, [had, ...refSounds(store).filter((s) => s.id !== had.id)]);
    return had;
  }
  const sound = { id: "s" + now.toString(36) + Math.random().toString(36).slice(2, 6), name: name ? String(name).slice(0, 60) : "녹음", dur, notes, peaks: peaks || "", blob, at: now };
  if (scale && Number.isInteger(scale.tonic)) sound.scale = { tonic: scale.tonic, minor: !!scale.minor };
  // Made in a room (every take is kept here too): which one.
  if (from && typeof from.room === "string") sound.from = { room: from.room.slice(0, 40), name: String(from.name || "").slice(0, 30), kind: String(from.kind || "").slice(0, 30) };
  store.set(SOUNDS, [sound, ...refSounds(store)].slice(0, MAX_SOUNDS));
  return sound;
}

export function removeRefSound(store, id) {
  store.set(SOUNDS, refSounds(store).filter((s) => s.id !== id));
}

// 노트 (검토 9절, the day's plan 6): one sheet instead of the message-like memos, written straight on.
// A line that begins with □ is a to-do, ☑ one done. Kept on this device like the rest of 비서.
const NOTE = "reference-note";
const NOTE_MOVED = "reference-note-moved";
const NOTE_MAX = 20000;
const TODO = "□ ";
const DONE = "☑ ";

export function refNote(store) {
  const text = store.get(NOTE, "");
  return typeof text === "string" ? text : "";
}

export function setRefNote(store, text) {
  store.set(NOTE, String(text ?? "").slice(0, NOTE_MAX));
}

/** Words put into the note from elsewhere (a room's line): a line of their own at its end. */
export function addToNote(store, text) {
  const now = refNote(store);
  const add = String(text ?? "").trim();
  if (!add) return;
  setRefNote(store, now ? now.replace(/\n*$/, "") + "\n" + add : add);
}

/** Once: the old memos become the note's first lines, oldest first (the memos themselves stay). */
export function noteFromMemos(store) {
  if (store.get(NOTE_MOVED, false)) return;
  const memos = refNotes(store).slice().reverse().map((n) => n.text).filter((t) => t && t.trim());
  if (memos.length) {
    const now = refNote(store);
    setRefNote(store, [memos.join("\n"), now].filter(Boolean).join("\n"));
  }
  store.set(NOTE_MOVED, true);
}

function lineAround(text, at) {
  const start = at > 0 ? text.lastIndexOf("\n", at - 1) + 1 : 0;
  const nl = text.indexOf("\n", start);
  return { start, end: nl < 0 ? text.length : nl };
}

/** □ 할 일: the caret's line becomes a to-do, or (a to-do or a done one) a plain line again. */
export function toggleTodo(text, caret) {
  const { start } = lineAround(text, caret);
  const head = text.slice(start, start + 2);
  if (head === TODO || head === DONE) return { text: text.slice(0, start) + text.slice(start + 2), caret: Math.max(start, caret - 2) };
  return { text: text.slice(0, start) + TODO + text.slice(start), caret: caret + 2 };
}

/** A tap on a line's □ ticks it (☑), on ☑ unticks it; anywhere else it is only a tap (null). */
export function flipTodoAt(text, at) {
  const { start } = lineAround(text, at);
  if (at - start > 1) return null;
  const mark = text[start];
  if (text[start + 1] !== " " || (mark !== "□" && mark !== "☑")) return null;
  return text.slice(0, start) + (mark === "□" ? "☑" : "□") + text.slice(start + 1);
}

/** The words of the caret's line without its to-do mark (what 여기에 놓기 puts down). */
export function lineAt(text, at) {
  const { start, end } = lineAround(text, at);
  return text.slice(start, end).replace(/^[□☑] /, "").trim();
}
