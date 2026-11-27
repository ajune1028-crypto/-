// 홈 '보드' 보기 (the owner, 27 November: "방을 내가 원하는 그거로 해 놓고 내가 원하는 위치에 넣을 수 있게… 크기를
// 많이 줄이면 제목은 아래에 나오고 아이콘"): each room's spot on a half's board, in cells.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardLayout, moveSpot, sizeSpot, overlaps, tileLook } from "../src/core/home-board.js";

const spots = (layout) => Object.fromEntries([...layout].map(([id, s]) => [id, [s.x, s.y, s.w, s.h]]));

test("rooms without a spot go into the first free places in turn, a card's size each", () => {
  const layout = boardLayout(["a", "b", "c"], {}, 3);
  assert.deepEqual(spots(layout), { a: [0, 0, 3, 2], b: [0, 2, 3, 2], c: [0, 4, 3, 2] });
  const wide = boardLayout(["a", "b", "c"], {}, 6);
  assert.deepEqual(spots(wide), { a: [0, 0, 3, 2], b: [3, 0, 3, 2], c: [0, 2, 3, 2] });
});

test("kept spots stay where they were put, gaps and all; new ones fill free places around them", () => {
  const layout = boardLayout(["a", "b", "c"], { a: [1, 3, 1, 1], b: [0, 0, 2, 2] }, 3);
  assert.deepEqual(spots(layout).a, [1, 3, 1, 1]);
  assert.deepEqual(spots(layout).b, [0, 0, 2, 2]);
  const c = spots(layout).c;
  for (const other of ["a", "b"]) assert.ok(!overlaps({ x: c[0], y: c[1], w: c[2], h: c[3] }, layout.get(other)), "no overlap with " + other);
});

test("on a narrower board a spot is brought inside it, and whatever it then lies on moves down", () => {
  const layout = boardLayout(["a", "b"], { a: [4, 0, 2, 2], b: [0, 0, 3, 2] }, 3);
  const a = layout.get("a");
  const b = layout.get("b");
  assert.ok(a.x + a.w <= 3 && b.x + b.w <= 3, "inside three columns");
  assert.ok(!overlaps(a, b), "and not on each other");
});

test("moved onto others, a room takes the spot and those it lands on go down below it", () => {
  const layout = boardLayout(["a", "b"], {}, 3); // a [0,0,3,2], b [0,2,3,2]
  const moved = moveSpot(layout, "b", 0, 0, 3);
  assert.deepEqual(spots(moved), { b: [0, 0, 3, 2], a: [0, 2, 3, 2] });
  // Partly over: still pushed clear, nothing else moves needlessly.
  const three = boardLayout(["a", "b", "c"], { a: [0, 0, 1, 1], b: [1, 0, 1, 1], c: [2, 0, 1, 1] }, 3);
  const next = moveSpot(three, "c", 0, 0, 3);
  assert.deepEqual(spots(next).c, [0, 0, 1, 1]);
  assert.deepEqual(spots(next).b, [1, 0, 1, 1], "b was not in the way");
  assert.deepEqual(spots(next).a, [0, 1, 1, 1], "a went just below");
});

test("a move is kept inside the board", () => {
  const layout = boardLayout(["a"], {}, 3);
  assert.deepEqual(spots(moveSpot(layout, "a", 5, -2, 3)).a, [0, 0, 3, 2]);
  const small = boardLayout(["a"], { a: [0, 0, 1, 1] }, 3);
  assert.deepEqual(spots(moveSpot(small, "a", 9, 4, 3)).a, [2, 4, 1, 1]);
});

test("resized, a room keeps its corner and pushes what it now covers down; never wider than the board", () => {
  const layout = boardLayout(["a", "b"], { a: [0, 0, 1, 1], b: [1, 0, 2, 2] }, 3);
  const grown = sizeSpot(layout, "a", 2, 2, 3);
  assert.deepEqual(spots(grown).a, [0, 0, 2, 2]);
  assert.ok(!overlaps(grown.get("a"), grown.get("b")));
  assert.deepEqual(spots(sizeSpot(layout, "b", 9, 9, 3)).b, [1, 0, 2, 4], "at most the columns left and four rows");
  assert.deepEqual(spots(sizeSpot(layout, "b", 0, 0, 3)).b, [1, 0, 1, 1], "at least one cell");
});

test("its look comes from its size: one column an icon with its name below, one row a line, else a card", () => {
  assert.equal(tileLook({ w: 1, h: 1 }), "icon");
  assert.equal(tileLook({ w: 1, h: 3 }), "icon");
  assert.equal(tileLook({ w: 3, h: 1 }), "line");
  assert.equal(tileLook({ w: 2, h: 2 }), "card");
});
