import test from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/core/crdt.js";
import { GameDoc, askOps, replyOps, beginOps, wordOps, tryOps, sketchAt, sketchHint, sketchDoc, wordsFor, sameWord, nearWord, SKETCH, COUNTDOWN_MS } from "../src/core/game.js";
import { SKETCH_WORDS } from "../src/core/words.js";
import { shuffle, rng } from "./helpers.js";

const apply = (doc, made) => { for (const op of made.ops) doc.apply(op); return made; };

/** 그려서 맞히기 asked by m1, joined by the others, begun at `at`. */
function begun(players = ["m1", "m2", "m3"], at = 1000) {
  const doc = new GameDoc();
  const c = new Clock("a");
  const ask = apply(doc, askOps(c, doc, { kind: "sketch", by: players[0], at: 0 }));
  players.slice(1).forEach((m, i) => apply(doc, replyOps(c, doc, ask.id, { by: m, yes: true, at: 10 + i })));
  apply(doc, beginOps(c, doc, ask.id, { by: players[0], at }));
  return { doc, c, id: ask.id };
}

test("words: many, each once, short enough to draw and to type", () => {
  assert.ok(SKETCH_WORDS.length >= 200, String(SKETCH_WORDS.length));
  assert.equal(new Set(SKETCH_WORDS).size, SKETCH_WORDS.length, "no word twice");
  assert.ok(SKETCH_WORDS.every((w) => /^[가-힣]{1,7}$/.test(w)), "Hangul only, at most seven syllables");
});

test("each turn offers three words, the same on every screen, never one met before in the game", () => {
  const seen = new Set();
  for (let n = 0; n < 20; n++) {
    const three = wordsFor("12@ab", n);
    assert.equal(three.length, 3);
    for (const w of three) {
      assert.ok(SKETCH_WORDS.includes(w));
      assert.ok(!seen.has(w), "met again: " + w);
      seen.add(w);
    }
    assert.deepEqual(wordsFor("12@ab", n), three, "the same again");
  }
  assert.notDeepEqual(wordsFor("12@ab", 0), wordsFor("13@ab", 0), "another game, other words");
});

test("turns: everyone draws in turn (twice round for two or three people); the drawer picks a word, or the first is taken when time runs out", () => {
  const { doc, c, id } = begun(["m1", "m2", "m3"], 1000);
  let g = doc.game(id);
  assert.equal(g.state, "playing");
  assert.equal(g.start, 1000 + COUNTDOWN_MS);
  assert.equal(g.turns, 6);
  assert.deepEqual(g.schedule.map((s) => s.drawer), ["m1", "m2", "m3", "m1", "m2", "m3"]);
  const s0 = g.schedule[0];
  assert.equal(s0.start, g.start);
  assert.equal(s0.chosen, false);
  assert.equal(s0.chosenAt, g.start + SKETCH.choose, "nobody chose: at the end of the choosing time");
  assert.equal(s0.word, wordsFor(id, 0)[0], "the first of the three");
  // The drawer picks the third word 3 s in; someone else's pick, or a word not offered, counts for nothing.
  apply(doc, wordOps(c, doc, id, { by: "m2", n: 0, w: wordsFor(id, 0)[1], at: g.start + 1000 }));
  apply(doc, wordOps(c, doc, id, { by: "m1", n: 0, w: "아무말", at: g.start + 2000 }));
  apply(doc, wordOps(c, doc, id, { by: "m1", n: 0, w: wordsFor(id, 0)[2], at: g.start + 3000 }));
  g = doc.game(id);
  assert.equal(g.schedule[0].word, wordsFor(id, 0)[2]);
  assert.equal(g.schedule[0].chosenAt, g.start + 3000);
  assert.equal(g.schedule[0].end, g.start + 3000 + SKETCH.draw, "then the drawing time");
  assert.equal(g.schedule[1].start, g.schedule[0].end + SKETCH.reveal, "the answer shows a moment, then the next turn");
  const two = begun(["m1", "m2"]).doc;
  assert.equal(two.game(two.list()[0].id).turns, 4);
  const five = begun(["m1", "m2", "m3", "m4", "m5"]).doc;
  assert.equal(five.game(five.list()[0].id).turns, 5);
});

