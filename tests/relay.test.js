import test from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/core/crdt.js";
import { GameDoc, askOps, replyOps, quitOps, beginOps, pageOps, turnOps, relayAt, relayDoc, relayTask, relayAlbum, RELAY, COUNTDOWN_MS } from "../src/core/game.js";
import { shuffle, rng } from "./helpers.js";

const apply = (doc, made) => { for (const op of made.ops) doc.apply(op); return made; };

/** A relay asked by m1, joined by the others, begun at `at`. */
function begun(players = ["m1", "m2", "m3"], at = 1000) {
  const doc = new GameDoc();
  const c = new Clock("a");
  const ask = apply(doc, askOps(c, doc, { kind: "relay", by: players[0], at: 0 }));
  players.slice(1).forEach((m, i) => apply(doc, replyOps(c, doc, ask.id, { by: m, yes: true, at: 10 + i })));
  apply(doc, beginOps(c, doc, ask.id, { by: players[0], at }));
  return { doc, c, id: ask.id };
}

test("이어 그리기: friends join the invitation; the asker begins it with who joined; a late yes or someone else's begin changes nothing", () => {
  const doc = new GameDoc();
  const c = new Clock("a");
  const ask = apply(doc, askOps(c, doc, { kind: "relay", by: "m1", at: 0 }));
  apply(doc, replyOps(c, doc, ask.id, { by: "m2", yes: true, at: 10 }));
  apply(doc, replyOps(c, doc, ask.id, { by: "m3", yes: true, at: 20 }));
  apply(doc, replyOps(c, doc, ask.id, { by: "m4", yes: false, at: 30 }));
  let g = doc.game(ask.id);
  assert.equal(g.state, "gathering", "one yes does not begin it: the asker waits for everyone");
  assert.deepEqual(g.players, ["m1", "m2", "m3"]);
  // Changing one's mind before it begins.
  apply(doc, replyOps(c, doc, ask.id, { by: "m3", yes: false, at: 40 }));
  assert.deepEqual(doc.game(ask.id).players, ["m1", "m2"]);
  apply(doc, replyOps(c, doc, ask.id, { by: "m3", yes: true, at: 50 }));
  apply(doc, beginOps(c, doc, ask.id, { by: "m2", at: 900 }));
  assert.equal(doc.game(ask.id).state, "gathering", "only the asker begins it");
  apply(doc, beginOps(c, doc, ask.id, { by: "m1", at: 1000 }));
  apply(doc, replyOps(c, doc, ask.id, { by: "m5", yes: true, at: 1100 }));
  g = doc.game(ask.id);
  assert.equal(g.state, "playing");
  assert.deepEqual(g.players, ["m1", "m2", "m3"], "those who had joined when it began");
  assert.equal(g.start, 1000 + COUNTDOWN_MS, "after the 3·2·1");
  assert.equal(g.rounds, 3, "each book goes once round three people");
  assert.deepEqual(g.schedule.map((s) => s.kind), ["write", "draw", "guess"]);
});

test("each book goes round: in round r the book of player b is with the player r places on; two people still get three rounds", () => {
  const { doc, id } = begun(["m1", "m2", "m3", "m4"]);
  const g = doc.game(id);
  assert.equal(g.rounds, 4);
  assert.deepEqual(g.schedule.map((s) => s.kind), ["write", "draw", "guess", "draw"]);
  assert.deepEqual(relayTask(g, "m1", 0), { book: 0, round: 0, kind: "write", from: null });
  assert.deepEqual(relayTask(g, "m1", 1), { book: 3, round: 1, kind: "draw", from: { book: 3, round: 0 } }, "m1 draws what m4 wrote");
  assert.deepEqual(relayTask(g, "m3", 2), { book: 0, round: 2, kind: "guess", from: { book: 0, round: 1 } }, "m3 guesses the drawing m2 made of m1's words");
  assert.equal(relayTask(g, "m9", 1), null, "not playing");
  const two = begun(["m1", "m2"]).doc;
  assert.equal(two.game(two.list()[0].id).rounds, 3);
});

test("a round ends when everyone has handed in (the last one's moment), or at its time; the next begins a moment later", () => {
  const { doc, c, id } = begun(["m1", "m2", "m3"], 1000);
  let g = doc.game(id);
  const r0 = g.schedule[0];
  assert.equal(r0.start, 1000 + COUNTDOWN_MS);
  assert.equal(r0.end, r0.start + RELAY.write, "nobody has handed in: its full time");
  apply(doc, pageOps(c, doc, id, { by: "m1", round: 0, text: "고양이가 피아노를 친다", at: r0.start + 5000 }));
  apply(doc, pageOps(c, doc, id, { by: "m2", round: 0, text: "바다 위의 기차", at: r0.start + 9000 }));
  assert.equal(doc.game(id).schedule[0].end, r0.start + RELAY.write, "two of three: still its full time");
  apply(doc, pageOps(c, doc, id, { by: "m3", round: 0, text: "구름으로 만든 빵", at: r0.start + 12000 }));
  g = doc.game(id);
  assert.equal(g.schedule[0].end, r0.start + 12000, "all three: it ends then");
  assert.equal(g.schedule[1].start, r0.start + 12000 + RELAY.gap);
  // The drawing round: one person does not hand in; it runs its time.
  const r1 = g.schedule[1];
  apply(doc, pageOps(c, doc, id, { by: "m1", round: 1, at: r1.start + 30000 }));
  apply(doc, pageOps(c, doc, id, { by: "m2", round: 1, at: r1.start + 40000 }));
  g = doc.game(id);
  assert.equal(g.schedule[1].end, r1.start + RELAY.draw);
  // Where things are at a moment.
  assert.equal(relayAt(g, 1500).phase, "countdown");
  assert.deepEqual([relayAt(g, r0.start + 100).phase, relayAt(g, r0.start + 100).round], ["round", 0]);
  assert.equal(relayAt(g, r0.start + 12000 + 10).phase, "between", "the moment the books pass on");
  assert.equal(relayAt(g, g.schedule[2].end + RELAY.gap + 1).phase, "album");
});

