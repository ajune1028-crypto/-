import test from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/core/crdt.js";
import { GameDoc, askOps, replyOps, pickOps, stoneOps, quitOps, rpsWinner, OMOK_SIZE, COUNTDOWN_MS } from "../src/core/game.js";
import { shuffle, rng } from "./helpers.js";

const apply = (doc, made) => { for (const op of made.ops) doc.apply(op); return made; };

test("an invitation, answered yes, begins a game at the same moment for both after the 3·2·1", () => {
  const doc = new GameDoc();
  const ca = new Clock("a");
  const ask = apply(doc, askOps(ca, doc, { kind: "rps", by: "m1", at: 1000 }));
  assert.equal(doc.game(ask.id).state, "asked");
  const cb = new Clock("b");
  cb.atLeast(doc.maxN);
  apply(doc, replyOps(cb, doc, ask.id, { by: "m2", yes: true, at: 2000 }));
  const g = doc.game(ask.id);
  assert.equal(g.state, "playing");
  assert.deepEqual(g.players, ["m1", "m2"]);
  assert.equal(g.start, 2000 + COUNTDOWN_MS, "it begins after the countdown");
  assert.ok(COUNTDOWN_MS >= 3000 && COUNTDOWN_MS <= 4500);
  // A second "yes" from someone else changes nothing: two play.
  apply(doc, replyOps(cb, doc, ask.id, { by: "m3", yes: true, at: 2100 }));
  assert.deepEqual(doc.game(ask.id).players, ["m1", "m2"]);
});

test("an invitation answered no, or by its own asker, does not begin", () => {
  const doc = new GameDoc();
  const c = new Clock("a");
  const ask = apply(doc, askOps(c, doc, { kind: "omok", by: "m1", at: 1 }));
  apply(doc, replyOps(c, doc, ask.id, { by: "m1", yes: true, at: 2 }));
  assert.equal(doc.game(ask.id).state, "asked", "one cannot accept one's own invitation");
  apply(doc, replyOps(c, doc, ask.id, { by: "m2", yes: false, at: 3 }));
  assert.equal(doc.game(ask.id).state, "declined");
});

test("가위바위보: both pick, the winner is plain; a second pick changes nothing", () => {
  assert.equal(rpsWinner("rock", "scissors"), 0);
  assert.equal(rpsWinner("rock", "paper"), 1);
  assert.equal(rpsWinner("paper", "paper"), -1);
  const doc = new GameDoc();
  const c = new Clock("a");
  const ask = apply(doc, askOps(c, doc, { kind: "rps", by: "m1", at: 1 }));
  apply(doc, replyOps(c, doc, ask.id, { by: "m2", yes: true, at: 2 }));
  apply(doc, pickOps(c, doc, ask.id, { by: "m2", v: "paper" }));
  assert.equal(doc.game(ask.id).state, "playing", "one pick: still waiting for the other");
  apply(doc, pickOps(c, doc, ask.id, { by: "m1", v: "rock" }));
  apply(doc, pickOps(c, doc, ask.id, { by: "m1", v: "scissors" }));
  const g = doc.game(ask.id);
  assert.equal(g.state, "done");
  assert.deepEqual(g.picks, { m1: "rock", m2: "paper" }, "the first pick counts");
  assert.equal(g.winner, "m2");
});

