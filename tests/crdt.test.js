import test from "node:test";
import assert from "node:assert/strict";
import { ROOT, makeId, cmpId, Clock, Sheet } from "../src/core/crdt.js";
import { rng, pick, shuffle, permutations } from "./helpers.js";

const ins = (id, after, v, by = "A", at = 1) => ({ t: "ins", id, after, v, by, at });
const feed = (ops) => { const s = new Sheet(); for (const o of ops) s.apply(o); return s; };

test("ids order by number first, then replica, and ROOT is lowest", () => {
  assert.equal(makeId(3, "ab"), "3@ab");
  assert.equal(cmpId("2@a", "10@a"), -1);
  assert.equal(cmpId("2@b", "2@a"), 1);
  assert.equal(cmpId("2@a", "2@a"), 0);
  assert.equal(cmpId(ROOT, "1@a"), -1);
});

test("clock.next is greater than everything it has seen", () => {
  const c = new Clock("a");
  assert.equal(c.next(), "1@a");
  c.see("41@zz");
  assert.equal(c.next(), "42@a");
  c.see("7@b");
  assert.equal(c.next(), "43@a");
});

test("concurrent inserts after the same char converge with the greater id first", () => {
  const ops = [ins("1@a", ROOT, "x"), ins("2@b", "1@a", "b"), ins("2@c", "1@a", "c")];
  for (const order of permutations(ops)) assert.equal(feed(order).text(), "xcb");
});

test("two people typing at the same spot do not interleave", () => {
  const ops = [ins("1@a", ROOT, "a"), ins("2@a", "1@a", "b"), ins("1@b", ROOT, "1"), ins("2@b", "1@b", "2")];
  for (const order of permutations(ops)) assert.equal(feed(order).text(), "12ab");
});

test("delete and restore: the larger counter wins and odd hides", () => {
  const s = feed([ins("1@a", ROOT, "x"), ins("2@a", "1@a", "y")]);
  s.apply({ t: "vis", id: "3@a", ch: "1@a", n: 1 });
  assert.equal(s.text(), "y");
  s.apply({ t: "vis", id: "4@b", ch: "1@a", n: 2 });
  assert.equal(s.text(), "xy");
  s.apply({ t: "vis", id: "5@c", ch: "1@a", n: 1 });
  assert.equal(s.text(), "xy");
  assert.equal(s.size, 2);
});

test("set is last-writer-wins and keeps one node", () => {
  const base = ins("1@a", ROOT, "ㅎ");
  const sets = [{ t: "set", id: "2@a", ch: "1@a", v: "하" }, { t: "set", id: "3@a", ch: "1@a", v: "한" }];
  for (const order of permutations([base, ...sets])) {
    const s = feed(order);
    assert.equal(s.text(), "한");
    assert.equal(s.size, 1);
  }
});

test("ops arriving before their char wait, then apply", () => {
  const s = new Sheet();
  assert.equal(s.apply(ins("2@a", "1@a", "b")), "pending");
  assert.equal(s.apply({ t: "vis", id: "3@a", ch: "2@a", n: 1 }), "pending");
  assert.equal(s.pendingCount, 2);
  assert.equal(s.text(), "");
  assert.equal(s.apply(ins("1@a", ROOT, "a")), "applied");
  assert.equal(s.text(), "a");
  assert.equal(s.pendingCount, 0);
  assert.equal(s.apply(ins("1@a", ROOT, "a")), "dup");
});

test("unknown and malformed ops are kept aside without throwing", () => {
  const s = feed([ins("1@a", ROOT, "a")]);
  const bad = [{ t: "zzz", id: "9@a" }, ins("2@a", "1@a", "ab"), { t: "ins", after: ROOT, v: "q" }, null, 7,
    ins("1@b", "5@a", "q"), { t: "vis", id: "3@a", ch: "1@a", n: -1 }, { t: "mix", id: "4@a", ch: "1@a", lv: 9 }];
  for (const op of bad) assert.equal(s.apply(op), "unknown");
  assert.equal(s.text(), "a");
  assert.equal(s.unknown.length, bad.length);
});

test("wrong clocks do not change order", () => {
  const s = feed([ins("1@a", ROOT, "a", "A", 9e15), ins("2@a", "1@a", "b", "A", 0)]);
  assert.equal(s.text(), "ab");
  assert.deepEqual(s.chars().map((c) => c.at), [9e15, 0]);
});

test("mix level is last-writer-wins per char", () => {
  const s = feed([ins("1@a", ROOT, "a"), { t: "mix", id: "5@b", ch: "1@a", lv: 2 }, { t: "mix", id: "3@a", ch: "1@a", lv: 1 }]);
  assert.equal(s.mixLevel("1@a"), 2);
  assert.equal(s.mixLevel("9@x"), 0);
});

test("indexAfter maps a char id to the caret position after it, hidden chars included", () => {
  const s = feed([ins("1@a", ROOT, "a"), ins("2@a", "1@a", "b"), ins("3@a", "2@a", "c"), { t: "vis", id: "4@a", ch: "2@a", n: 1 }]);
  assert.equal(s.text(), "ac");
  assert.equal(s.indexAfter(ROOT), 0);
  assert.equal(s.indexAfter("1@a"), 1);
  assert.equal(s.indexAfter("2@a"), 1);
  assert.equal(s.indexAfter("3@a"), 2);
});

test("random scenarios converge", () => {
  for (let run = 0; run < 1000; run++) {
    const r = rng(run + 1);
    const reps = ["a", "b", "c"].map((name) => ({ name, clock: new Clock(name), sheet: new Sheet(), all: [] }));
    const log = [];
    const emit = (rep, op) => { rep.sheet.apply(op); log.push(op); };
    for (let step = 0; step < 40; step++) {
      const rep = pick(r, reps);
      const ids = rep.sheet.ids();
      const known = [...rep.sheet.nodes.keys()].filter((k) => k !== ROOT);
      const x = r();
      if (x < 0.5 || known.length === 0) {
        const i = Math.floor(r() * (ids.length + 1));
        emit(rep, ins(rep.clock.next(), i === 0 ? ROOT : ids[i - 1], pick(r, ["가", "a", " ", "\n", "z"]), rep.name, step));
      } else if (x < 0.7) {
        const ch = pick(r, known);
        emit(rep, { t: "vis", id: rep.clock.next(), ch, n: rep.sheet.get(ch).rm + 1 });
      } else if (x < 0.85) {
        emit(rep, { t: "set", id: rep.clock.next(), ch: pick(r, known), v: pick(r, ["한", "q"]) });
      } else {
        emit(rep, { t: "mix", id: rep.clock.next(), ch: pick(r, known), lv: Math.floor(r() * 3) });
      }
      if (r() < 0.3) {
        const other = pick(r, reps);
        for (const op of shuffle(r, log).slice(0, 5)) { other.sheet.apply(op); other.clock.see(op.id); }
      }
    }
    for (const rep of reps) for (const op of shuffle(r, [...log, ...log.slice(0, 7)])) rep.sheet.apply(op);
    const [a, b, c] = reps.map((x) => x.sheet);
    for (const s of [b, c]) {
      assert.equal(s.text(), a.text(), `run ${run}`);
      assert.deepEqual(s.ids(), a.ids(), `run ${run}`);
      assert.equal(s.pendingCount, 0);
      for (const id of a.nodes.keys()) assert.equal(s.mixLevel(id), a.mixLevel(id));
    }
  }
});
