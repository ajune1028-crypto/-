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
