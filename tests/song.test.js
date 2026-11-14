import test from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/core/crdt.js";
import {
  SongDoc, sourceOp, addClipOps, setClipOps, removeClipOps, splitClipOps, invertSongOps, MAX_ROWS,
} from "../src/core/song.js";
import { rng, pick, shuffle, permutations } from "./helpers.js";

const NOTES = [{ t: 0.1, d: 0.4, p: 60, v: 0.8 }, { t: 0.5, d: 0.5, p: 64, v: 0.6 }, { t: 1.2, d: 0.3, p: 67, v: 0.9 }];

function setup(replica = "a") {
  const song = new SongDoc();
  const clock = new Clock(replica);
  const commit = (ops) => { for (const op of ops) song.apply(op); return ops; };
  const src = sourceOp(clock, song, { duration: 1.6, notes: NOTES, peaks: "AAEC", by: "m1", at: 5 });
  commit([src]);
  return { song, clock, commit, src: src.id };
}

const visible = (song) => song.layout().map(({ id, src, lane, start, offset, length, muted }) => ({ id, src, lane, start, offset, length, muted }));

test("a sound keeps its notes in whole milliseconds", () => {
  const { song, src } = setup();
  const s = song.source(src);
  assert.equal(s.dur, 1600);
  assert.deepEqual(s.notes.map((n) => [n.t, n.d, n.p]), [[100, 400, 60], [500, 500, 64], [1200, 300, 67]]);
  assert.equal(s.notes[0].v, 0.8);
});

test("a clip plays a part of a sound at a place on the timeline", () => {
  const { song, clock, commit, src } = setup();
  const { id } = addClipOps(clock, song, { src, row: 0, start: 2000, offset: 0, length: 1600, by: "m1", at: 6 });
  assert.equal(song.layout().length, 0);
  commit(addClipOps(clock, song, { src, row: 0, start: 2000, length: 1600, by: "m1", at: 6 }).ops);
  const [clip] = song.layout();
  assert.equal(clip.start, 2000);
  assert.equal(clip.lane, 0);
  assert.equal(clip.muted, false);
  assert.equal(song.end(), 3600);
  assert.ok(id);
});

test("a clip that arrives before its sound waits for it", () => {
  const song = new SongDoc();
  const clock = new Clock("a");
  const src = sourceOp(clock, song, { duration: 1, notes: [], peaks: "", by: "m1", at: 1 });
  const { ops } = addClipOps(clock, song, { src: src.id, row: 0, start: 0, length: 1000, by: "m1", at: 1 });
  const mute = { t: "cset", id: clock.next(), c: ops[0].id, f: { muted: true } };
  assert.equal(song.apply(mute), "pending");
  assert.equal(song.apply(ops[0]), "pending");
  assert.equal(song.layout().length, 0);
  assert.equal(song.apply(src), "applied");
  assert.equal(song.layout().length, 1);
  assert.equal(song.layout()[0].muted, true);
  assert.equal(song.pendingCount, 0);
});

test("clip fields: the change with the larger id wins, in any order", () => {
  const { song, clock, commit, src } = setup();
  const [add] = commit(addClipOps(clock, song, { src, row: 0, start: 0, length: 1000, by: "m1", at: 1 }).ops);
  const moves = [
    { t: "cset", id: "50@b", c: add.id, f: { start: 500 } },
    { t: "cset", id: "51@a", c: add.id, f: { start: 900, row: 2 } },
    { t: "cset", id: "50@c", c: add.id, f: { row: 1 } },
  ];
  for (const order of permutations(moves)) {
    const s = new SongDoc();
    s.apply(song.source(src) && { t: "src", id: src, dur: 1600, notes: [], peaks: "", by: "m1", at: 1 });
    s.apply(add);
    for (const op of order) s.apply(op);
    const c = s.clip(add.id);
    assert.equal(c.start, 900);
    assert.equal(c.row, 2);
  }
});

