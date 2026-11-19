// What this device keeps to find rooms again: 별표 (starred rooms stay at the top), 집 (houses
// that hold rooms, like folders), and the last few searches. Only on this device, like the
// room list itself: it is how I keep my rooms, not something shared in them.
//
// The owner (17 November): "별표 표시한 방은 맨 위에", "폴더 … 굿노트 파일 말고 집으로: 집 색깔
// 결정, 하나의 색깔로 된 집 … 거기다가 아이콘 … 아래에다가 그 이름", "검색했던 거 미리 볼 수도 있게,
// 5개까지만, 더 늘릴 수 있는 설정도".

/** A house's colours: [key, colour, name]. Deep, clear colours (a house is rich glass). */
export const HOUSE_COLORS = [
  ["pink", "#e0559a", "분홍"],
  ["red", "#e5484d", "빨강"],
  ["orange", "#f2802a", "주황"],
  ["yellow", "#e1a91a", "노랑"],
  ["green", "#2f9e5b", "초록"],
  ["sky", "#22a7c4", "하늘"],
  ["blue", "#2f7bf0", "파랑"],
  ["indigo", "#4b4fd8", "남색"],
  ["violet", "#9a4fd8", "보라"],
  ["brown", "#a06b45", "갈색"],
  ["black", "#2b2b30", "검정"],
];
/** The white icon on a house (icon names in ui/dom.js). */
export const HOUSE_ICONS = ["home", "heart", "star", "note", "book", "photo", "board", "lines", "sun", "moon", "leaf", "people"];

const STARS = "homeStars";
const HOUSES = "houses";
const SEARCHES = "recentSearches";
const MAX_KEPT_SEARCHES = 50;

export function starred(store) {
  return new Set(store.get(STARS, []));
}

/** Stars or unstars a room; true when it is starred now. */
export function toggleStar(store, roomId) {
  const set = starred(store);
  const on = !set.has(roomId);
  if (on) set.add(roomId);
  else set.delete(roomId);
  store.set(STARS, [...set]);
  return on;
}

export function houses(store) {
  const list = store.get(HOUSES, []);
  return Array.isArray(list) ? list : [];
}

const colorOk = (c) => HOUSE_COLORS.some(([k]) => k === c);
const iconOk = (i) => HOUSE_ICONS.includes(i);
const cleanName = (name) => String(name || "").trim().slice(0, 30);

export function addHouse(store, { name, color, icon }, now = Date.now()) {
  const house = {
    id: "h" + now.toString(36) + Math.random().toString(36).slice(2, 6),
    name: cleanName(name) || "집",
    color: colorOk(color) ? color : HOUSE_COLORS[0][0],
    icon: iconOk(icon) ? icon : HOUSE_ICONS[0],
    rooms: [],
    at: now,
  };
  store.set(HOUSES, [...houses(store), house]);
  return house;
}

export function updateHouse(store, id, { name, color, icon }) {
  store.set(HOUSES, houses(store).map((h) => (h.id !== id ? h : {
    ...h,
    name: name === undefined ? h.name : cleanName(name) || h.name,
    color: colorOk(color) ? color : h.color,
    icon: iconOk(icon) ? icon : h.icon,
  })));
}

/** Takes a house down; its rooms are on their own again (nothing is deleted). */
export function removeHouse(store, id) {
  store.set(HOUSES, houses(store).filter((h) => h.id !== id));
}

/** Puts a room into a house (out of any other first). */
export function putInHouse(store, roomId, houseId) {
  store.set(HOUSES, houses(store).map((h) => {
    const rooms = (h.rooms || []).filter((r) => r !== roomId);
    if (h.id === houseId) rooms.push(roomId);
    return { ...h, rooms };
  }));
}

export function takeOutOfHouse(store, roomId) {
  store.set(HOUSES, houses(store).map((h) => ({ ...h, rooms: (h.rooms || []).filter((r) => r !== roomId) })));
}

export function houseOf(store, roomId) {
  return houses(store).find((h) => (h.rooms || []).includes(roomId)) || null;
}

/** The last searches, newest first, as many as `max`. */
export function recentSearches(store, max = 5) {
  const list = store.get(SEARCHES, []);
  return (Array.isArray(list) ? list : []).slice(0, Math.max(0, max));
}

export function rememberSearch(store, query, max = 5) {
  const q = String(query || "").trim().slice(0, 60);
  if (!q) return;
  const list = [q, ...store.get(SEARCHES, []).filter((x) => x !== q)];
  // Kept to the setting's size (a smaller setting forgets the rest).
  store.set(SEARCHES, list.slice(0, Math.min(MAX_KEPT_SEARCHES, Math.max(1, max))));
}

export function forgetSearches(store) {
  store.set(SEARCHES, []);
}

// ---- 찾기 (내용): what a room holds, in words, kept when one leaves it ---------------------------

const WORDS = "roomWords";
const MAX_WORDS = 8000;
const MAX_ROOMS_WITH_WORDS = 80;

/** { roomId: { text, at } } */
export function roomWords(store) {
  const map = store.get(WORDS, {});
  return map && typeof map === "object" ? map : {};
}

/** Keeps a room's words (the last part of a long one) for searching from home. */
export function keepRoomWords(store, roomId, text, now = Date.now()) {
  if (typeof text !== "string") return;
  const map = roomWords(store);
  map[roomId] = { text: text.length > MAX_WORDS ? text.slice(-MAX_WORDS) : text, at: now };
  const ids = Object.keys(map).sort((a, b) => map[b].at - map[a].at);
  for (const id of ids.slice(MAX_ROOMS_WITH_WORDS)) delete map[id];
  store.set(WORDS, map);
}
