import test from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/core/crdt.js";
import {
  SongDoc, sourceOp, addClipOps, splitClipOps, invertSongOps, noteSetOps, noteAddOps, joinClipOps, joinWithSourceOps, combinedSource,
} from "../src/core/song.js";
import { toBase64, fromBase64 } from "../src/core/b64.js";
import { rng, shuffle } from "./helpers.js";

const NOTES = [{ t: 0.1, d: 0.4, p: 60, v: 0.8 }, { t: 0.5, d: 0.5, p: 64, v: 0.6 }, { t: 1.2, d: 0.3, p: 67, v: 0.9 }];

function setup(replica = "a") {
  const song = new SongDoc();
  const clock = new Clock(replica);
  const commit = (ops) => { for (const op of ops) song.apply(op); return ops; };
  const src = sourceOp(clock, song, { duration: 1.6, notes: NOTES, peaks: toBase64(Uint8Array.from({ length: 40 }, (_, i) => i * 5)), by: "m1", at: 5 });
  commit([src]);
  return { song, clock, commit, src: src.id };
}

const shape = (song, src) => song.notesOf(src).map((n) => [n.t, n.d, n.p]);

test("a note's pitch, start and length can be changed, and playback follows", () => {
  const { song, clock, commit, src } = setup();
  const [first] = song.notesOf(src);
  assert.equal(first.key, "0");
  const fix = noteSetOps(clock, song, src, first.key, { p: 62, d: 300 });
  commit(fix.ops);
  assert.deepEqual(shape(song, src)[0], [100, 300, 62]);
  commit(addClipOps(clock, song, { src, row: 0, start: 0, length: 1600, by: "m1", at: 1 }).ops);
  assert.deepEqual(song.noteEvents(0, 5000).map((e) => [e.at, e.d, e.p]).slice(0, 1), [[100, 300, 62]]);
  commit(invertSongOps(song, clock, fix.atoms, "undo"));
  assert.deepEqual(shape(song, src)[0], [100, 400, 60]);
});

test("a note can be removed and brought back; a new note can be added", () => {
  const { song, clock, commit, src } = setup();
  const gone = noteSetOps(clock, song, src, "1", { gone: true });
  commit(gone.ops);
  assert.deepEqual(shape(song, src).map((n) => n[2]), [60, 67]);
  const add = noteAddOps(clock, song, src, { t: 900, d: 200, p: 65 });
  commit(add.ops);
  assert.deepEqual(shape(song, src).map((n) => n[2]), [60, 65, 67]);
  assert.equal(song.notesOf(src).find((n) => n.p === 65).key, add.key);
  commit(invertSongOps(song, clock, add.atoms, "undo"));
  commit(invertSongOps(song, clock, gone.atoms, "undo"));
  assert.deepEqual(shape(song, src).map((n) => n[2]), [60, 64, 67]);
  commit(invertSongOps(song, clock, add.atoms, "redo"));
  assert.deepEqual(shape(song, src).map((n) => n[2]), [60, 64, 65, 67]);
});

test("note edits that arrive before their sound wait for it, and merge in any order", () => {
  const { song, clock, src } = setup();
  const srcOp = { t: "src", id: src, dur: 1600, notes: song.source(src).notes.map((n) => [n.t, n.d, n.p, Math.round(n.v * 100)]), peaks: "", by: "m1", at: 5 };
  const a = noteSetOps(clock, song, src, "0", { p: 61 }).ops[0];
  const b = { ...noteSetOps(clock, song, src, "0", { p: 63 }).ops[0] };
  const add = noteAddOps(clock, song, src, { t: 1500, d: 80, p: 70 }).ops[0];
  const fixAdded = { t: "nfix", id: clock.next(), src, n: add.id, f: { p: 72 } };
  const r = rng(4);
  for (let k = 0; k < 12; k++) {
    const s = new SongDoc();
    for (const op of shuffle(r, [srcOp, a, b, add, fixAdded])) s.apply(op);
    assert.deepEqual(s.notesOf(src).map((n) => n.p), [63, 64, 67, 72]);
    assert.equal(s.pendingCount, 0);
  }
});

