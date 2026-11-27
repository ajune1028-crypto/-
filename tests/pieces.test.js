import test from "node:test";
import assert from "node:assert/strict";
import { PIECES, defaultLayout, wholeLayout, putPiece, putStack, turnStack } from "../src/core/pieces.js";

// The owner (27 November): "그 바… 기능마다 있는거 따로 분리할 수 있게… 끝부분에꺼가 좀 튀어나오는데 그거 꾹
// 누르면… 각자거를 빼서 어디다가 눌 수도 있고. 다시 조립할 수도… 분리된거는 아래에 조그마낫게 뭐가 튀어나오고…
// 90도마다… 가까이 두면 겹칠 수도".

const everyPieceOnce = (layout) => {
  const all = layout.stacks.flatMap((s) => s.pieces);
  assert.deepEqual([...all].sort(), [...PIECES].sort(), "every piece once: " + JSON.stringify(layout));
};

test("at first the rail is one stack at the left with every piece: 도구, 색, 크기, 빠른 굵기", () => {
  const l = defaultLayout();
  assert.equal(l.stacks.length, 1);
  assert.equal(l.stacks[0].dock, true);
  assert.deepEqual(l.stacks[0].pieces, ["tools", "color", "size", "widths"]);
});

test("a kept layout is made whole: each piece once, the dock first, floats inside the screen and turned by quarters", () => {
  assert.deepEqual(wholeLayout(null), defaultLayout());
  assert.deepEqual(wholeLayout({ stacks: "x" }), defaultLayout());
  const l = wholeLayout({ stacks: [
    { pieces: ["color", "color", "zzz"], dock: false, x: 2, y: -1, turn: 45 },
    { pieces: ["tools"], dock: true },
    { pieces: [], dock: false, x: 0.5, y: 0.5 },
  ] });
  everyPieceOnce(l);
  assert.equal(l.stacks[0].dock, true, "the dock comes first");
  assert.deepEqual(l.stacks[0].pieces.slice(0, 1), ["tools"]);
  const float = l.stacks.find((s) => !s.dock);
  assert.deepEqual(float.pieces, ["color"]);
  assert.equal(float.x, 1);
  assert.equal(float.y, 0);
  assert.equal(float.turn, 0, "only quarter turns");
  assert.equal(l.stacks.filter((s) => !s.dock).length, 1, "an empty float is gone");
  // What was missing goes back into the dock.
  assert.ok(l.stacks[0].pieces.includes("size") && l.stacks[0].pieces.includes("widths"));
});

test("a piece pulled out stands on its own where it was let go; brought near a stack's end it joins it there", () => {
  let l = defaultLayout();
  l = putPiece(l, "color", { x: 0.8, y: 0.2 });
  everyPieceOnce(l);
  assert.deepEqual(l.stacks[0].pieces, ["tools", "size", "widths"]);
  assert.deepEqual(l.stacks[1], { pieces: ["color"], dock: false, x: 0.8, y: 0.2, turn: 0 });
  // 빠른 굵기 put onto the colour's stack, after it; 크기 before it.
  l = putPiece(l, "widths", { stack: 1, end: "end" });
  l = putPiece(l, "size", { stack: 1, end: "start" });
  everyPieceOnce(l);
  assert.deepEqual(l.stacks[1].pieces, ["size", "color", "widths"]);
  assert.deepEqual(l.stacks[0].pieces, ["tools"]);
  // The last piece of a float taken back to the dock: the float goes.
  l = putPiece(l, "color", { x: 0.1, y: 0.9 });
  const lone = l.stacks.findIndex((s) => !s.dock && s.pieces.length === 1 && s.pieces[0] === "color");
  l = putPiece(l, "color", { stack: 0, end: "end" });
  everyPieceOnce(l);
  assert.ok(lone > 0 && !l.stacks.some((s) => !s.dock && s.pieces.includes("color")));
  assert.deepEqual(l.stacks[0].pieces, ["tools", "color"]);
});

test("a whole stack moves, joins another, or leaves the dock; a float turns a quarter at a time, the dock stays upright", () => {
  let l = putPiece(defaultLayout(), "color", { x: 0.7, y: 0.3 });
  l = putPiece(l, "widths", { x: 0.7, y: 0.7 });
  const widthsAt = l.stacks.findIndex((s) => s.pieces[0] === "widths");
  l = putStack(l, widthsAt, { x: 0.4, y: 0.6 });
  assert.equal(l.stacks.find((s) => s.pieces[0] === "widths").x, 0.4);
  // The widths' stack brought to the colour's start: one stack.
  const colourAt = l.stacks.findIndex((s) => s.pieces.includes("color"));
  l = putStack(l, l.stacks.findIndex((s) => s.pieces[0] === "widths"), { stack: colourAt, end: "start" });
  everyPieceOnce(l);
  assert.deepEqual(l.stacks.find((s) => s.pieces.includes("color")).pieces, ["widths", "color"]);
  // Turning.
  const f = l.stacks.findIndex((s) => !s.dock);
  for (const want of [90, 180, 270, 0]) {
    l = turnStack(l, f);
    assert.equal(l.stacks[f].turn, want);
  }
  assert.equal(turnStack(l, 0).stacks[0].turn, 0, "the dock does not turn");
  // The dock moved out: its pieces float there, the dock stays (empty) for pieces to come back to.
  l = putStack(l, 0, { x: 0.3, y: 0.3 });
  everyPieceOnce(l);
  assert.equal(l.stacks[0].dock, true);
  assert.deepEqual(l.stacks[0].pieces, []);
  assert.ok(l.stacks.some((s) => !s.dock && s.x === 0.3 && s.pieces.includes("tools")));
});
