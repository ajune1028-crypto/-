import test from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/core/crdt.js";
import { BoardDoc, addItemOps, setItemOps, removeItemOps, linkOps, unlinkOps, invertBoardOps, playOrder, ORDER_COLORS, songCardData, boardSong, splitCardOps, saveSlotOps, useSlotOps, cardsSong } from "../src/core/board.js";
import { rng, shuffle } from "./helpers.js";

const NOTES = [{ t: 0, d: 0.4, p: 60, v: 0.8 }, { t: 0.5, d: 0.4, p: 64, v: 0.8 }];

function setup() {
  const board = new BoardDoc();
  const clock = new Clock("a");
  const commit = (made) => { for (const op of made.ops) board.apply(op); return made; };
  const song = (x, y = 0) => commit(addItemOps(clock, board, { kind: "song", x, y, data: songCardData({ duration: 1, notes: NOTES, peaks: "", name: "흥얼" }), by: "m1" }));
  const note = (x, y = 0, text = "메모") => commit(addItemOps(clock, board, { kind: "note", x, y, data: { text }, by: "m1" }));
  return { board, clock, commit, song, note };
}

test("cards are placed, moved and removed; the last move wins", () => {
  const { board, clock, commit, note } = setup();
  const a = note(100, 50);
  assert.deepEqual(board.items().map((i) => [i.kind, i.x, i.y, i.text]), [["note", 100, 50, "메모"]]);
  commit(setItemOps(clock, board, a.id, { x: 300, y: 80 }));
  commit(setItemOps(clock, board, a.id, { text: "가사 첫 줄" }));
  assert.deepEqual(board.items().map((i) => [i.x, i.y, i.text]), [[300, 80, "가사 첫 줄"]]);
  const gone = commit(removeItemOps(clock, board, a.id));
  assert.equal(board.items().length, 0);
  commit({ ops: invertBoardOps(board, clock, gone.atoms, "undo") });
  assert.equal(board.items().length, 1);
});

test("without lines, song cards play from the leftmost", () => {
  const { board, song } = setup();
  const right = song(500);
  const left = song(-200);
  const mid = song(100);
  assert.deepEqual(playOrder(board).map((s) => s.id), [left.id, mid.id, right.id]);
});

test("잇기 lines set the order; each line has its number and a rainbow colour in turn", () => {
  const { board, clock, commit, song } = setup();
  const a = song(500);
  const b = song(0);
  const c = song(250);
  const d = song(-300);
  commit(linkOps(clock, board, a.id, b.id, "m1"));
  commit(linkOps(clock, board, b.id, c.id, "m1"));
  // The chain a→b→c starts further right than d, so d plays first, then the chain.
  assert.deepEqual(playOrder(board).map((s) => s.id), [d.id, a.id, b.id, c.id]);
  const lines = board.links();
  assert.deepEqual(lines.map((l) => [l.n, l.color]), [[1, ORDER_COLORS[0]], [2, ORDER_COLORS[1]]]);
  assert.deepEqual(ORDER_COLORS.length, 8, "빨주노초파남보검");
});

test("a line to a card already in a chain, or back to itself, is refused", () => {
  const { board, clock, commit, song } = setup();
  const a = song(0);
  const b = song(100);
  commit(linkOps(clock, board, a.id, b.id, "m1"));
  assert.equal(linkOps(clock, board, a.id, a.id, "m1").ops.length, 0);
  assert.equal(linkOps(clock, board, b.id, a.id, "m1").ops.length, 0, "no loops");
});

test("removing a line, or a card, breaks the chain there; undo brings it back", () => {
  const { board, clock, commit, song } = setup();
  const a = song(300);
  const b = song(0);
  const line = commit(linkOps(clock, board, a.id, b.id, "m1"));
  assert.deepEqual(playOrder(board).map((s) => s.id), [a.id, b.id]);
  const cut = commit(unlinkOps(clock, board, board.links()[0].id));
  assert.deepEqual(playOrder(board).map((s) => s.id), [b.id, a.id]);
  commit({ ops: invertBoardOps(board, clock, cut.atoms, "undo") });
  assert.deepEqual(playOrder(board).map((s) => s.id), [a.id, b.id]);
  commit({ ops: invertBoardOps(board, clock, line.atoms, "undo") });
  assert.equal(board.links().length, 0);
});

