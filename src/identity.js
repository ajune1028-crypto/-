// What this device remembers: which rooms it has entered and as whom, the last
// name and personal code typed, and display settings. Works from memory when
// the browser refuses storage.

export const DEFAULT_SETTINGS = {
  theme: "system", colors: true, mixing: true,
  // Song room: what to hear and see, the piano's tone, a faint waveform behind the notes, and the overdub delay fix in ms.
  songMode: "piano", pianoTone: "bright", showWave: true, syncMs: 0,
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
export function rememberRoom(store, { id, kind, name, memberId, local }, now = Date.now()) {
  const rooms = store.get("rooms", []);
  const entry = { id, kind, name, memberId, at: now };
  const i = rooms.findIndex((r) => r.id === id);
  if (local || (i >= 0 && rooms[i].local)) entry.local = true;
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
