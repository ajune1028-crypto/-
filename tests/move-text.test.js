import test from "node:test";
import assert from "node:assert/strict";
import { Sheet, Clock, ROOT } from "../src/core/crdt.js";
import { spliceOps, invertOps, rangeOps, attachOps, mixOps, moveTextOps } from "../src/core/edit.js";
import { rng, shuffle } from "./helpers.js";

// A sheet with "가나다라마" typed by m1 at time 1, then "바" by m2 at time 2.
function written() {
  const sheet = new Sheet();
  const clock = new Clock("a");
  const log = [];
  const put = (ops) => { for (const op of ops) { sheet.apply(op); log.push(op); } };
  put(spliceOps(sheet, clock, { by: "m1", now: 1 }, [], 0, 0, "가나다라마", false).ops);
  put(spliceOps(sheet, clock, { by: "m2", now: 2 }, sheet.ids(), 5, 0, "바", false).ops);
  return { sheet, clock, log, put };
}

const both = (made) => [...made.from.ops, ...made.to.ops];

test("옮기기: chosen letters go where they are put, each keeping who wrote it and when", () => {
  const s = written();
  const ids = s.sheet.ids();
  // 마 (m1) and 바 (m2) to the very start.
  const made = moveTextOps(s.sheet, s.sheet, s.clock, { ids: [ids[4], ids[5]], after: ROOT });
  s.put(both(made));
  assert.equal(s.sheet.text(), "마바가나다라");
  assert.deepEqual(s.sheet.chars().map((c) => [c.v, c.by, c.at]), [["마", "m1", 1], ["바", "m2", 2], ["가", "m1", 1], ["나", "m1", 1], ["다", "m1", 1], ["라", "m1", 1]]);
  assert.deepEqual(made.ids, s.sheet.ids().slice(0, 2), "the letters at their new place");
  // Into the middle: 가 after 다.
  const now = s.sheet.ids();
  s.put(both(moveTextOps(s.sheet, s.sheet, s.clock, { ids: [now[2]], after: now[4] })));
  assert.equal(s.sheet.text(), "마바나다가라");
});

test("옮기기: one undo puts them back, redo moves them again; the same on every device in any order", () => {
  const s = written();
  const ids = s.sheet.ids();
  const made = moveTextOps(s.sheet, s.sheet, s.clock, { ids: [ids[1], ids[2]], after: ids[5] });
  s.put(both(made));
  assert.equal(s.sheet.text(), "가라마바나다");
  const atoms = [...made.from.atoms, ...made.to.atoms];
  s.put(invertOps(s.sheet, s.clock, atoms, "undo"));
  assert.equal(s.sheet.text(), "가나다라마바");
  assert.deepEqual(s.sheet.chars().map((c) => c.by), ["m1", "m1", "m1", "m1", "m1", "m2"]);
  s.put(invertOps(s.sheet, s.clock, atoms, "redo"));
  assert.equal(s.sheet.text(), "가라마바나다");
  for (const seed of [1, 2, 3, 4]) {
    const other = new Sheet();
    for (const op of shuffle(rng(seed), s.log)) other.apply(op);
    assert.equal(other.text(), s.sheet.text(), "seed " + seed);
    assert.deepEqual(other.chars().map((c) => c.by), s.sheet.chars().map((c) => c.by));
  }
});

test("옮기기: the 표시, photos and colour mixing lying wholly on the moved letters go with them; one only partly on them stays", () => {
  const s = written();
  const ids = s.sheet.ids();
  const inside = rangeOps(s.sheet, s.clock, "mark", { ch: ids[1], to: ids[2], c: "yellow", by: "m2", at: 7 });
  const partly = rangeOps(s.sheet, s.clock, "mark", { ch: ids[0], to: ids[1], c: "blue", by: "m1", at: 8 });
  const photo = attachOps(s.sheet, s.clock, { ch: ids[2], to: ids[2], data: "data:image/png;base64,AAAA", w: 4, h: 3, by: "m1", at: 9 });
  const mix = mixOps(s.sheet, s.clock, ids[1]);
  s.put([...inside.ops, ...partly.ops, ...photo.ops, ...mix.ops]);
  const made = moveTextOps(s.sheet, s.sheet, s.clock, { ids: [ids[1], ids[2]], after: ids[5] });
  s.put(both(made));
  assert.equal(s.sheet.text(), "가라마바나다");
  const [na, da] = made.ids;
  const marks = s.sheet.marks();
  assert.deepEqual(marks.map((m) => [m.ch, m.to, m.c, m.by, m.at]).sort(), [[ids[0], ids[1], "blue", "m1", 8], [na, da, "yellow", "m2", 7]].sort());
  const atts = s.sheet.attachments();
  assert.equal(atts.length, 1);
  assert.deepEqual([atts[0].ch, atts[0].to, atts[0].data, atts[0].w, atts[0].h, atts[0].by], [da, da, "data:image/png;base64,AAAA", 4, 3, "m1"]);
  assert.equal(s.sheet.mixLevel(na), 1, "the mixed word stays mixed");
  // Undo brings the 표시 and the photo back to where they were.
  s.put(invertOps(s.sheet, s.clock, [...made.from.atoms, ...made.to.atoms], "undo"));
  assert.deepEqual(s.sheet.marks().map((m) => [m.ch, m.to, m.c]).sort(), [[ids[0], ids[1], "blue"], [ids[1], ids[2], "yellow"]].sort());
  assert.deepEqual(s.sheet.attachments().map((a) => [a.ch, a.to]), [[ids[2], ids[2]]]);
});

test("옮기기: to another day's page; a place among the moved letters themselves moves nothing", () => {
  const s = written();
  const ids = s.sheet.ids();
  const other = new Sheet();
  const clock2 = new Clock("b");
  for (const op of spliceOps(other, clock2, { by: "m3", now: 5 }, [], 0, 0, "하하", false).ops) other.apply(op);
  const made = moveTextOps(s.sheet, other, s.clock, { ids: [ids[0], ids[1]], after: other.ids()[0] });
  for (const op of made.from.ops) s.sheet.apply(op);
  for (const op of made.to.ops) other.apply(op);
  assert.equal(s.sheet.text(), "다라마바");
  assert.equal(other.text(), "하가나하");
  assert.deepEqual(other.chars().map((c) => c.by), ["m3", "m1", "m1", "m3"]);
  const none = moveTextOps(s.sheet, s.sheet, s.clock, { ids: [s.sheet.ids()[0], s.sheet.ids()[1]], after: s.sheet.ids()[0] });
  assert.equal(both(none).length, 0);
  assert.deepEqual(none.ids, []);
  // Put down where they already are (right after the letter before them): nothing either.
  const left = s.sheet.ids();
  assert.equal(both(moveTextOps(s.sheet, s.sheet, s.clock, { ids: [left[1], left[2]], after: left[0] })).length, 0);
  assert.equal(both(moveTextOps(s.sheet, s.sheet, s.clock, { ids: [left[0]], after: ROOT })).length, 0);
});