test("오목: turns alternate (the asker black first), a stone out of turn or on a taken point is not played, five in a row wins", () => {
  const doc = new GameDoc();
  const c = new Clock("a");
  const ask = apply(doc, askOps(c, doc, { kind: "omok", by: "m1", at: 1 }));
  apply(doc, replyOps(c, doc, ask.id, { by: "m2", yes: true, at: 2 }));
  const play = (by, x, y) => apply(doc, stoneOps(c, doc, ask.id, { by, x, y }));
  play("m1", 7, 7);
  play("m1", 8, 8); // out of turn
  assert.equal(doc.game(ask.id).stones.length, 1);
  play("m2", 7, 7); // taken
  assert.equal(doc.game(ask.id).stones.length, 1);
  for (let i = 1; i <= 4; i++) {
    play("m2", 0, i);
    play("m1", 7 + i, 7); // black: (7..11, 7)
  }
  const g = doc.game(ask.id);
  assert.equal(g.state, "done");
  assert.equal(g.winner, "m1");
  assert.deepEqual(g.line.map(([x, y]) => [x, y]), [[7, 7], [8, 7], [9, 7], [10, 7], [11, 7]]);
  play("m2", 3, 3);
  assert.equal(doc.game(ask.id).stones.length, 9, "nothing after the end");
  assert.equal(OMOK_SIZE, 15);
});

test("오목: diagonal five wins; two devices placing the same move at once agree on which counts, whatever order they arrive in", () => {
  const ca = new Clock("a");
  const cb = new Clock("b");
  const src = new GameDoc();
  const ops = [];
  const take = (made) => { for (const op of made.ops) { src.apply(op); ops.push(op); } return made; };
  const ask = take(askOps(ca, src, { kind: "omok", by: "m1", at: 1 }));
  take(replyOps(cb, src, ask.id, { by: "m2", yes: true, at: 2 }));
  // Black plays the diagonal; white elsewhere. Two black stones "at once" for move 0: one counts.
  const first = stoneOps(ca, src, ask.id, { by: "m1", x: 2, y: 2 });
  const rival = { ...stoneOps(cb, src, ask.id, { by: "m1", x: 9, y: 9 }).ops[0] };
  take(first);
  src.apply(rival);
  ops.push(rival);
  for (let i = 1; i <= 4; i++) {
    take(stoneOps(cb, src, ask.id, { by: "m2", x: 14, y: i }));
    take(stoneOps(ca, src, ask.id, { by: "m1", x: 2 + i, y: 2 + i }));
  }
  const want = src.game(ask.id);
  assert.equal(want.winner, "m1");
  const random = rng(5);
  for (let k = 0; k < 15; k++) {
    const d = new GameDoc();
    d.applyAll(shuffle(random, ops.slice()));
    const g = d.game(ask.id);
    assert.deepEqual([g.state, g.winner, g.stones.map((s) => [s.x, s.y])], [want.state, want.winner, want.stones.map((s) => [s.x, s.y])]);
  }
});

test("someone who leaves ends the game; the tally counts who won what between two people", () => {
  const doc = new GameDoc();
  const c = new Clock("a");
  const one = apply(doc, askOps(c, doc, { kind: "rps", by: "m1", at: 1 }));
  apply(doc, replyOps(c, doc, one.id, { by: "m2", yes: true, at: 2 }));
  apply(doc, pickOps(c, doc, one.id, { by: "m1", v: "rock" }));
  apply(doc, pickOps(c, doc, one.id, { by: "m2", v: "scissors" }));
  const two = apply(doc, askOps(c, doc, { kind: "omok", by: "m2", at: 3 }));
  apply(doc, replyOps(c, doc, two.id, { by: "m1", yes: true, at: 4 }));
  apply(doc, quitOps(c, doc, two.id, { by: "m2" }));
  assert.equal(doc.game(two.id).state, "done");
  assert.equal(doc.game(two.id).winner, "m1", "the one who stays wins");
  assert.deepEqual(doc.tally("m1", "m2"), { m1: 2, m2: 0, draws: 0 });
});

test("nonsense is set aside", () => {
  const doc = new GameDoc();
  assert.equal(doc.apply({ t: "ask", id: "1@x", kind: "chess", by: "m", at: 1 }), "unknown");
  assert.equal(doc.apply({ t: "pick", id: "2@x", g: "9@x", by: "m", v: "lizard" }), "unknown");
  assert.equal(doc.apply({ t: "stone", id: "3@x", g: "9@x", by: "m", x: 15, y: 0, n: 0 }), "unknown");
});
