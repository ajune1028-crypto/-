// What this device copied, kept across rooms: copy a clip in one song room and paste it into another.
// Every copy also piles up in 비서's 바구니 (the day's plan 6, after Excalidraw's library and the
// clipboard history of Samsung's keyboard and Windows): newest first, the same thing once, so any of
// them can be put into another room later (여기에 놓기). A room's 붙여넣기 takes the newest thing of
// the kinds it can take.
//
// Item kinds:
//   "song-clip"   { room, src (id in that room), source: { duration, notes (seconds), peaks, blob,
//                 name }, offset, length (ms), speed, tint }
//   "song-clips"  { room, clips: [{ dx, dy, offset, length, speed, tint, muted, src, source }] }
//   "board-items" { items: [{ kind, dx, dy, data, … }], strokes: [{ pts, c, w, … }] }
//   "text"        { text }
//   "ink"         { strokes: [{ pts (screen px as seen, from their corner), c, w, z, b, s, q, o }] }

const BASKET = "basket";
const LEGACY = "clipboard";
export const BASKET_MAX = 40;
// What the basket may hold on this device, all told (characters of JSON): a lasso of drawings can be
// large, and the device's storage is small.
const BASKET_CHARS = 600_000;

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The basket, newest first: [{ id, at, item, from: { room, name, kind } | null }]. */
export function basketItems(store) {
  let list = store.get(BASKET, null);
  if (!Array.isArray(list)) {
    // Before the basket: the one copied thing becomes its first entry.
    const old = store.get(LEGACY, null);
    list = old && typeof old.kind === "string" ? [{ id: "c" + (old.at || 0).toString(36), at: old.at || 0, item: strip(old), from: null }] : [];
  }
  return list.filter((e) => e && e.item && typeof e.item.kind === "string");
}

function strip(item) {
  const { at, ...rest } = item || {};
  return rest;
}

// Who wants to know when the basket changed (비서's 바구니 while it is open).
const watchers = new Set();
export function onBasketChange(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function save(store, list) {
  // Within its size: the oldest go first (the newest always stays).
  let kept = list.slice(0, BASKET_MAX);
  let size = kept.reduce((n, e) => n + JSON.stringify(e).length, 0);
  while (kept.length > 1 && size > BASKET_CHARS) size -= JSON.stringify(kept.pop()).length;
  for (;;) {
    try {
      store.set(BASKET, kept);
      for (const fn of watchers) fn();
      return;
    } catch {
      // The device's storage is full: keep less, at least the newest.
      if (kept.length <= 1) return;
      kept = kept.slice(0, Math.max(1, Math.floor(kept.length / 2)));
    }
  }
}

/**
 * A copy: the thing 붙여넣기 puts down next, and the newest in the basket. `from` says where it came
 * from ({ room, name, kind }).
 */
export function copyItem(store, item, from = null, now = Date.now()) {
  const plain = strip(item);
  const list = basketItems(store);
  const had = list.find((e) => same(e.item, plain));
  const entry = {
    id: had?.id || "c" + now.toString(36) + Math.random().toString(36).slice(2, 6),
    at: now,
    item: plain,
    from: from && typeof from.room === "string" ? { room: from.room.slice(0, 40), name: String(from.name || "").slice(0, 30), kind: String(from.kind || "").slice(0, 30) } : had?.from || null,
  };
  save(store, [entry, ...list.filter((e) => e !== had)]);
  return entry;
}

/** The newest copied thing of this kind (what a room's 붙여넣기 puts down), or null. */
export function clipboardItem(store, kind) {
  const entry = basketItems(store).find((e) => e.item.kind === kind);
  return entry ? { ...entry.item, at: entry.at } : null;
}

/** The newest of these kinds, or null: { kind, item }. */
export function newestOf(store, kinds) {
  const entry = basketItems(store).find((e) => kinds.includes(e.item.kind));
  return entry ? { ...entry.item, at: entry.at } : null;
}

/** 여기에 놓기 of a basket entry: it becomes the newest again (what 붙여넣기 puts down). */
export function takeFromBasket(store, id, now = Date.now()) {
  const list = basketItems(store);
  const entry = list.find((e) => e.id === id);
  if (!entry) return null;
  save(store, [{ ...entry, at: now }, ...list.filter((e) => e !== entry)]);
  return entry.item;
}

export function removeFromBasket(store, id) {
  save(store, basketItems(store).filter((e) => e.id !== id));
}

const seconds = (ms) => (ms / 1000).toFixed(1) + "초";

/** What a basket thing is, in a few words, with an icon's name. */
export function describeItem(item) {
  switch (item?.kind) {
    case "song-clip":
      return { icon: "note", text: `${item.source?.name || "녹음"} · ${seconds(item.length || 0)}` };
    case "song-clips": {
      const n = item.clips?.length || 0;
      const total = (item.clips || []).reduce((s, c) => s + (c.length || 0) / (c.speed || 1), 0);
      return { icon: "note", text: `노래 클립 ${n}개 · ${seconds(total)}` };
    }
    case "board-items": {
      const cards = item.items?.length || 0;
      const strokes = item.strokes?.length || 0;
      return { icon: "board", text: [cards && `카드 ${cards}개`, strokes && `그림 ${strokes}획`].filter(Boolean).join(" · ") || "빈 묶음" };
    }
    case "ink": {
      return { icon: "pen", text: `그림 ${item.strokes?.length || 0}획` };
    }
    case "text": {
      const flat = String(item.text || "").replace(/\s+/g, " ").trim();
      return { icon: "pen", text: flat.length > 40 ? flat.slice(0, 40) + "…" : flat };
    }
    default:
      return { icon: "copy", text: "복사한 것" };
  }
}
