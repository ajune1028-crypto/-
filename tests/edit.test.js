import test from "node:test";
import assert from "node:assert/strict";
import { Clock, Sheet } from "../src/core/crdt.js";
import { diffText, spliceOps, mixOps, invertOps } from "../src/core/edit.js";
import { UndoStack } from "../src/core/undo.js";
import { rng, shuffle } from "./helpers.js";

/** A stand-in for the editor: keeps the ids of what its input box shows. */
function writer(replica, by, sheet = new Sheet()) {
  const w = { sheet, clock: new Clock(replica), by, ids: sheet.ids().slice(), log: [] };
  w.splice = (index, del, ins, composing = false, now = 0) => {
    const r = spliceOps(w.sheet, w.clock, { by, now }, w.ids, index, del, ins, composing);
    w.sheet.applyAll(r.ops);
    w.ids = r.ids;
    w.log.push(...r.ops);
    return r;
  };
  w.pull = () => { w.ids = w.sheet.ids().slice(); };
  return w;
}

test("diffText finds one splice", () => {
  assert.deepEqual(diffText("abc", "abXc"), { index: 2, del: 0, ins: "X" });
  assert.deepEqual(diffText("abc", "ac"), { index: 1, del: 1, ins: "" });
  assert.deepEqual(diffText("abc", "aXYc"), { index: 1, del: 1, ins: "XY" });
  assert.deepEqual(diffText("", "가"), { index: 0, del: 0, ins: "가" });
  assert.deepEqual(diffText("same", "same"), { index: 4, del: 0, ins: "" });
});

test("diffText uses the caret among repeated characters", () => {
  assert.deepEqual(diffText("aaa", "aaaa", 2), { index: 1, del: 0, ins: "a" });
  assert.deepEqual(diffText("aaa", "aa", 1), { index: 1, del: 1, ins: "" });
  assert.deepEqual(diffText("aaa", "aaaa"), { index: 3, del: 0, ins: "a" });
});

test("composition replaces in place: one node, text 한", () => {
  const w = writer("a", "A");
  w.splice(0, 0, "ㅎ", true);
  w.splice(0, 1, "하", true);
  w.splice(0, 1, "한", true);
  assert.equal(w.sheet.text(), "한");
  assert.equal(w.sheet.size, 1);
});

test("composition that grows sets the first char and inserts the rest", () => {
  const w = writer("a", "A");
  w.splice(0, 0, "한", true);
  w.splice(0, 1, "하나", true);
  assert.equal(w.sheet.text(), "하나");
  assert.equal(w.sheet.size, 2);
  assert.deepEqual(w.ids, w.sheet.ids());
});

test("composition over someone else's char falls back to delete + insert", () => {
  const sheet = new Sheet();
  const b = writer("b", "B", sheet);
  b.splice(0, 0, "x");
  const a = writer("a", "A", sheet);
  a.splice(0, 1, "y", true);
  assert.equal(sheet.text(), "y");
  assert.equal(sheet.size, 2);
  assert.equal(sheet.chars()[0].by, "A");
});

test("outside composition a replacement never rewrites a char in place", () => {
  const w = writer("a", "A");
  w.splice(0, 0, "ab");
  w.splice(0, 1, "c", false);
  assert.equal(w.sheet.text(), "cb");
  assert.equal(w.sheet.size, 3);
});

test("random splices keep the id list aligned with the text", () => {
  const r = rng(7);
  const w = writer("a", "A");
  for (let i = 0; i < 300; i++) {
    const len = w.sheet.text().length;
    const index = Math.floor(r() * (len + 1));
    const del = Math.min(len - index, Math.floor(r() * 3));
    const ins = r() < 0.7 ? ["가", "ab", " ", "\n", ""][Math.floor(r() * 5)] : "";
    w.splice(index, del, ins, r() < 0.3);
    assert.deepEqual(w.ids, w.sheet.ids());
    assert.equal(w.ids.length, w.sheet.text().length);
  }
});

test("an emoji stays two adjacent units and round-trips", () => {
  const w = writer("a", "A");
  w.splice(0, 0, "a😀b");
  assert.equal(w.sheet.text(), "a😀b");
  assert.equal(w.sheet.size, 4);
});

test("a 5,000-character paste applies and converges on a second sheet", () => {
  const text = "가나다 ".repeat(1250);
  const w = writer("a", "A");
  w.splice(0, 0, text);
  assert.equal(w.sheet.text(), text);
  const other = new Sheet();
  other.applyAll(shuffle(rng(3), w.log));
  assert.equal(other.text(), text);
  assert.equal(other.pendingCount, 0);
});

test("deleting a char that someone already deleted makes no op", () => {
  const sheet = new Sheet();
  const a = writer("a", "A", sheet);
  a.splice(0, 0, "ab");
  const b = writer("b", "B", sheet);
  b.splice(0, 1, "");
  const r = a.splice(0, 1, "");
  assert.equal(r.ops.length, 0);
  assert.equal(sheet.text(), "b");
  assert.deepEqual(a.ids, sheet.ids());
});

