import test from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/core/crdt.js";
import { SongDoc, sourceOp, addClipOps, setClipOps } from "../src/core/song.js";
import { SongPlayer } from "../src/audio/engine.js";
import { FakeAudioContext } from "./mocks/audio-context.js";

const NOTES = [{ t: 0, d: 0.4, p: 60, v: 0.8 }, { t: 0.5, d: 0.4, p: 64, v: 0.8 }, { t: 1, d: 0.5, p: 67, v: 0.8 }];

function world({ audio = false } = {}) {
  const song = new SongDoc();
  const clock = new Clock("a");
  const commit = (ops) => ops.forEach((op) => song.apply(op));
  const src = sourceOp(clock, song, { duration: 1.5, notes: NOTES, peaks: "", by: "m", at: 1 });
  commit([src]);
  const ctx = new FakeAudioContext();
  const recording = ctx.createBuffer(1, 48000 * 2, 48000);
  let ended = 0;
  const player = new SongPlayer(ctx, { song: () => song, audioFor: () => (audio ? recording : null), onEnd: () => ended++ });
  /** Moves time on and lets the player book, without real timers. */
  const run = (seconds) => {
    clearInterval(player.timer);
    for (let t = 0; t < seconds; t += 0.04) {
      ctx.currentTime += 0.04;
      player.book(false);
      clearInterval(player.timer);
    }
  };
  return { song, clock, commit, src: src.id, ctx, player, recording, run, ended: () => ended };
}

const pianoKeys = (player, ctx) => ctx.started
  .filter((s) => s.buffer && s.buffer.length !== 96000)
  .map((s) => {
    const key = [...player.voice.buffers].find(([, b]) => b === s.buffer)?.[0];
    return [Math.round((s.started.when - player.startedAt) * 1000), Number(key.split(":")[1])];
  });

test("piano mode books every note at its time on the audio clock", () => {
  const w = world();
  w.commit(addClipOps(w.clock, w.song, { src: w.src, row: 0, start: 1000, length: 1500, by: "m", at: 1 }).ops);
  w.player.play(0);
  w.run(3);
  assert.deepEqual(pianoKeys(w.player, w.ctx), [[1000, 60], [1500, 64], [2000, 67]]);
});

test("clips on two rows sound together", () => {
  const w = world();
  w.commit(addClipOps(w.clock, w.song, { src: w.src, row: 0, start: 0, length: 1500, by: "m", at: 1 }).ops);
  w.commit(addClipOps(w.clock, w.song, { src: w.src, row: 1, start: 500, offset: 500, length: 1000, by: "m", at: 1 }).ops);
  w.player.play(0);
  w.run(2.5);
  assert.deepEqual(pianoKeys(w.player, w.ctx).sort((a, b) => a[0] - b[0] || a[1] - b[1]), [[0, 60], [500, 64], [500, 64], [1000, 67], [1000, 67]]);
});

test("a muted clip stays silent", () => {
  const w = world();
  const { ops, id } = addClipOps(w.clock, w.song, { src: w.src, row: 0, start: 0, length: 1500, by: "m", at: 1 });
  w.commit(ops);
  w.commit(setClipOps(w.clock, w.song, id, { muted: true }).ops);
  w.player.play(0);
  w.run(2);
  assert.equal(w.ctx.started.length, 0);
});

test("starting in the middle of a note sounds the rest of it", () => {
  const w = world();
  w.commit(addClipOps(w.clock, w.song, { src: w.src, row: 0, start: 0, length: 1500, by: "m", at: 1 }).ops);
  w.player.play(650);
  w.run(1.5);
  assert.deepEqual(pianoKeys(w.player, w.ctx).map(([, k]) => k), [64, 67]);
});

test("original mode plays the recording's own stretch of each clip", () => {
  const w = world({ audio: true });
  w.commit(addClipOps(w.clock, w.song, { src: w.src, row: 0, start: 2000, offset: 300, length: 800, by: "m", at: 1 }).ops);
  w.player.setMode("original");
  w.player.play(0);
  w.run(3.5);
  const rec = w.ctx.started.filter((s) => s.buffer === w.recording);
  assert.equal(rec.length, 1);
  assert.ok(Math.abs(rec[0].started.when - w.player.startedAt - 2) < 1e-9);
  assert.equal(rec[0].started.offset, 0.3);
  assert.ok(Math.abs(rec[0].started.duration - 0.81) < 1e-9);
  assert.equal(pianoKeys(w.player, w.ctx).length, 0);
});

test("in original mode a clip whose recording is not on this device plays as piano", () => {
  const w = world({ audio: false });
  w.commit(addClipOps(w.clock, w.song, { src: w.src, row: 0, start: 0, length: 1500, by: "m", at: 1 }).ops);
  w.player.setMode("original");
  w.player.play(0);
  w.run(2);
  assert.deepEqual(pianoKeys(w.player, w.ctx).map(([, k]) => k), [60, 64, 67]);
});

test("같이 plays the recording and its piano at once (to hear whether they agree)", () => {
  const w = world({ audio: true });
  w.commit(addClipOps(w.clock, w.song, { src: w.src, row: 0, start: 0, length: 1500, by: "m", at: 1 }).ops);
  w.player.setMode("both");
  w.player.play(0);
  w.run(2);
  assert.equal(w.ctx.started.filter((s) => s.buffer === w.recording).length, 1, "the recording");
  assert.deepEqual(pianoKeys(w.player, w.ctx).map(([, k]) => k), [60, 64, 67], "and every note as piano");
});

