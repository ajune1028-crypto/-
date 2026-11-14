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