test("removing and bringing back: the larger counter wins, odd hides", () => {
  const { song, clock, commit, src } = setup();
  const [add] = commit(addClipOps(clock, song, { src, row: 0, start: 0, length: 1000, by: "m1", at: 1 }).ops);
  commit(removeClipOps(clock, song, add.id).ops);
  assert.equal(song.layout().length, 0);
  song.apply({ t: "crm", id: "90@b", c: add.id, n: 2 });
  assert.equal(song.layout().length, 1);
  song.apply({ t: "crm", id: "91@c", c: add.id, n: 1 });
  assert.equal(song.layout().length, 1);
});

test("splitting cuts a clip in two at the playhead; together they cover the same sound", () => {
  const { song, clock, commit, src } = setup();
  const [add] = commit(addClipOps(clock, song, { src, row: 1, start: 1000, offset: 0, length: 1600, by: "m1", at: 1 }).ops);
  const split = splitClipOps(clock, song, add.id, 1500, "m1", 9);
  commit(split.ops);
  const [front, back] = song.layout();
  assert.deepEqual([front.start, front.offset, front.length], [1000, 0, 500]);
  assert.deepEqual([back.start, back.offset, back.length, back.lane, back.src], [1500, 500, 1100, 1, src]);
  assert.equal(splitClipOps(clock, song, add.id, 900, "m1"), null, "outside the clip");
  assert.equal(splitClipOps(clock, song, add.id, 1520, "m1"), null, "too near the end");
});

test("a muted clip's copy after a split stays muted", () => {
  const { song, clock, commit, src } = setup();
  const [add] = commit(addClipOps(clock, song, { src, row: 0, start: 0, length: 1600, by: "m1", at: 1 }).ops);
  commit(setClipOps(clock, song, add.id, { muted: true }).ops);
  commit(splitClipOps(clock, song, add.id, 800, "m1").ops);
  assert.deepEqual(song.layout().map((c) => c.muted), [true, true]);
});

test("piano notes come from clips that are not muted, cut at the clip's edges", () => {
  const { song, clock, commit, src } = setup();
  // Plays the sound from 0.3 s for 1 s, starting at 2 s on the timeline.
  const [a] = commit(addClipOps(clock, song, { src, row: 0, start: 2000, offset: 300, length: 1000, by: "m1", at: 1 }).ops);
  const events = song.noteEvents(0, 10000);
  // 도 (0.1–0.5) is cut to 0.3–0.5; 미 (0.5–1.0) whole; 솔 (1.2–1.5) cut at 1.3.
  assert.deepEqual(events.map((e) => [e.at, e.d, e.p]), [[2000, 200, 60], [2200, 500, 64], [2900, 100, 67]]);
  commit(setClipOps(clock, song, a.id, { muted: true }).ops);
  assert.equal(song.noteEvents(0, 10000).length, 0);
});

test("starting in the middle of a note plays the rest of it only when asked", () => {
  const { song, clock, commit, src } = setup();
  commit(addClipOps(clock, song, { src, row: 0, start: 0, length: 1600, by: "m1", at: 1 }).ops);
  assert.deepEqual(song.noteEvents(700, 2000).map((e) => e.p), [67]);
  const ongoing = song.noteEvents(700, 2000, { ongoing: true });
  assert.deepEqual(ongoing.map((e) => [e.at, e.d, e.p]), [[700, 300, 64], [1200, 300, 67]]);
});

test("recorded sound plays as stretches of each clip's own part", () => {
  const { song, clock, commit, src } = setup();
  commit(addClipOps(clock, song, { src, row: 0, start: 1000, offset: 200, length: 800, by: "m1", at: 1 }).ops);
  assert.deepEqual(song.audioSegments(0, 5000).map((s) => [s.at, s.offset, s.d]), [[1000, 200, 800]]);
  assert.deepEqual(song.audioSegments(1300, 5000, { ongoing: true }).map((s) => [s.at, s.offset, s.d]), [[1300, 500, 500]]);
});