test("the cards in order become one song to play, one after another", () => {
  const { board, clock, commit, song } = setup();
  const a = song(300);
  const b = song(0);
  commit(linkOps(clock, board, a.id, b.id, "m1"));
  const s = boardSong(board);
  const clips = s.layout();
  assert.deepEqual(clips.map((c) => [c.start, c.length]), [[0, 1000], [1000, 1000]]);
  assert.deepEqual(s.noteEvents(0, 5000).map((e) => [e.at, e.p]), [[0, 60], [500, 64], [1000, 60], [1500, 64]]);
});

test("devices that get the same board ops in any order agree", () => {
  const { board, clock, commit, song, note } = setup();
  const all = [];
  const keep = (made) => { all.push(...made.ops); return made; };
  const a = keep(song(0));
  const b = keep(song(200));
  const c = keep(note(50, 300));
  keep(commit(setItemOps(clock, board, c.id, { x: 90 })));
  keep(commit(linkOps(clock, board, a.id, b.id, "m1")));
  keep(commit(setItemOps(clock, board, a.id, { y: 40 })));
  const want = JSON.stringify({ items: board.items(), links: board.links() });
  const r = rng(2);
  for (let k = 0; k < 15; k++) {
    const other = new BoardDoc();
    for (const op of shuffle(r, [...all, ...all.slice(0, 2)])) other.apply(op);
    assert.equal(JSON.stringify({ items: other.items(), links: other.links() }), want);
  }
});

test("ops that make no sense are set aside", () => {
  const board = new BoardDoc();
  for (const bad of [
    { t: "item", id: "1@a", kind: "rocket", x: 0, y: 0, data: {}, by: "m", at: 1 },
    { t: "item", id: "2@a", kind: "note", x: "far", y: 0, data: { text: "x" }, by: "m", at: 1 },
    { t: "iset", id: "3@a", i: "1@a", f: { colour: 1 } },
    { t: "link", id: "4@a", a: "x", b: "1@a", by: "m" },
  ]) assert.equal(board.apply(bad), "unknown");
});

// ---- 노래 모드 on the board (14 November, night) ----------------------------------

const card = (seconds, notes = NOTES) => songCardData({ duration: seconds, notes, peaks: "", name: "흥얼" });

test("a song card is as wide as its song is long: 60 px a second, from 120 to 960", () => {
  const { board, clock, commit } = setup();
  const widths = [1, 4, 30].map((s) => board.item(commit(addItemOps(clock, board, { kind: "song", x: 0, y: s * 100, data: card(s), by: "m1" })).id).w);
  assert.deepEqual(widths, [120, 240, 960]);
});

test("a song card's notes can be changed and the card muted; undo puts both back; bad notes are refused", () => {
  const { board, clock, commit, song } = setup();
  const a = song(0);
  const edited = { ...board.item(a.id).data, notes: [[0, 300, 62, 80], [500, 400, 64, 80]] };
  const set = commit(setItemOps(clock, board, a.id, { data: edited, muted: true }));
  assert.deepEqual(board.item(a.id).data.notes, [[0, 300, 62, 80], [500, 400, 64, 80]]);
  assert.equal(board.item(a.id).muted, true);
  commit({ ops: invertBoardOps(board, clock, set.atoms, "undo") });
  assert.deepEqual(board.item(a.id).data.notes, [[0, 400, 60, 80], [500, 400, 64, 80]]);
  assert.equal(board.item(a.id).muted, false);
  board.apply({ t: "iset", id: clock.next(), i: a.id, f: { data: { dur: 1000, peaks: "", notes: [[0, 0, 300, 80]] } } });
  assert.deepEqual(board.item(a.id).data.notes[0], [0, 400, 60, 80], "a note with no length and pitch 300 is refused");
});

test("splitting a song card makes two at the cut and keeps its place in the order; undo joins it again", () => {
  const { board, clock, commit, song } = setup();
  const first = song(0);
  const b = song(300);
  const c = song(600);
  commit(linkOps(clock, board, first.id, b.id, "m1"));
  commit(linkOps(clock, board, b.id, c.id, "m1"));
  const made = commit(splitCardOps(clock, board, b.id, 450, "m1"));
  const [left, right] = made.ids.map((id) => board.item(id));
  assert.deepEqual([left.data.dur, right.data.dur], [450, 550]);
  assert.deepEqual(left.data.notes, [[0, 400, 60, 80]], "notes before the cut");
  assert.deepEqual(right.data.notes, [[50, 400, 64, 80]], "notes after it, from the cut");
  assert.equal(left.x, 300);
  assert.ok(right.x > left.x + left.w, "the right part stands to the right");
  assert.deepEqual(playOrder(board).map((i) => i.id), [first.id, left.id, right.id, c.id], "the halves keep the place in the order");
  commit({ ops: invertBoardOps(board, clock, made.atoms, "undo") });
  assert.deepEqual(playOrder(board).map((i) => i.id), [first.id, b.id, c.id]);
  assert.deepEqual(splitCardOps(clock, board, b.id, 20, "m1").ops, [], "no cut right at the edge");
});