test("the player stops by itself after the last clip and says so", () => {
  const w = world();
  w.commit(addClipOps(w.clock, w.song, { src: w.src, row: 0, start: 0, length: 1500, by: "m", at: 1 }).ops);
  w.player.play(0);
  w.run(2.5);
  assert.equal(w.player.playing, false);
  assert.equal(w.ended(), 1);
  assert.ok(w.player.position >= 1500);
});

test("while recording the clock keeps running past the end", () => {
  const w = world();
  w.player.play(0, { keepGoing: true });
  w.run(3);
  assert.equal(w.player.playing, true);
  assert.ok(w.player.position > 2900);
  w.player.stop();
});

test("stop silences what was booked and keeps the playhead where it was", () => {
  const w = world();
  w.commit(addClipOps(w.clock, w.song, { src: w.src, row: 0, start: 0, length: 1500, by: "m", at: 1 }).ops);
  w.player.play(0);
  w.run(0.6);
  const booked = w.ctx.started.slice();
  w.player.stop();
  assert.ok(booked.length > 0 && booked.every((s) => s.stoppedAt !== null));
  const at = w.player.position;
  assert.ok(at > 500 && at < 800, "playhead " + at);
  w.player.seek(100);
  assert.equal(w.player.position, 100);
});

test("changing the tone while playing switches the piano sound from the playhead on", () => {
  const w = world();
  w.commit(addClipOps(w.clock, w.song, { src: w.src, row: 0, start: 0, length: 1500, by: "m", at: 1 }).ops);
  w.player.play(0);
  w.run(0.3);
  w.player.setTone("dark");
  w.run(2);
  const keys = w.ctx.started.map((s) => [...w.player.voice.buffers].find(([, b]) => b === s.buffer)?.[0]).filter(Boolean);
  assert.ok(keys.includes("bright:60"));
  assert.ok(keys.includes("dark:64") && keys.includes("dark:67"));
  assert.ok(!keys.includes("bright:67"));
});

test("at 2× the notes come twice as fast and the playhead runs twice as fast", () => {
  const w = world();
  w.commit(addClipOps(w.clock, w.song, { src: w.src, row: 0, start: 1000, length: 1500, by: "m", at: 1 }).ops);
  w.player.setSpeed(2);
  w.player.play(0);
  w.run(1.5);
  assert.deepEqual(pianoKeys(w.player, w.ctx), [[500, 60], [750, 64], [1000, 67]]);
  w.player.stop();
  assert.ok(w.player.position >= 2400, "1.5 s of listening covered 3 s of song: " + w.player.position);
});

test("at 3× a recording is stretched, not sped up like a chipmunk", () => {
  const w = world({ audio: true });
  w.commit(addClipOps(w.clock, w.song, { src: w.src, row: 0, start: 0, offset: 300, length: 900, by: "m", at: 1 }).ops);
  w.player.setMode("original");
  w.player.setSpeed(3);
  w.player.play(0);
  w.run(1);
  const [rec] = w.ctx.started.filter((s) => s.buffer && s.buffer !== w.recording && s.buffer.length < 96000 && s.buffer.length > 20000);
  assert.ok(rec, "a stretched copy of the recording plays");
  assert.ok(Math.abs(rec.buffer.length - 96000 / 3) <= 2);
  assert.ok(Math.abs(rec.started.offset - 0.1) < 1e-9, "the offset is in stretched time");
  assert.ok(Math.abs(rec.started.duration - (0.3 + 0.01)) < 1e-9);
});

test("in piano mode a recording with no notes found plays as it was recorded (it would be silent as piano)", () => {
  const w = world({ audio: true });
  const bare = sourceOp(w.clock, w.song, { duration: 1.5, notes: [], peaks: "", by: "m", at: 2 });
  w.commit([bare]);
  w.commit(addClipOps(w.clock, w.song, { src: bare.id, row: 0, start: 0, length: 1500, by: "m", at: 1 }).ops);
  w.commit(addClipOps(w.clock, w.song, { src: w.src, row: 1, start: 0, length: 1500, by: "m", at: 1 }).ops);
  w.player.play(0);
  w.run(2.5);
  assert.equal(w.ctx.started.filter((s) => s.buffer === w.recording).length, 1, "the bare one sounds as recorded");
  assert.deepEqual(pianoKeys(w.player, w.ctx).map(([, k]) => k), [60, 64, 67], "the one with notes stays piano");
});

test("iPhone and iPad: waking the sound says the page plays music, so the silent switch does not mute it; a recording asks for the mic's kind and gives it back", async () => {
  const { audioContext, useAudioContext, soundFor } = await import("../src/audio/engine.js");
  const session = { type: "auto" };
  Object.defineProperty(globalThis.navigator, "audioSession", { value: session, configurable: true });
  try {
    const ctx = new FakeAudioContext();
    ctx.state = "interrupted"; // iOS after a call or another app's sound
    let resumed = 0;
    ctx.resume = async () => { resumed++; ctx.state = "running"; };
    useAudioContext(ctx);
    await audioContext();
    assert.equal(session.type, "playback");
    assert.equal(resumed, 1, "an interrupted context is woken too");
    soundFor("recording");
    assert.equal(session.type, "play-and-record");
    soundFor("playing");
    assert.equal(session.type, "playback");
  } finally {
    delete globalThis.navigator.audioSession;
    useAudioContext(null);
  }
});