test("two clips placed on the same spot at once: the larger id goes one row down", () => {
  const { song, src } = setup();
  const base = { t: "clip", src, row: 0, start: 0, offset: 0, length: 1000, by: "m1", at: 1 };
  const a = { ...base, id: "20@a" };
  const b = { ...base, id: "20@b", start: 500 };
  for (const order of permutations([a, b])) {
    const s = new SongDoc();
    s.apply({ t: "src", id: src, dur: 1600, notes: [], peaks: "", by: "m1", at: 1 });
    for (const op of order) s.apply(op);
    assert.deepEqual(s.layout().map((c) => [c.id, c.lane]), [["20@a", 0], ["20@b", 1]]);
  }
});

test("a new clip goes to the nearest free row at or below the one asked for", () => {
  const { song, clock, commit, src } = setup();
  commit(addClipOps(clock, song, { src, row: 0, start: 0, length: 1000, by: "m1", at: 1 }).ops);
  commit(addClipOps(clock, song, { src, row: 1, start: 500, length: 1000, by: "m1", at: 1 }).ops);
  assert.equal(song.freeRow(400, 300, 0), 2);
  assert.equal(song.freeRow(200, 300, 0), 1, "ending where the next clip starts is not overlapping");
  assert.equal(song.freeRow(1200, 300, 0), 0);
  assert.equal(song.freeRow(1200, 300, 1), 2);
  assert.equal(song.rowCount(), 3, "used rows and one empty row below");
  const moving = song.layout()[0].id;
  assert.equal(song.freeRow(200, 300, 0, moving), 0, "the clip being moved is not in its own way");
});

test("when every row is taken at that time there is no room", () => {
  const { song, clock, commit, src } = setup();
  for (let r = 0; r < MAX_ROWS; r++) commit(addClipOps(clock, song, { src, row: r, start: 0, length: 1000, by: "m1", at: 1 }).ops);
  assert.equal(song.freeRow(100, 100, 0), null);
  assert.equal(song.freeRow(1000, 100, 0), 0);
});

test("ops that make no sense are set aside, not applied", () => {
  const song = new SongDoc();
  const bad = [
    { t: "src", id: "1@a", dur: -5, notes: [], peaks: "", by: "m", at: 1 },
    { t: "src", id: "2@a", dur: 100, notes: [[0, 10, 200, 50]], peaks: "", by: "m", at: 1 },
    { t: "clip", id: "3@a", src: "1@a", row: 0, start: -1, offset: 0, length: 10, by: "m", at: 1 },
    { t: "cset", id: "4@a", c: "3@a", f: { start: "soon" } },
    { t: "cset", id: "5@a", c: "3@a", f: { colour: 3 } },
    { t: "crm", id: "6@a", c: "3@a", n: 0 },
    { t: "wobble", id: "7@a" },
    null,
  ];
  for (const op of bad) assert.equal(song.apply(op), "unknown");
  assert.equal(song.unknown.length, bad.length);
});

test("undo and redo of add, move, split and delete", () => {
  const { song, clock, commit, src } = setup();
  const add = addClipOps(clock, song, { src, row: 0, start: 0, length: 1600, by: "m1", at: 1 });
  commit(add.ops);
  const move = setClipOps(clock, song, add.id, { start: 3000, row: 2 });
  commit(move.ops);
  const split = splitClipOps(clock, song, add.id, 3500, "m1");
  commit(split.ops);
  const del = removeClipOps(clock, song, split.id);
  commit(del.ops);
  const shape = () => song.layout().map((c) => [c.start, c.length, c.row]);
  assert.deepEqual(shape(), [[3000, 500, 2]]);
  commit(invertSongOps(song, clock, del.atoms, "undo"));
  assert.deepEqual(shape(), [[3000, 500, 2], [3500, 1100, 2]]);
  commit(invertSongOps(song, clock, split.atoms, "undo"));
  assert.deepEqual(shape(), [[3000, 1600, 2]]);
  commit(invertSongOps(song, clock, move.atoms, "undo"));
  assert.deepEqual(shape(), [[0, 1600, 0]]);
  commit(invertSongOps(song, clock, move.atoms, "redo"));
  assert.deepEqual(shape(), [[3000, 1600, 2]]);
  commit(invertSongOps(song, clock, add.atoms, "undo"));
  assert.deepEqual(shape(), []);
});