test("a muted card is silent when the board plays", () => {
  const { board, clock, commit, song } = setup();
  const a = song(0);
  song(300);
  commit(setItemOps(clock, board, a.id, { muted: true }));
  const s = boardSong(board);
  assert.deepEqual(s.layout().map((c) => c.muted), [true, false]);
});

test("order slots: save the lines, change them, bring a slot back, undo it; saves merge in any order", () => {
  const board = new BoardDoc();
  const clock = new Clock("a");
  const log = [];
  const commit = (made) => { for (const op of made.ops) { board.apply(op); log.push(op); } return made; };
  const song = (x) => commit(addItemOps(clock, board, { kind: "song", x, y: 0, data: card(1), by: "m1" }));
  const [a, b, c] = [song(0), song(300), song(600)];
  commit(linkOps(clock, board, a.id, b.id, "m1"));
  commit(linkOps(clock, board, b.id, c.id, "m1"));
  const one = commit(saveSlotOps(clock, board, 1, "m1"));
  for (const l of board.links()) commit(unlinkOps(clock, board, l.id));
  commit(linkOps(clock, board, c.id, a.id, "m1"));
  commit(saveSlotOps(clock, board, 2, "m1"));
  assert.deepEqual(board.slots().map((s) => [s.n, s.pairs.length]), [[1, 2], [2, 1]]);
  const back = commit(useSlotOps(clock, board, 1, "m1"));
  assert.deepEqual(board.links().map((l) => [l.a, l.b]), [[a.id, b.id], [b.id, c.id]]);
  commit({ ops: invertBoardOps(board, clock, back.atoms, "undo") });
  assert.deepEqual(board.links().map((l) => [l.a, l.b]), [[c.id, a.id]]);
  // Another device saves slot 1 later; whichever order the saves arrive in, the later one wins.
  const later = { t: "slot", id: clock.next(), n: 1, pairs: [[c.id, b.id]], by: "m2" };
  const other = new BoardDoc();
  for (const op of shuffle(rng(7), [...log, later])) other.apply(op);
  board.apply(later);
  assert.deepEqual(other.slots(), board.slots());
  assert.deepEqual(board.slots()[0].pairs, [[c.id, b.id]]);
  void one;
});

test("one card alone is a song of its own, for hearing just it", () => {
  const { board, song } = setup();
  song(0);
  const b = song(300);
  const alone = cardsSong([board.item(b.id)]);
  assert.deepEqual(alone.layout().map((c) => [c.start, c.length]), [[0, 1000]]);
  assert.equal(alone.end(), 1000);
});

test("올가미: a loop drawn round cards plays only those, in order; it closes itself, moves, comes off, all undoable, in any order", async () => {
  const { lassoOps, moveLassoOps, removeLassoOps, lassoOrder } = await import("../src/core/board.js");
  const board = new BoardDoc();
  const clock = new Clock("a");
  const log = [];
  const commit = (made) => { for (const op of made.ops) { board.apply(op); log.push(op); } return made; };
  const song = (x, y = 0) => commit(addItemOps(clock, board, { kind: "song", x, y, data: card(1), by: "m1" }));
  const [a, b, c] = [song(0), song(200), song(600)];
  // An open stroke round the first two (its end does not meet its start).
  const loop = commit(lassoOps(clock, board, [-20, -20, 380, -20, 380, 120, -20, 120, -20, 40], "m1"));
  assert.deepEqual(board.lassos().map((l) => l.id), [loop.id]);
  assert.deepEqual(lassoOrder(board, loop.id).map((i) => i.id), [a.id, b.id], "only what is inside, left first");
  commit(linkOps(clock, board, b.id, a.id, "m1"));
  assert.deepEqual(lassoOrder(board, loop.id).map((i) => i.id), [b.id, a.id], "the order lines count inside too");
  const moved = commit(moveLassoOps(clock, board, loop.id, 400, 0));
  assert.deepEqual(lassoOrder(board, loop.id).map((i) => i.id), [c.id], "moved over the third");
  commit({ ops: invertBoardOps(board, clock, moved.atoms, "undo") });
  assert.deepEqual(lassoOrder(board, loop.id).map((i) => i.id), [b.id, a.id]);
  const gone = commit(removeLassoOps(clock, board, loop.id));
  assert.equal(board.lassos().length, 0);
  commit({ ops: invertBoardOps(board, clock, gone.atoms, "undo") });
  assert.equal(board.lassos().length, 1);
  const other = new BoardDoc();
  for (const op of shuffle(rng(5), log)) other.apply(op);
  assert.deepEqual(other.lassos(), board.lassos());
  assert.deepEqual(lassoOps(clock, board, [0, 0, 10, 10], "m1").ops, [], "too small to be a loop");
});

