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

// The owner (21 November): "그림 모드나 애니 모드도 미리보기도 나오게 해 줘라".
test("a drawing shows a few of its lines in its own colours, fitted into the small box; hidden layers and erasing are left out", async () => {
  const { drawPreview } = await import("../src/core/preview.js");
  const line = (x0, y0, x1, y1, extra = {}) => ({ pts: Array.from({ length: 30 }, (_, i) => [x0 + ((x1 - x0) * i) / 29, y0 + ((y1 - y0) * i) / 29, 50]).flat(), c: "#d93a3a", w: 1, ...extra });
  const p = drawPreview([
    { visible: true, strokes: [line(100, 100, 1100, 600), line(100, 600, 1100, 100, { c: "blue" }), line(300, 300, 400, 400, { b: "erase" })] },
    { visible: false, strokes: [line(0, 0, 2000, 2000, { c: "green" })] },
  ]);
  assert.equal(p.t, "draw");
  assert.equal(p.lines.length, 2, "the hidden layer and the eraser are left out");
  assert.deepEqual(p.lines.map((l) => l[0]), ["#d93a3a", "blue"], "each line its own colour, bottom first");
  for (const l of p.lines) {
    const pts = l.slice(3);
    assert.ok(pts.length / 2 <= 16, "a few points each: " + pts.length / 2);
    for (let i = 0; i < pts.length; i += 2) assert.ok(pts[i] >= 0 && pts[i] <= 100 && pts[i + 1] >= 0 && pts[i + 1] <= 60, "inside the box: " + pts.slice(i, i + 2));
  }
  // The first line runs from the top left of what is drawn to the bottom right, ends included.
  const first = p.lines[0].slice(3);
  assert.ok(first[0] < first[first.length - 2] && first[1] < first[first.length - 1]);
  assert.ok(validPreview(p), "home may draw it");
  assert.equal(drawPreview([{ visible: true, strokes: [] }]), null, "nothing drawn, nothing shown");
});

test("a drawing with many lines keeps the newest ones; a kept drawing preview is checked before home draws it", async () => {
  const { drawPreview } = await import("../src/core/preview.js");
  const strokes = Array.from({ length: 70 }, (_, i) => ({ pts: [i * 10, 0, 50, i * 10 + 5, 50, 50], c: i < 30 ? "red" : "black", w: 0 }));
  const p = drawPreview([{ visible: true, strokes }]);
  assert.ok(p.lines.length <= 40 && p.lines.every((l) => l[0] === "black"), "the newest " + p.lines.length);
  assert.ok(!validPreview({ t: "draw", lines: [["red", 1, 0, "x", 2]] }));
  assert.ok(!validPreview({ t: "draw", lines: Array.from({ length: 60 }, () => ["red", 1, 0, 1, 2, 3, 4]) }));
});

// The owner (27 November): "미리보기 홈화면 ui에서 선이 이상하게 끊겨 보인다던가, 어디는 약간 업데이트가 안
// 돼었다던가, 직관적이게". Home's pictures of drawings are painted with the room's own brushes now; this is
// where on the small picture the lines go.
test("a drawing's picture on home: the box its lines take (widths included, rubbing out is no place) fitted into the map, a small one larger", async () => {
  const { inkBox, boxMap } = await import("../src/core/preview.js");
  const line = (x0, y0, x1, y1, extra = {}) => ({ pts: [x0, y0, 50, (x0 + x1) / 2, (y0 + y1) / 2, 50, x1, y1, 50], c: "red", w: 2, ...extra });
  assert.equal(inkBox([[]]), null, "nothing drawn");
  assert.equal(inkBox([[line(0, 0, 50, 50, { b: "erase" })]]), null, "rubbing out alone is nothing to show");
  const box = inkBox([[line(100, 100, 1100, 600)], [line(200, 700, 300, 800, { z: 400 })]]);
  // A width-2 line (4 px = 25 units across) reaches 15 units past its points; the 40 px one 150.
  assert.deepEqual(box, [50, 85, 1115, 950]);
  const m = boxMap(box);
  const at = (x, y) => [m.ox + (x - m.x0) * m.scale, m.oy + (y - m.y0) * m.scale];
  const [ax, ay] = at(box[0], box[1]);
  const [bx, by] = at(box[2], box[3]);
  assert.ok(ax >= 4 - 1e-9 && ay >= 4 - 1e-9 && bx <= 96 + 1e-9 && by <= 56 + 1e-9, "inside the map, a little room round it: " + [ax, ay, bx, by]);
  assert.ok(Math.abs(ax - (100 - bx)) < 1e-6 && Math.abs(ay - (60 - by)) < 1e-6, "in its middle");
  // A doodle is drawn larger, never above 0.2 of the map per page unit.
  assert.equal(boxMap([0, 0, 20, 10]).scale, 0.2);
});

test("a board's map takes in what is drawn on it (a board with only a drawing has a map too); home checks it", async () => {
  const { boardPreview, validPreview: valid } = await import("../src/core/preview.js");
  const board = new BoardDoc();
  const clock = new Clock("a");
  const commit = (made) => { for (const op of made.ops) board.apply(op); return made; };
  const onlyInk = boardPreview(board, [1000, 500, 1400, 700]);
  assert.equal(onlyInk.t, "board");
  assert.deepEqual(onlyInk.cards, []);
  assert.equal(onlyInk.map.length, 5, "[x0, y0, scale, ox, oy]");
  assert.ok(valid(onlyInk));
  commit(addItemOps(clock, board, { kind: "note", x: 0, y: 0, data: { text: "메모" }, by: "m1" }));
  const both = boardPreview(board, [1000, 500, 1400, 700]);
  const [x0, y0, scale, ox, oy] = both.map;
  const at = (x, y) => [ox + (x - x0) * scale, oy + (y - y0) * scale];
  const [ix, iy] = at(1400, 700);
  assert.ok(ix <= 100 + 1e-6 && iy <= 60 + 1e-6, "the drawing's far corner is on the map: " + [ix, iy]);
  assert.ok(both.cards[0][0] < 30, "the note is at the left of the map, the drawing to its right");
  assert.ok(!valid({ t: "board", cards: [], map: [0, 0, "x", 0, 0] }));
});

test("a flipbook's picture on home plays its frames: at most twelve, spread evenly from the first to the last, as long as one pass", async () => {
  const { filmPlan } = await import("../src/core/preview.js");
  assert.equal(filmPlan([], 12), null);
  const two = filmPlan([{ id: "a", hold: 1 }, { id: "b", hold: 1 }], 12);
  assert.deepEqual(two.ids, ["a", "b"]);
  assert.equal(two.ms, 400, "a very short one plays at least 0.4 s a pass");
  const many = Array.from({ length: 30 }, (_, i) => ({ id: "f" + i, hold: i === 0 ? 3 : 1 }));
  const film = filmPlan(many, 8);
  assert.equal(film.ids.length, 12);
  assert.equal(film.ids[0], "f0");
  assert.equal(film.ids[11], "f29");
  assert.equal(film.ms, Math.round((32 / 8) * 1000), "32 ticks at 8 a second");
});