test("three devices editing at random end with the same song, whatever the delivery order", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed);
    const devices = ["a", "b", "c"].map((replica) => ({ song: new SongDoc(), clock: new Clock(replica), log: [] }));
    const all = [];
    const share = (ops) => { all.push(...ops); };
    // Everyone starts from one shared sound.
    const first = devices[0];
    const src = sourceOp(first.clock, first.song, { duration: 3, notes: NOTES, peaks: "", by: "m1", at: 1 });
    share([src]);
    for (const d of devices) d.song.apply(src);
    for (let step = 0; step < 40; step++) {
      const d = pick(r, devices);
      // Each device sees a random part of what others did so far.
      for (const op of shuffle(r, all).slice(0, Math.floor(r() * all.length))) { d.clock.see(op.id); d.song.apply(op); }
      const clips = d.song.layout();
      const kind = r();
      let made = null;
      if (kind < 0.3 || !clips.length) made = addClipOps(d.clock, d.song, { src: src.id, row: Math.floor(r() * 4), start: Math.floor(r() * 5000), offset: 0, length: 300 + Math.floor(r() * 2000), by: "m1", at: 1 });
      else {
        const c = pick(r, clips);
        if (kind < 0.5) made = setClipOps(d.clock, d.song, c.id, { start: Math.floor(r() * 5000), row: Math.floor(r() * 4) });
        else if (kind < 0.65) made = splitClipOps(d.clock, d.song, c.id, c.start + Math.floor(r() * c.length), "m1");
        else if (kind < 0.75) made = setClipOps(d.clock, d.song, c.id, { muted: r() < 0.5 });
        else if (kind < 0.9) made = removeClipOps(d.clock, d.song, c.id);
        else {
          const gone = [...d.song.clipsById.keys()].map((id) => d.song.clip(id)).filter((x) => x.removed);
          if (gone.length) made = { ops: invertSongOps(d.song, d.clock, [{ k: "del", clip: pick(r, gone).id }], "undo") };
        }
      }
      if (!made) continue;
      for (const op of made.ops) d.song.apply(op);
      share(made.ops);
    }
    // Finally everyone gets everything, in their own order, some twice.
    const results = devices.map((d) => {
      for (const op of shuffle(r, [...all, ...all.slice(0, 10)])) d.song.apply(op);
      return JSON.stringify(visible(d.song));
    });
    assert.equal(results[1], results[0], "seed " + seed);
    assert.equal(results[2], results[0], "seed " + seed);
    for (const d of devices) assert.equal(d.song.pendingCount, 0);
  }
});

test("박자: the song's tempo and meter, set and undone; the latest wins in any order; nonsense is set aside", async () => {
  const { SongDoc, tempoOps, invertSongOps } = await import("../src/core/song.js");
  const { Clock } = await import("../src/core/crdt.js");
  const song = new SongDoc();
  const clock = new Clock("a");
  const run = (made) => { for (const op of made.ops) song.apply(op); return made; };
  assert.equal(song.tempo(), null);
  const set = run(tempoOps(clock, song, { bpm: 96, beats: 3, unit: 4 }, "m1"));
  assert.deepEqual(song.tempo(), { bpm: 96, beats: 3, unit: 4 });
  const again = run(tempoOps(clock, song, { bpm: 120, beats: 6, unit: 8 }, "m1"));
  for (const op of invertSongOps(song, clock, again.atoms, "undo")) song.apply(op);
  assert.deepEqual(song.tempo(), { bpm: 96, beats: 3, unit: 4 });
  for (const op of invertSongOps(song, clock, set.atoms, "undo")) song.apply(op);
  assert.equal(song.tempo(), null, "undo all the way: no tempo");
  const other = new SongDoc();
  const ops = [...set.ops, ...again.ops].reverse();
  for (const op of ops) other.apply(op);
  assert.deepEqual(other.tempo(), { bpm: 120, beats: 6, unit: 8 }, "arriving out of order, the later still wins");
  assert.equal(song.apply({ t: "tempo", id: clock.next(), bpm: 999, beats: 4, unit: 4, by: "m1" }), "unknown");
});
