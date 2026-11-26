// What this device remembers: which rooms it has entered and as whom, the last
// name and personal code typed, and display settings. Works from memory when
// the browser refuses storage.

import { validPreview } from "./core/preview.js";
import { newMyCode, normalizeCode, validCode, formatCode } from "./core/me.js";

export const DEFAULT_SETTINGS = {
  theme: "system", colors: true, mixing: true,
  // Your own accent colour (null: the app's blue) and the size of written text.
  accent: null, textScale: 1,
  // Song room: what to hear and see, the piano's tone, a faint waveform behind the notes, and the overdub delay fix in ms.
  songMode: "piano", pianoTone: "bright", showWave: true, syncMs: 0, songSpeed: 1,
  // 박자: clicks while playing and recording, snapping to the grid, and the grid's note value (8 = eighths).
  metronome: false, snap: true, grid: 8,
  // Drawing: the brush, and whether the eraser rubs out an area or whole strokes.
  inkBrush: "pen", inkEraser: "area",
  // 레퍼런스 (private notes) everywhere; off hides every way to it.
  reference: true,
};

export function openStore(storage, prefix = "") {
  const memory = new Map();
  let backing = storage;
  let available = true;
  try {
    if (!backing) backing = globalThis.localStorage;
    backing.setItem(prefix + "probe", "1");
    backing.removeItem(prefix + "probe");
  } catch {
    available = false;
  }
  const copy = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  return {
    get available() {
      return available;
    },
    get(key, fallback) {
      if (available) {
        try {
          const raw = backing.getItem(prefix + key);
          return raw === null ? copy(fallback) : JSON.parse(raw);
        } catch {
          return copy(fallback);
        }
      }
      return memory.has(key) ? copy(memory.get(key)) : copy(fallback);
    },
    set(key, value) {
      memory.set(key, copy(value));
      if (!available) return;
      try {
        backing.setItem(prefix + key, JSON.stringify(value));
      } catch {
        available = false;
      }
    },
  };
}

export function getSettings(store) {
  return { ...DEFAULT_SETTINGS, ...store.get("settings", {}) };
}

export function setSetting(store, key, value) {
  store.set("settings", { ...getSettings(store), [key]: value });
}

/**
 * Adds the room to this device's list, or updates it in place.
 * `local` marks a room that lives on this device only; once set it stays.
 */
/**
 * Puts a room on this device's list. `people` are the colours of who is in it (home shows
 * them: the door says who is behind it); told without them, the entry keeps the ones it had.
 */
export function rememberRoom(store, { id, kind, name, memberId, local, people, preview }, now = Date.now()) {
  const rooms = store.get("rooms", []);
  const entry = { id, kind, name, memberId, at: now };
  const i = rooms.findIndex((r) => r.id === id);
  if (local || (i >= 0 && rooms[i].local)) entry.local = true;
  const known = Array.isArray(people) ? people : i >= 0 ? rooms[i].people : null;
  if (known?.length) entry.people = known.slice(0, 6);
  // What home shows of it (core/preview.js): given when the room is left; otherwise the last one stays.
  const seen = preview !== undefined ? preview : i >= 0 ? rooms[i].preview : null;
  if (validPreview(seen)) entry.preview = seen;
  if (i >= 0) rooms[i] = entry;
  else rooms.push(entry);
  store.set("rooms", rooms);
}

export function roomEntry(store, id) {
  return store.get("rooms", []).find((r) => r.id === id) || null;
}

export function forgetRoom(store, id) {
  store.set("rooms", store.get("rooms", []).filter((r) => r.id !== id));
}

// 나의 고유 코드 (core/me.js): made the first time it is asked for, kept on this device. `shown` is
// whether it has been handed over (the sheet on the first open); `was` keeps the codes it had before.

export function myCodeOf(store) {
  let me = store.get("me", null);
  if (!me || typeof me.code !== "string" || !validCode(me.code)) {
    me = { code: newMyCode(), at: Date.now(), shown: false };
    store.set("me", me);
  }
  return me;
}

export function markMyCodeShown(store) {
  const me = myCodeOf(store);
  if (!me.shown) store.set("me", { ...me, shown: true });
}

/** Another device's code becomes this device's; what this device keeps goes along into that universe. */
export function adoptMyCode(store, code) {
  const me = myCodeOf(store);
  const norm = normalizeCode(code);
  if (!validCode(norm) || normalizeCode(me.code) === norm) return false;
  store.set("me", { code: formatCode(norm), at: Date.now(), shown: true, was: [...(me.was || []), me.code].slice(-3) });
  // A new universe: this device meets it as for the first time.
  store.set("meLedger", null);
  store.set("mePushed", null);
  return true;
}
