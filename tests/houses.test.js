import test from "node:test";
import assert from "node:assert/strict";
import { starred, toggleStar, houses, addHouse, updateHouse, removeHouse, putInHouse, takeOutOfHouse, houseOf, recentSearches, rememberSearch, forgetSearches, HOUSE_COLORS, HOUSE_ICONS } from "../src/houses.js";

const memoryStore = () => {
  const data = new Map();
  return { get: (k, d) => (data.has(k) ? structuredClone(data.get(k)) : d), set: (k, v) => data.set(k, structuredClone(v)) };
};

test("별표: a room is starred and unstarred on this device", () => {
  const store = memoryStore();
  assert.equal(starred(store).size, 0);
  assert.equal(toggleStar(store, "r1"), true);
  toggleStar(store, "r2");
  assert.deepEqual([...starred(store)], ["r1", "r2"]);
  assert.equal(toggleStar(store, "r1"), false);
  assert.deepEqual([...starred(store)], ["r2"]);
});

test("집: made with a name, a colour and an icon, kept in the order they were made; changed; taken down", () => {
  const store = memoryStore();
  const a = addHouse(store, { name: "우리 가족", color: "pink", icon: "heart" }, 1000);
  const b = addHouse(store, { name: "", color: "nope", icon: "nope" }, 2000);
  assert.deepEqual(houses(store).map((x) => [x.name, x.color, x.icon]), [["우리 가족", "pink", "heart"], ["집", HOUSE_COLORS[0][0], HOUSE_ICONS[0]]], "a house needs a name, a colour and an icon it knows");
  updateHouse(store, b.id, { name: "노래들", color: "blue", icon: "note" });
  assert.deepEqual(houses(store)[1], { ...houses(store)[1], name: "노래들", color: "blue", icon: "note" });
  removeHouse(store, a.id);
  assert.deepEqual(houses(store).map((x) => x.id), [b.id]);
});

test("a room lives in one house at a time; taken out it is on its own again; a house taken down lets its rooms go", () => {
  const store = memoryStore();
  const a = addHouse(store, { name: "가", color: "green", icon: "home" });
  const b = addHouse(store, { name: "나", color: "blue", icon: "note" });
  putInHouse(store, "r1", a.id);
  putInHouse(store, "r2", a.id);
  putInHouse(store, "r1", b.id);
  assert.equal(houseOf(store, "r1")?.id, b.id, "moved, not copied");
  assert.deepEqual(houses(store).find((x) => x.id === a.id).rooms, ["r2"]);
  takeOutOfHouse(store, "r2");
  assert.equal(houseOf(store, "r2"), null);
  removeHouse(store, b.id);
  assert.equal(houseOf(store, "r1"), null);
});

test("recent searches: newest first, no repeats, as many as the setting keeps; forgotten at once", () => {
  const store = memoryStore();
  for (const q of ["쇼", "노래", "쇼", "  ", "산책"]) rememberSearch(store, q, 5);
  assert.deepEqual(recentSearches(store, 5), ["산책", "쇼", "노래"]);
  for (let i = 0; i < 12; i++) rememberSearch(store, "q" + i, 5);
  assert.equal(recentSearches(store, 5).length, 5);
  assert.deepEqual(recentSearches(store, 5)[0], "q11");
  rememberSearch(store, "많이", 10);
  assert.equal(recentSearches(store, 10).length, 6, "a larger setting keeps more from now on");
  forgetSearches(store);
  assert.deepEqual(recentSearches(store, 5), []);
});

test("a room's words are kept for searching (the end of a long one); only so many rooms", async () => {
  const { keepRoomWords, roomWords } = await import("../src/houses.js");
  const store = memoryStore();
  keepRoomWords(store, "r1", "오늘은 쇼타로랑 산책", 1);
  keepRoomWords(store, "r2", "가".repeat(9000) + "끝", 2);
  assert.equal(roomWords(store).r1.text, "오늘은 쇼타로랑 산책");
  assert.ok(roomWords(store).r2.text.endsWith("끝") && roomWords(store).r2.text.length === 8000);
  for (let i = 0; i < 100; i++) keepRoomWords(store, "x" + i, "글", 10 + i);
  assert.equal(Object.keys(roomWords(store)).length, 80);
  assert.equal(roomWords(store).r1, undefined, "the oldest go first");
});