test("a page counts from the one whose turn it is, once (the first), in time; words are kept short; a drawing page has its own drawing", () => {
  const { doc, c, id } = begun(["m1", "m2", "m3"], 0);
  const g0 = doc.game(id);
  const start = g0.schedule[0].start;
  apply(doc, pageOps(c, doc, id, { by: "m1", round: 0, text: "  처음 문장  ", at: start + 1 }));
  apply(doc, pageOps(c, doc, id, { by: "m1", round: 0, text: "다시 쓴 것", at: start + 2 }));
  apply(doc, pageOps(c, doc, id, { by: "m2", round: 0, text: "가".repeat(200), at: start + 3 }));
  apply(doc, pageOps(c, doc, id, { by: "m3", round: 0, text: "늦은 것", at: start + RELAY.write + RELAY.grace + 1 }));
  const g = doc.game(id);
  assert.equal(g.pages["0:0"].text, "처음 문장", "the first counts, trimmed");
  assert.equal(g.pages["1:0"].text.length, RELAY.maxText);
  assert.equal(g.pages["2:0"], undefined, "too late: a blank page");
  assert.equal(relayDoc(id, 2, 1), `k:Q${id}~2~1`);
  assert.ok(!relayDoc(id, 2, 1).includes("."), "no dots: a database path takes it");
});

test("the album: every book from its first words to its last page; anyone turns the pages, for everyone; after the last, done", () => {
  const { doc, c, id } = begun(["m1", "m2", "m3"], 0);
  let g = doc.game(id);
  for (const s of g.schedule) for (const m of g.players) apply(doc, pageOps(c, doc, id, { by: m, round: s.r, text: s.kind === "draw" ? undefined : `${m}-${s.r}`, at: doc.game(id).schedule[s.r].start + 1000 }));
  g = doc.game(id);
  const album = relayAlbum(g);
  assert.equal(album.length, 9, "three books of three pages");
  assert.deepEqual(album.slice(0, 3).map((p) => [p.book, p.round, p.by, p.kind]), [[0, 0, "m1", "write"], [0, 1, "m2", "draw"], [0, 2, "m3", "guess"]]);
  assert.equal(album[0].text, "m1-0");
  assert.equal(album[1].doc, relayDoc(id, 0, 1));
  assert.equal(g.turn, -1, "nothing shown yet");
  apply(doc, turnOps(c, doc, id, { by: "m2", n: 0 }));
  apply(doc, turnOps(c, doc, id, { by: "m3", n: 0 }));
  assert.equal(doc.game(id).turn, 0, "two pressing at once turn one page");
  apply(doc, turnOps(c, doc, id, { by: "m9", n: 5 }));
  assert.equal(doc.game(id).turn, 0, "only players turn");
  apply(doc, turnOps(c, doc, id, { by: "m1", n: 9 }));
  g = doc.game(id);
  assert.equal(g.state, "done");
  assert.equal(relayAt(g, Infinity).phase, "done");
});

test("the same game whatever order the ops arrive in", () => {
  const { doc, c, id } = begun(["m1", "m2", "m3", "m4"], 0);
  const g0 = doc.game(id);
  const extra = [];
  for (const s of g0.schedule) for (const m of g0.players.slice(0, 3)) extra.push(...pageOps(c, doc, id, { by: m, round: s.r, text: s.kind === "draw" ? undefined : m + s.r, at: s.start + 500 }).ops);
  extra.push(...turnOps(c, doc, id, { by: "m4", n: 2 }).ops, ...quitOps(c, doc, id, { by: "m4" }).ops);
  for (const op of extra) doc.apply(op);
  const want = JSON.stringify(doc.game(id));
  const all = [...doc.games.get(id).replies, doc.games.get(id).begins[0], ...extra];
  const r = rng(5);
  for (let k = 0; k < 4; k++) {
    const again = new GameDoc();
    again.apply({ t: "ask", id, kind: "relay", by: "m1", at: 0 });
    for (const op of shuffle(r, all)) again.apply(op);
    assert.equal(JSON.stringify(again.game(id)), want);
  }
});