test("bad note edits are set aside", () => {
  const { song, src } = setup();
  for (const bad of [
    { t: "nfix", id: "90@a", src, n: "0", f: { p: 300 } },
    { t: "nfix", id: "91@a", src, n: "0", f: { colour: 1 } },
    { t: "nfix", id: "92@a", src, n: "zz", f: { p: 60 } },
    { t: "nadd", id: "93@a", src, note: { t: -1, d: 10, p: 60, v: 50 } },
  ]) assert.equal(song.apply(bad), "unknown");
});

test("joining the two halves of a split makes one clip again", () => {
  const { song, clock, commit, src } = setup();
  const add = addClipOps(clock, song, { src, row: 0, start: 1000, length: 1600, by: "m1", at: 1 });
  commit(add.ops);
  const split = splitClipOps(clock, song, add.id, 1700, "m1");
  commit(split.ops);
  assert.equal(song.layout().length, 2);
  const join = joinClipOps(clock, song, add.id, "m1");
  assert.ok(join && join.ops, "pieces of one recording join without a new sound");
  commit(join.ops);
  const clips = song.layout();
  assert.equal(clips.length, 1);
  assert.deepEqual([clips[0].start, clips[0].offset, clips[0].length], [1000, 0, 1600]);
  commit(invertSongOps(song, clock, join.atoms, "undo"));
  assert.equal(song.layout().length, 2);
});

test("joining two different takes makes one clip of a new sound, the gap kept as silence", () => {
  const { song, clock, commit, src } = setup();
  const other = sourceOp(clock, song, { duration: 1, notes: [{ t: 0.2, d: 0.5, p: 72, v: 1 }], peaks: toBase64(Uint8Array.from({ length: 25 }, () => 200)), by: "m2", at: 6 });
  commit([other]);
  const a = addClipOps(clock, song, { src, row: 2, start: 0, offset: 0, length: 1000, by: "m1", at: 1 });
  const b = addClipOps(clock, song, { src: other.id, row: 2, start: 1400, offset: 0, length: 1000, by: "m2", at: 1 });
  commit(a.ops);
  commit(b.ops);
  const plan = joinClipOps(clock, song, a.id, "m1");
  assert.ok(plan.combine, "different sounds need a new one");
  const combined = combinedSource(song, plan.combine.a, plan.combine.b);
  assert.equal(combined.duration, 2.4);
  // 도 and 미 from the first take (cut at 1 s), 높은 도 from the second, 1.4 s later.
  assert.deepEqual(combined.notes.map((n) => [Math.round(n.t * 1000), Math.round(n.d * 1000), n.p]), [[100, 400, 60], [500, 500, 64], [1600, 500, 72]]);
  const peaks = fromBase64(combined.peaks);
  assert.equal(peaks.length, 60, "25 per second for 2.4 s");
  assert.equal(peaks[30], 0, "the gap is silent");
  assert.equal(peaks[40], 200);
  const srcOp = sourceOp(clock, song, { ...combined, by: "m1", at: 7 });
  const join = joinWithSourceOps(clock, song, plan.combine.a, plan.combine.b, srcOp, "m1", 7);
  commit(join.ops);
  const clips = song.layout();
  assert.equal(clips.length, 1);
  assert.deepEqual([clips[0].start, clips[0].length, clips[0].row, clips[0].src], [0, 2400, 2, srcOp.id]);
  assert.deepEqual(song.noteEvents(0, 9999).map((e) => e.p), [60, 64, 72]);
  commit(invertSongOps(song, clock, join.atoms, "undo"));
  assert.deepEqual(song.layout().map((c) => c.src).sort(), [src, other.id].sort());
});

test("there is nothing to join when no clip follows on the row", () => {
  const { song, clock, commit, src } = setup();
  const a = addClipOps(clock, song, { src, row: 0, start: 0, length: 1000, by: "m1", at: 1 });
  commit(a.ops);
  commit(addClipOps(clock, song, { src, row: 1, start: 1200, length: 400, by: "m1", at: 1 }).ops);
  assert.equal(joinClipOps(clock, song, a.id, "m1"), null);
});
