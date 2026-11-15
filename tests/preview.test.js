import test from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/core/crdt.js";
import { SongDoc, sourceOp, addClipOps, setClipOps } from "../src/core/song.js";
import { BoardDoc, addItemOps, songCardData } from "../src/core/board.js";
import { textPreview, songPreview, boardPreview, validPreview } from "../src/core/preview.js";

test("a text room shows the last line written on the latest sheet that has words", () => {
  assert.deepEqual(textPreview(["옛날 글", "첫 줄\n\n  둘째 줄  \n", ""]), { t: "text", line: "둘째 줄" });
  assert.deepEqual(textPreview(["어제 쓴 것", "   \n"]), { t: "text", line: "어제 쓴 것" });
  assert.equal(textPreview(["", "\n"]), null);
  const long = textPreview(["가".repeat(200)]);
  assert.ok(long.line.length <= 60 && long.line.endsWith("…"), long.line);
});

function song() {
  const doc = new SongDoc();
  const clock = new Clock("a");
  const commit = (ops) => { for (const op of ops) doc.apply(op); };
  const notes = [{ t: 0, d: 0.5, p: 60, v: 0.8 }, { t: 0.5, d: 0.5, p: 67, v: 0.8 }, { t: 1, d: 1, p: 64, v: 0.8 }];
  const src = sourceOp(clock, doc, { duration: 2, notes, peaks: "", by: "m1", at: 1 });
  commit([src]);
  return { doc, clock, commit, src: src.id };
}

test("a song room shows its notes as bars along the song, the highest at the top", () => {
  const { doc, clock, commit, src } = song();
  assert.equal(songPreview(doc), null, "nothing yet");
  commit(addClipOps(clock, doc, { src, row: 0, start: 0, length: 2000, by: "m1", at: 2 }).ops);
  const p = songPreview(doc);
  assert.equal(p.t, "song");
  // [x, width, y]: x and width in thousandths of the shown length, y 0 (top) to 100 (bottom).
  assert.deepEqual(p.notes, [[0, 250, 100], [250, 250, 0], [500, 500, 43]]);
});

test("a song preview leaves out muted clips, and a song with no notes shows its clips", () => {
  const { doc, clock, commit, src } = song();
  const a = addClipOps(clock, doc, { src, row: 0, start: 0, length: 2000, by: "m1", at: 2 });
  commit(a.ops);
  commit(setClipOps(clock, doc, a.id, { muted: true }).ops);
  const p = songPreview(doc);
  assert.deepEqual(p.notes, []);
  assert.deepEqual(p.clips, [[0, 1000, 0]]);
});

test("a long song shows its first 24 seconds, at most 48 bars", () => {
  const doc = new SongDoc();
  const clock = new Clock("a");
  const notes = Array.from({ length: 120 }, (_, i) => ({ t: i * 0.5, d: 0.4, p: 60 + (i % 5), v: 0.8 }));
  const src = sourceOp(clock, doc, { duration: 60, notes, peaks: "", by: "m1", at: 1 });
  doc.apply(src);
  for (const op of addClipOps(clock, doc, { src: src.id, row: 0, start: 0, length: 60000, by: "m1", at: 2 }).ops) doc.apply(op);
  const p = songPreview(doc);
  assert.equal(p.notes.length, 48);
  assert.ok(p.notes.every(([x, w]) => x >= 0 && x + w <= 1000));
});

test("a board shows its cards as a small map that keeps their places", () => {
  const board = new BoardDoc();
  const clock = new Clock("a");
  const commit = (made) => { for (const op of made.ops) board.apply(op); return made; };
  assert.equal(boardPreview(board), null);
  commit(addItemOps(clock, board, { kind: "song", x: 0, y: 0, data: songCardData({ duration: 2, notes: [], peaks: "" }), by: "m1" }));
  commit(addItemOps(clock, board, { kind: "note", x: 400, y: 300, data: { text: "메모" }, by: "m1" }));
  const p = boardPreview(board);
  assert.equal(p.t, "board");
  assert.equal(p.cards.length, 2);
  const [songCard, note] = p.cards;
  assert.equal(songCard[4], "s");
  assert.equal(note[4], "n");
  assert.ok(note[0] > songCard[0] && note[1] > songCard[1], "the note stays right of and below the song");
  assert.ok(p.cards.every(([x, y, w, h]) => x >= 0 && y >= 0 && x + w <= 100 && y + h <= 60), JSON.stringify(p.cards));
  // A board smaller than the map sits in its middle.
  const left = Math.min(...p.cards.map((c) => c[0]));
  const right = 100 - Math.max(...p.cards.map((c) => c[0] + c[2]));
  assert.ok(Math.abs(left - right) <= 1, `centred: ${left} | ${right}`);
});

test("a kept preview is checked before home draws it", () => {
  assert.ok(validPreview({ t: "text", line: "안녕" }));
  assert.ok(validPreview({ t: "song", notes: [[0, 10, 50]], clips: [] }));
  assert.ok(validPreview({ t: "board", cards: [[0, 0, 10, 10, "s"]] }));
  assert.ok(!validPreview({ t: "text", line: 5 }));
  assert.ok(!validPreview({ t: "song", notes: "x" }));
  assert.ok(!validPreview({ t: "board", cards: [[0, 0, 10, 10, "zz"]] }));
  assert.ok(!validPreview({ t: "other" }));
  assert.ok(!validPreview(null));
});