test("올가미 closes the shortest way: a crossing keeps the loop, a near end trims the lead-in, an open end joins the start", async () => {
  const { lassoOps } = await import("../src/core/board.js");
  const board = new BoardDoc();
  const clock = new Clock("a");
  const loopOf = (stroke) => {
    const made = lassoOps(clock, board, stroke, "m1");
    for (const op of made.ops) board.apply(op);
    return board.lassos().find((l) => l.id === made.id).pts;
  };
  // The end runs across the beginning: the tails go.
  assert.deepEqual(loopOf([50, -30, 50, 200, 250, 200, 250, 0, -30, 0]), [50, 0, 50, 200, 250, 200, 250, 0]);
  // Never closed (a C): the end joins the start.
  assert.deepEqual(loopOf([0, 0, 300, 0, 300, 200, 0, 200, 0, 120]), [0, 0, 300, 0, 300, 200, 0, 200, 0, 120]);
  // A "6": the end comes back near the middle of the stroke, not the start.
  assert.deepEqual(loopOf([-200, 100, 0, 100, 0, 0, 200, 0, 200, 200, 10, 110]), [0, 100, 0, 0, 200, 0, 200, 200, 10, 110]);
});

test("photo cards: a small picture stands on the board, moves and goes like any card, and never plays; a bad picture is set aside", async () => {
  const { orderColor, PASTEL_COLORS } = await import("../src/core/board.js");
  const { board, clock, commit, song } = setup();
  const src = "data:image/jpeg;base64," + "A".repeat(400);
  const pic = commit(addItemOps(clock, board, { kind: "photo", x: 10, y: 20, data: { src, w: 640, h: 480 }, by: "m1" }));
  assert.deepEqual(board.items().map((i) => [i.kind, i.x, i.w, i.data.w]), [["photo", 10, 200, 640]]);
  const s = song(300);
  assert.deepEqual(playOrder(board).map((i) => i.id), [s.id], "photos do not play");
  commit(setItemOps(clock, board, pic.id, { x: 50 }));
  assert.equal(board.item(pic.id).x, 50);
  for (const data of [{ src: "javascript:alert(1)", w: 1, h: 1 }, { src: "data:image/svg+xml;base64,AAAA", w: 1, h: 1 }, { src, w: 0, h: 10 }, { src: "data:image/png;base64," + "A".repeat(70000), w: 10, h: 10 }]) {
    assert.equal(board.apply({ t: "item", id: clock.next(), kind: "photo", x: 0, y: 0, data, by: "m1", at: 1 }), "unknown", JSON.stringify(data).slice(0, 60));
  }
  // Order lines: 무지개 by default, 파스텔, or one colour of the person's own; then around again.
  assert.equal(orderColor(1, "rainbow"), ORDER_COLORS[0]);
  assert.equal(orderColor(9, "rainbow"), ORDER_COLORS[0]);
  assert.equal(orderColor(2, "pastel"), PASTEL_COLORS[1]);
  assert.equal(orderColor(5, "mine", "#123456"), "#123456");
});

