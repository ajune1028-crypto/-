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

export function addRefSound(store, { name, dur, notes, peaks, blob, from = null }, now = Date.now()) {
  const sound = { id: "s" + now.toString(36) + Math.random().toString(36).slice(2, 6), name: name ? String(name).slice(0, 60) : "녹음", dur, notes, peaks: peaks || "", blob, at: now };
  // Made in a room (every take is kept here too): which one.
  if (from && typeof from.room === "string") sound.from = { room: from.room.slice(0, 40), name: String(from.name || "").slice(0, 30), kind: String(from.kind || "").slice(0, 30) };
  store.set(SOUNDS, [sound, ...refSounds(store)].slice(0, MAX_SOUNDS));
  return sound;
}

export function removeRefSound(store, id) {
  store.set(SOUNDS, refSounds(store).filter((s) => s.id !== id));
}
