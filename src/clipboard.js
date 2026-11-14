// What this device copied, kept across rooms: copy a clip in one song room and
// paste it into another. This is the first piece of moving work between
// rooms (일상 ↔ 창작 ↔ 레퍼런스, song → whiteboard); new kinds of items are
// new `kind` values here.
//
// Item kinds:
//   "song-clip"  { room, src (id in that room), source: { duration, notes
//                (seconds), peaks, blob, name }, offset, length } (ms)

export function copyItem(store, item) {
  store.set("clipboard", { ...item, at: Date.now() });
}

/** The copied item if it is of this kind, else null. */
export function clipboardItem(store, kind) {
  const item = store.get("clipboard", null);
  return item && item.kind === kind ? item : null;
}