test("mix cycles 0 → 1 → 2 → 0", () => {
  const w = writer("a", "A");
  w.splice(0, 0, "a");
  const levels = [];
  for (let i = 0; i < 3; i++) {
    w.sheet.applyAll(mixOps(w.sheet, w.clock, w.ids[0]).ops);
    levels.push(w.sheet.mixLevel(w.ids[0]));
  }
  assert.deepEqual(levels, [1, 2, 0]);
});

test("undo removes only my typing and redo restores it", () => {
  const sheet = new Sheet();
  const a = writer("a", "A", sheet);
  const b = writer("b", "B", sheet);
  const typed = a.splice(0, 0, "abc");
  b.pull();
  b.splice(1, 0, "XY");
  assert.equal(sheet.text(), "aXYbc");
  sheet.applyAll(invertOps(sheet, a.clock, typed.atoms, "undo"));
  assert.equal(sheet.text(), "XY");
  sheet.applyAll(invertOps(sheet, a.clock, typed.atoms, "redo"));
  assert.equal(sheet.text(), "aXYbc");
});

test("undo of a delete restores it, undo of a set restores the value, undo of a mix restores the level", () => {
  const w = writer("a", "A");
  w.splice(0, 0, "ab");
  const del = w.splice(0, 1, "");
  w.sheet.applyAll(invertOps(w.sheet, w.clock, del.atoms, "undo"));
  assert.equal(w.sheet.text(), "ab");
  w.pull();
  const set = w.splice(1, 1, "c", true);
  assert.equal(w.sheet.text(), "ac");
  w.sheet.applyAll(invertOps(w.sheet, w.clock, set.atoms, "undo"));
  assert.equal(w.sheet.text(), "ab");
  const mix = mixOps(w.sheet, w.clock, w.ids[0]);
  w.sheet.applyAll(mix.ops);
  w.sheet.applyAll(invertOps(w.sheet, w.clock, mix.atoms, "undo"));
  assert.equal(w.sheet.mixLevel(w.ids[0]), 0);
});

test("undoing a step that typed then deleted the same char leaves it hidden", () => {
  const w = writer("a", "A");
  const first = w.splice(0, 0, "x");
  const second = w.splice(0, 1, "");
  const atoms = [...first.atoms, ...second.atoms];
  w.sheet.applyAll(invertOps(w.sheet, w.clock, atoms, "undo"));
  assert.equal(w.sheet.text(), "");
  w.sheet.applyAll(invertOps(w.sheet, w.clock, atoms, "redo"));
  assert.equal(w.sheet.text(), "");
});

test("typing within 1000 ms merges into one undo step and a pause splits", () => {
  const u = new UndoStack();
  u.record([{ k: "ins", ids: ["1@a"] }], { now: 0, typing: true });
  u.record([{ k: "ins", ids: ["2@a"] }], { now: 900, typing: true });
  u.record([{ k: "ins", ids: ["3@a"] }], { now: 2500, typing: true });
  assert.equal(u.undo().length, 1);
  assert.equal(u.undo().length, 2);
  assert.equal(u.undo(), null);
});

test("steps that are not typing never merge, and a new record clears redo", () => {
  const u = new UndoStack();
  u.record([{ k: "mix", ch: "1@a", prev: 0, next: 1 }], { now: 0, typing: false });
  u.record([{ k: "mix", ch: "1@a", prev: 1, next: 2 }], { now: 10, typing: false });
  assert.equal(u.undo().length, 1);
  assert.equal(u.canRedo, true);
  u.record([{ k: "ins", ids: ["2@a"] }], { now: 20, typing: true });
  assert.equal(u.canRedo, false);
  assert.equal(u.redo(), null);
});

test("typing after an undo starts a new step", () => {
  const u = new UndoStack();
  u.record([{ k: "ins", ids: ["1@a"] }], { now: 0, typing: true });
  u.record([{ k: "ins", ids: ["2@a"] }], { now: 2000, typing: true });
  u.undo();
  u.record([{ k: "ins", ids: ["3@a"] }], { now: 2100, typing: true });
  assert.equal(u.undo().length, 1);
  assert.equal(u.undo().length, 1);
});

test("undo depth is 100", () => {
  const u = new UndoStack();
  for (let i = 0; i < 150; i++) u.record([{ k: "ins", ids: [i + 1 + "@a"] }], { now: i, typing: false });
  let n = 0;
  while (u.undo()) n++;
  assert.equal(n, 100);
});

// One line drawn in pieces (its look changed mid-line, the day's plan 1): its parts are one step back,
// however slowly it was drawn; another line is a step of its own.
test("undo steps of one group stay one step whatever the time between them", () => {
  const u = new UndoStack();
  u.record([{ k: "a" }], { now: 0, typing: false, group: "g1" });
  u.record([{ k: "b" }], { now: 5000, typing: false, group: "g1" });
  u.record([{ k: "c" }], { now: 5100, typing: false, group: "g2" });
  assert.deepEqual(u.undo().map((a) => a.k), ["c"]);
  assert.deepEqual(u.undo().map((a) => a.k), ["a", "b"]);
});
