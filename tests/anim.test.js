import test from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/core/crdt.js";
import { AnimDoc, addFrameOps, setFrameOps, removeFrameOps, moveFrameOps, setAnimOps, invertAnimOps, frameDocOf, timeline, frameAt, FPS_CHOICES, MAX_FRAMES, MAX_HOLD } from "../src/core/anim.js";
import { shuffle, rng } from "./helpers.js";

const apply = (doc, made) => { for (const op of made.ops) doc.apply(op); return made; };

test("frames in order, each its own drawing; a new frame goes after the one given, or at the end", () => {
  const doc = new AnimDoc();
  const clock = new Clock("a");
  const one = apply(doc, addFrameOps(clock, doc, { by: "m1" }));
  const three = apply(doc, addFrameOps(clock, doc, { by: "m1" }));
  const two = apply(doc, addFrameOps(clock, doc, { by: "m1", after: one.id }));
  assert.deepEqual(doc.frames().map((f) => f.id), [one.id, two.id, three.id]);
  assert.equal(frameDocOf(one.id), "k:F" + one.id);
  assert.notEqual(frameDocOf(one.id), frameDocOf(two.id));
  assert.deepEqual(doc.frames().map((f) => f.hold), [1, 1, 1], "each shows for one tick at first");
  assert.equal(doc.settings().fps, 12, "12 a second, as animators draw 'on twos'");
  assert.ok(FPS_CHOICES.includes(12) && FPS_CHOICES.includes(24) && MAX_FRAMES >= 200 && MAX_HOLD >= 4);
});

test("hold (노출): a frame held for longer shows for more ticks; the timeline and the frame at a tick follow it", () => {
  const doc = new AnimDoc();
  const clock = new Clock("a");
  const a = apply(doc, addFrameOps(clock, doc, { by: "m" }));
  const b = apply(doc, addFrameOps(clock, doc, { by: "m" }));
  apply(doc, setFrameOps(clock, doc, a.id, { hold: 3 }));
  const line = timeline(doc);
  assert.deepEqual(line.map((t) => t.id), [a.id, a.id, a.id, b.id]);
  assert.equal(frameAt(doc, 0), a.id);
  assert.equal(frameAt(doc, 2), a.id);
  assert.equal(frameAt(doc, 3), b.id);
  assert.equal(frameAt(doc, 4), a.id, "it loops");
  assert.equal(setFrameOps(clock, doc, a.id, { hold: 99 }).ops.length, 0, "a hold past the limit is not made");
});

test("frames reorder, settings change; the later change wins in any order; devices agree", () => {
  const ca = new Clock("a");
  const cb = new Clock("b");
  const src = new AnimDoc();
  const ops = [];
  const take = (made) => { for (const op of made.ops) { src.apply(op); ops.push(op); } return made; };
  const x = take(addFrameOps(ca, src, { by: "m1" }));
  const y = take(addFrameOps(ca, src, { by: "m1" }));
  cb.atLeast(src.maxN);
  const z = take(addFrameOps(cb, src, { by: "m2" }));
  take(moveFrameOps(ca, src, z.id, -2));
  take(setFrameOps(cb, src, x.id, { hold: 2 }));
  take(setAnimOps(ca, src, { fps: 8 }));
  cb.atLeast(src.maxN);
  take(setAnimOps(cb, src, { fps: 24, loop: "pingpong" }));
  take(removeFrameOps(ca, src, y.id));
  assert.deepEqual(src.frames().map((f) => f.id), [z.id, x.id]);
  assert.deepEqual(src.settings(), { fps: 24, loop: "pingpong" });
  const random = rng(11);
  for (let i = 0; i < 20; i++) {
    const d = new AnimDoc();
    d.applyAll(shuffle(random, ops.slice()));
    assert.deepEqual(d.frames().map((f) => [f.id, f.hold]), src.frames().map((f) => [f.id, f.hold]));
    assert.deepEqual(d.settings(), src.settings());
  }
});

test("undo: a removed frame comes back, a made one goes, a hold goes back", () => {
  const doc = new AnimDoc();
  const clock = new Clock("a");
  const f = apply(doc, addFrameOps(clock, doc, { by: "m" }));
  const held = apply(doc, setFrameOps(clock, doc, f.id, { hold: 4 }));
  for (const op of invertAnimOps(doc, clock, held.atoms, "undo")) doc.apply(op);
  assert.equal(doc.frames()[0].hold, 1);
  const gone = apply(doc, removeFrameOps(clock, doc, f.id));
  assert.equal(doc.frames().length, 0);
  for (const op of invertAnimOps(doc, clock, gone.atoms, "undo")) doc.apply(op);
  assert.equal(doc.frames().length, 1);
  for (const op of invertAnimOps(doc, clock, f.atoms, "undo")) doc.apply(op);
  assert.equal(doc.frames().length, 0, "undoing its making takes it away");
});

test("nonsense is set aside; a change that comes before its frame waits for it", () => {
  const doc = new AnimDoc();
  assert.equal(doc.apply({ t: "fset", id: "5@x", f: "1@x", v: { hold: 0 } }), "unknown");
  assert.equal(doc.apply({ t: "aset", id: "6@x", v: { fps: 7 } }), "unknown");
  assert.equal(doc.apply({ t: "aset", id: "7@x", v: { loop: "sideways" } }), "unknown");
  assert.equal(doc.apply({ t: "fset", id: "9@x", f: "8@x", v: { hold: 2 } }), "pending");
  assert.equal(doc.apply({ t: "frame", id: "8@x", by: "m", at: 1 }), "applied");
  assert.equal(doc.frames()[0].hold, 2);
});