test("plain text on the board takes a colour and a size; a loop finds every card inside it, of any kind", async () => {
  const { itemsInLoop, lassoOps } = await import("../src/core/board.js");
  const { board, clock, commit, note, song } = setup();
  const t = note(0, 0, "가사");
  commit(setItemOps(clock, board, t.id, { color: "blue", size: 3 }));
  assert.deepEqual([board.item(t.id).color, board.item(t.id).size], ["blue", 3]);
  assert.equal(board.apply({ t: "iset", id: clock.next(), i: t.id, f: { color: "pink" } }), "unknown", "only the ink colours");
  assert.equal(board.apply({ t: "iset", id: clock.next(), i: t.id, f: { size: 9 } }), "unknown");
  const s1 = song(300);
  const far = note(2000, 0, "멀리");
  const loop = commit(lassoOps(clock, board, [-50, -50, 700, -50, 700, 200, -50, 200], "m1"));
  assert.deepEqual(itemsInLoop(board, loop.id).map((i) => i.id).sort(), [t.id, s1.id].sort());
  void far;
});

test("a card may take a people colour (tint 0-7, null = whoever placed it); a loop has a colour too; undo puts each back", async () => {
  const { board, clock, commit, song, note } = setup();
  const { tintLassoOps, lassoOps } = await import("../src/core/board.js");
  const a = song(0, 0);
  const t = commit(setItemOps(clock, board, a.id, { tint: 5 }));
  assert.equal(board.item(a.id).tint, 5);
  commit({ ops: invertBoardOps(board, clock, t.atoms, "undo") });
  assert.equal(board.item(a.id).tint, null, "undo: no colour of its own again");
  const n = note(400, 0);
  commit(setItemOps(clock, board, n.id, { tint: 2 }));
  assert.equal(board.item(n.id).tint, 2, "text takes a people colour too");
  board.apply({ t: "iset", id: clock.next(), i: n.id, f: { tint: 9 } });
  assert.equal(board.item(n.id).tint, 2, "an unknown colour is refused");
  const loop = commit(lassoOps(clock, board, [-50, -50, 300, -50, 300, 200, -50, 200], "m1"));
  assert.equal(board.lassos()[0].tint ?? null, null);
  const c = commit(tintLassoOps(clock, board, loop.id, 6));
  assert.equal(board.lassos()[0].tint, 6);
  commit(tintLassoOps(clock, board, loop.id, 1));
  assert.equal(board.lassos()[0].tint, 1, "the later colour wins");
  commit({ ops: invertBoardOps(board, clock, c.atoms, "undo") });
  assert.equal(board.lassos()[0].tint, null, "undoing the first colour puts back none");
});

test("정리: cards laid in one row from the left, tops at the highest, an even gap; a rounded loop goes round a box", async () => {
  const { rowLayout, boxLoop, insideLoop } = await import("../src/core/board.js");
  const placed = rowLayout([{ id: "b", x: 300, y: 90, w: 100, h: 50 }, { id: "a", x: 20, y: 140, w: 120, h: 80 }, { id: "c", x: 160, y: 10, w: 60, h: 40 }], 24);
  assert.deepEqual(placed, [{ id: "a", x: 20, y: 10 }, { id: "c", x: 164, y: 10 }, { id: "b", x: 248, y: 10 }]);
  const pts = boxLoop(0, 0, 400, 100, 20);
  assert.ok(pts.length >= 16 && pts.length % 2 === 0 && pts.every(Number.isInteger));
  assert.ok(insideLoop(pts, 200, 50) && insideLoop(pts, 5, 50) && !insideLoop(pts, 200, 140), "the box's inside is inside");
});

test("잇기 branches: one card may lead to several (the later line comes after, its number next); a card follows one card only; the order follows each line to its end before the next", () => {
  const { board, clock, commit, song } = setup();
  const a = song(0);
  const b = song(300);
  const c = song(600);
  const d = song(900);
  const e = song(1200);
  commit(linkOps(clock, board, a.id, b.id, "m1"));
  commit(linkOps(clock, board, b.id, d.id, "m1"));
  const branch = commit(linkOps(clock, board, a.id, c.id, "m1"));
  assert.equal(branch.ops.length, 1, "a second line out of a card is a branch");
  assert.deepEqual(playOrder(board).map((i) => i.id), [a.id, b.id, d.id, c.id, e.id], "a, then b's line to its end (d), then a's later line (c); the rest from the left");
  assert.deepEqual(board.links().map((l) => [l.a, l.b, l.n]), [[a.id, b.id, 1], [b.id, d.id, 2], [a.id, c.id, 3]], "numbers as they play");
  assert.equal(linkOps(clock, board, e.id, c.id, "m1").ops.length, 0, "c already follows a: one card before each");
  assert.equal(linkOps(clock, board, d.id, a.id, "m1").ops.length, 0, "no circles");
  // Two devices drawing lines into the same card at once: both keep the earlier line, the same order.
  const x = linkOps(clock, board, e.id, d.id, "m1").ops; // refused here (d follows b) ...
  assert.equal(x.length, 0);
  board.apply({ t: "link", id: clock.next(), a: e.id, b: d.id, by: "m2" }); // ... but if it comes from elsewhere it is left out
  assert.deepEqual(playOrder(board).map((i) => i.id), [a.id, b.id, d.id, c.id, e.id]);
});