test("guesses: the right word (spaces and case aside) scores more the sooner it comes; the drawer scores for each who got it; the turn ends when all have", () => {
  const { doc, c, id } = begun(["m1", "m2", "m3"], 1000);
  let g = doc.game(id);
  const word = wordsFor(id, 0)[0];
  apply(doc, wordOps(c, doc, id, { by: "m1", n: 0, w: word, at: g.start }));
  g = doc.game(id);
  const t0 = g.schedule[0].chosenAt;
  apply(doc, tryOps(c, doc, id, { by: "m2", n: 0, text: "모르겠다", at: t0 + 5000 }));
  apply(doc, tryOps(c, doc, id, { by: "m2", n: 0, text: " " + word.split("").join(" ") + " ", at: t0 + 10000 }));
  apply(doc, tryOps(c, doc, id, { by: "m1", n: 0, text: word, at: t0 + 11000 }));
  g = doc.game(id);
  assert.deepEqual(g.schedule[0].correct.map((x) => x.by), ["m2"], "the drawer's own try counts for nothing");
  assert.equal(g.schedule[0].end, t0 + SKETCH.draw, "not everyone has it yet");
  const early = g.scores.m2;
  assert.ok(early > 150 && early <= 200, "early: " + early);
  apply(doc, tryOps(c, doc, id, { by: "m3", n: 0, text: word, at: t0 + 70000 }));
  g = doc.game(id);
  assert.ok(g.scores.m3 < early && g.scores.m3 >= 40, "late: " + g.scores.m3);
  assert.equal(g.scores.m1, 2 * SKETCH.drawerPoints, "the drawer, for the two who got it");
  assert.equal(g.schedule[0].end, t0 + 70000, "everyone has it: the turn ends then");
  // What everyone sees of the guesses: the wrong ones as they were typed; the right ones only as "got it".
  const said = g.schedule[0].said;
  assert.deepEqual(said.map((x) => [x.by, x.text ?? null, !!x.got]), [["m2", "모르겠다", false], ["m2", null, true], ["m3", null, true]]);
  // A guess after the turn's time counts for nothing.
  const late = begun(["m1", "m2"], 0);
  const lg = late.doc.game(late.id);
  apply(late.doc, tryOps(late.c, late.doc, late.id, { by: "m2", n: 0, text: lg.schedule[0].word, at: lg.schedule[0].end + SKETCH.grace + 1 }));
  assert.equal(late.doc.game(late.id).scores.m2, 0);
});

test("the same game whatever order the ops come in", () => {
  const { doc, c, id } = begun(["m1", "m2", "m3"], 1000);
  const g0 = doc.game(id);
  const ops = [];
  const keep = (made) => { apply(doc, made); ops.push(...made.ops); };
  keep(wordOps(c, doc, id, { by: "m1", n: 0, w: wordsFor(id, 0)[1], at: g0.start + 500 }));
  const t0 = doc.game(id).schedule[0].chosenAt;
  keep(tryOps(c, doc, id, { by: "m3", n: 0, text: "구름", at: t0 + 2000 }));
  keep(tryOps(c, doc, id, { by: "m2", n: 0, text: wordsFor(id, 0)[1], at: t0 + 4000 }));
  keep(tryOps(c, doc, id, { by: "m3", n: 0, text: wordsFor(id, 0)[1], at: t0 + 9000 }));
  const want = JSON.stringify(doc.game(id));
  const random = rng(7);
  for (let k = 0; k < 5; k++) {
    const other = begun(["m1", "m2", "m3"], 1000).doc;
    for (const op of shuffle(random, ops.slice())) other.apply(op);
    assert.equal(JSON.stringify(other.game(other.list()[0].id)), want.replaceAll(id, other.list()[0].id));
  }
});

test("phases in time: choosing, drawing (how far in), the answer, the scores", () => {
  const { doc, c, id } = begun(["m1", "m2"], 0);
  let g = doc.game(id);
  assert.equal(sketchAt(g, g.start - 10).phase, "countdown");
  assert.deepEqual(sketchAt(g, g.start + 100).phase, "choose");
  apply(doc, wordOps(c, doc, id, { by: "m1", n: 0, w: wordsFor(id, 0)[0], at: g.start + 1000 }));
  g = doc.game(id);
  const s = g.schedule[0];
  const mid = sketchAt(g, s.chosenAt + SKETCH.draw / 2);
  assert.equal(mid.phase, "draw");
  assert.equal(mid.n, 0);
  assert.ok(Math.abs(mid.f - 0.5) < 1e-9);
  assert.equal(sketchAt(g, s.end + 10).phase, "reveal");
  assert.equal(sketchAt(g, g.endAt + 10).phase, "scores");
});

test("초성 hints: blanks first, then every syllable's first sound, then one syllable shown (never the whole of a short word)", () => {
  assert.equal(sketchHint("고양이", 0.1), "○ ○ ○");
  assert.equal(sketchHint("고양이", 0.4), "ㄱ ㅇ ㅇ");
  const late = sketchHint("고양이", 0.8);
  assert.equal(late.split(" ").filter((x) => /[가-힣]/.test(x)).length, 1, "one syllable shown: " + late);
  assert.equal(sketchHint("해", 0.9), "ㅎ", "a one-syllable word keeps only its first sound");
  assert.equal(sketchHint("크리스마스트리", 0.4), "ㅋ ㄹ ㅅ ㅁ ㅅ ㅌ ㄹ");
});

test("right and nearly right", () => {
  assert.ok(sameWord("고양이", " 고 양 이 "));
  assert.ok(sameWord("고양이", "고양이!"));
  assert.ok(!sameWord("고양이", "고양"));
  assert.ok(nearWord("고양이", "고양아"), "one syllable off");
  assert.ok(nearWord("고양이", "고양"), "one missing");
  assert.ok(!nearWord("고양이", "강아지"));
  assert.ok(!nearWord("해", "달"), "a one-syllable word is never nearly right");
  assert.equal(sketchDoc("12@ab", 3), "k:G12@ab~3");
});
