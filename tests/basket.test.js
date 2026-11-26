import test from "node:test";
import assert from "node:assert/strict";
import { copyItem, clipboardItem, basketItems, removeFromBasket, takeFromBasket, describeItem, BASKET_MAX } from "../src/clipboard.js";
import { refNote, setRefNote, noteFromMemos, addRefNote, toggleTodo, flipTodoAt } from "../src/reference.js";

const memoryStore = () => {
  const data = new Map();
  return { get: (k, d) => (data.has(k) ? structuredClone(data.get(k)) : d), set: (k, v) => data.set(k, structuredClone(v)) };
};

const clip = (name, length = 3200) => ({ kind: "song-clip", room: "r-a", src: "s1", offset: 0, length, speed: 1, tint: null, source: { duration: 4, notes: [], peaks: "", blob: "b-" + name, name } });

// 비서's 바구니 (검토 9절, the day's plan 6): every copy is what 붙여넣기 puts down, and it also piles up
// in the basket, newest first, so any of them can be put into another room later.
test("바구니: each copy is the one 붙여넣기 uses and piles up newest first; the same thing again comes to the front once", () => {
  const store = memoryStore();
  copyItem(store, clip("하나"), { room: "r-a", name: "노래 방", kind: "creative-song" });
  copyItem(store, { kind: "text", text: "가사 한 줄" }, { room: "r-t", name: "일기", kind: "daily-text" });
  assert.equal(clipboardItem(store, "text").text, "가사 한 줄", "the last copy is the one to paste");
  assert.equal(clipboardItem(store, "song-clip").source.name, "하나", "a room's 붙여넣기 still finds the newest thing it can take (a text copied later does not hide the clip)");
  assert.deepEqual(basketItems(store).map((e) => e.item.kind), ["text", "song-clip"]);
  assert.deepEqual(basketItems(store)[1].from, { room: "r-a", name: "노래 방", kind: "creative-song" });
  copyItem(store, clip("하나"), { room: "r-a", name: "노래 방", kind: "creative-song" });
  assert.deepEqual(basketItems(store).map((e) => e.item.kind), ["song-clip", "text"], "the same clip again: one entry, at the front");
  for (let i = 0; i < BASKET_MAX + 10; i++) copyItem(store, { kind: "text", text: "줄 " + i });
  assert.equal(basketItems(store).length, BASKET_MAX, "the oldest go out");
});

test("바구니: an older one taken out (여기에 놓기) becomes the one to paste and comes to the front; one can be taken off", () => {
  const store = memoryStore();
  copyItem(store, clip("하나"));
  copyItem(store, { kind: "text", text: "둘" });
  const older = basketItems(store)[1];
  const item = takeFromBasket(store, older.id);
  assert.equal(item.kind, "song-clip");
  assert.equal(clipboardItem(store, "song-clip").source.name, "하나");
  assert.equal(basketItems(store)[0].id, older.id);
  removeFromBasket(store, older.id);
  assert.deepEqual(basketItems(store).map((e) => e.item.kind), ["text"]);
  assert.equal(takeFromBasket(store, "nothing"), null);
});

test("바구니: each thing says what it is in a few words", () => {
  assert.match(describeItem(clip("흥얼", 3200)).text, /흥얼.*3\.2초/);
  assert.equal(describeItem(clip("흥얼")).icon, "note");
  assert.match(describeItem({ kind: "song-clips", clips: [{ length: 1000 }, { length: 2000 }] }).text, /클립 2개/);
  assert.match(describeItem({ kind: "board-items", items: [{ kind: "note" }, { kind: "song" }], strokes: [{}, {}, {}] }).text, /카드 2개.*그림 3/);
  assert.match(describeItem({ kind: "text", text: "아주 긴 ".repeat(30) }).text, /…$/);
});

// 노트 (검토 9절): one sheet instead of the message-like memos; old memos move in once, oldest first.
test("노트: old memos become the note's lines once, oldest first; then the note is its own", () => {
  const store = memoryStore();
  addRefNote(store, "첫 메모", 1000);
  addRefNote(store, "둘째 메모\n두 줄", 2000);
  assert.equal(refNote(store), "");
  noteFromMemos(store);
  assert.equal(refNote(store), "첫 메모\n둘째 메모\n두 줄");
  setRefNote(store, "새로 쓴 것");
  addRefNote(store, "또 메모", 3000);
  noteFromMemos(store);
  assert.equal(refNote(store), "새로 쓴 것", "moved once only");
});

test("노트: □ makes the caret's line a to-do and takes it off again; a tap on □ ticks it, on ☑ unticks it", () => {
  const text = "장보기\n우유\n빵";
  const a = toggleTodo(text, 5); // in "우유"
  assert.equal(a.text, "장보기\n□ 우유\n빵");
  assert.equal(a.caret, 7, "the caret stays with its words");
  const b = toggleTodo(a.text, 8); // the end of "□ 우유"
  assert.equal(b.text, "장보기\n우유\n빵");
  assert.equal(b.caret, 6);
  const ticked = flipTodoAt(a.text, 4); // on the □
  assert.equal(ticked, "장보기\n☑ 우유\n빵");
  assert.equal(flipTodoAt(ticked, 4), "장보기\n□ 우유\n빵");
  assert.equal(flipTodoAt(a.text, 8), null, "a tap on the words is only a tap");
  assert.equal(toggleTodo("☑ 끝낸 일", 3).text, "끝낸 일", "a done one goes back to a plain line");
});