test("올가미 holds drawings too: a stroke is inside when its middle is (strokes count in hundredths of a 16 px rem)", async () => {
  const { strokesInLoop } = await import("../src/core/board.js");
  const unit = 100 / 16;
  const loop = [0, 0, 400, 0, 400, 300, 0, 300];
  const inside = { id: "s1", pts: [100 * unit, 100 * unit, 50, 200 * unit, 120 * unit, 50] };
  const outside = { id: "s2", pts: [500 * unit, 100 * unit, 50, 600 * unit, 120 * unit, 50] };
  const across = { id: "s3", pts: [350 * unit, 50 * unit, 50, 480 * unit, 60 * unit, 50] }; // its middle (415) is outside
  assert.deepEqual(strokesInLoop([inside, outside, across], loop, unit), ["s1"]);
});

test("a song card may have its own speed: the board plays it that much faster (and the next card starts sooner)", () => {
  const { board, clock, commit, song } = setup();
  const a = song(0);
  const b = song(400);
  commit(setItemOps(clock, board, a.id, { speed: 2 }));
  assert.equal(board.item(a.id).speed, 2);
  const s = boardSong(board);
  const clips = s.layout();
  assert.deepEqual(clips.map((c) => [c.start, c.speed || 1]), [[0, 2], [500, 1]], "the 1 s card at 2× takes 0.5 s; the next starts there");
  assert.equal(s.end(), 1500);
  board.apply({ t: "iset", id: clock.next(), i: a.id, f: { speed: 4 } });
  assert.equal(board.item(a.id).speed, 2, "an unknown speed is refused");
});

test("cutting a card at its own speed: both halves keep the speed, colour and mute, and are as wide as they sound", () => {
  const { board, clock, commit, song } = setup();
  const a = song(0);
  commit(setItemOps(clock, board, a.id, { speed: 2, tint: 3, muted: true }));
  const made = splitCardOps(clock, board, a.id, 500, "m1");
  commit(made);
  const [l, r] = made.ids.map((id) => board.item(id));
  assert.deepEqual([l.speed, r.speed, l.tint, r.tint, l.muted, r.muted], [2, 2, 3, 3, true, true]);
  assert.equal(l.w, 120, "0.5 s of data at 2× sounds 0.25 s: the narrowest card");
  assert.equal(r.x, l.x + l.w + 24, "the right half stands just after the left as it is drawn");
  commit({ ops: invertBoardOps(board, clock, made.atoms, "undo") });
  assert.deepEqual(board.items().map((i) => [i.id, i.speed]), [[a.id, 2]], "one undo brings the whole card back");
});

test("a copy keeps a card's looks: colour, size, own colour, speed and mute (and nothing it should not)", async () => {
  const { keepOf, keptFields } = await import("../src/core/board.js");
  const { board, clock, commit, song, note } = setup();
  const s = song(0);
  commit(setItemOps(clock, board, s.id, { speed: 2, tint: 5, muted: true }));
  const n = note(0, 200, "가사");
  commit(setItemOps(clock, board, n.id, { color: "blue", size: 3 }));
  assert.deepEqual(keepOf(board.item(s.id)), { tint: 5, speed: 2, muted: true });
  assert.deepEqual(keepOf(board.item(n.id)), { color: "blue", size: 3 });
  const data = board.item(s.id).data;
  assert.deepEqual(keptFields("song", { speed: 2, tint: 5, muted: true }, data), { tint: 5, speed: 2, muted: true, w: 120 });
  assert.deepEqual(keptFields("song", { speed: 7, tint: 12, color: "blue" }, data), {}, "a wrong speed or colour is left out; a song has no ink colour");
  assert.deepEqual(keptFields("note", { color: "blue", size: 3, speed: 2 }, { text: "가사" }), { color: "blue", size: 3 });
});
