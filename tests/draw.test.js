import test from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/core/crdt.js";
import { DrawDoc, addLayerOps, setLayerOps, removeLayerOps, moveLayerOps, invertDrawOps, inkDocOf, BLEND_MODES, MAX_LAYERS, paperOps, PAPERS } from "../src/core/draw.js";
import { shuffle, rng } from "./helpers.js";

const apply = (doc, made) => { for (const op of made.ops) doc.apply(op); return made; };

test("layers come with a name and sensible defaults, newest on top; each has its own drawing document", () => {
  const doc = new DrawDoc();
  const clock = new Clock("a");
  const a = apply(doc, addLayerOps(clock, doc, { name: "밑그림", by: "m1" }));
  const b = apply(doc, addLayerOps(clock, doc, { name: "", by: "m1" }));
  assert.deepEqual(doc.layers().map((l) => [l.name, l.visible, l.opacity, l.mode]), [["밑그림", true, 1, "source-over"], ["레이어 2", true, 1, "source-over"]]);
  assert.equal(inkDocOf(a.id), "k:L" + a.id);
  assert.notEqual(inkDocOf(a.id), inkDocOf(b.id));
  assert.equal(MAX_LAYERS, 16);
  assert.ok(BLEND_MODES.includes("multiply") && BLEND_MODES.includes("screen"));
});

test("name, opacity, visibility and blend: the later change wins, in whatever order they arrive", () => {
  const doc = new DrawDoc();
  const ca = new Clock("a");
  const cb = new Clock("b");
  const layer = apply(doc, addLayerOps(ca, doc, { name: "선", by: "m1" }));
  const one = setLayerOps(ca, doc, layer.id, { opacity: 0.5, mode: "multiply" }).ops;
  cb.atLeast(doc.maxN);
  const two = setLayerOps(cb, doc, layer.id, { opacity: 0.3, visible: false, name: "색" }).ops;
  const forward = new DrawDoc();
  const backward = new DrawDoc();
  forward.applyAll([...layer.ops, ...one, ...two]);
  backward.applyAll([...two, ...one, ...layer.ops]);
  for (const d of [forward, backward]) assert.deepEqual(d.layers().map((l) => [l.name, l.opacity, l.visible, l.mode]), [["색", 0.3, false, "multiply"]]);
});

test("moving a layer up or down changes only the order, the same on every device", () => {
  const doc = new DrawDoc();
  const clock = new Clock("a");
  const ids = ["A", "B", "C", "D"].map((name) => apply(doc, addLayerOps(clock, doc, { name, by: "m" })).id);
  apply(doc, moveLayerOps(clock, doc, ids[0], 2));
  assert.deepEqual(doc.layers().map((l) => l.name), ["B", "C", "A", "D"]);
  apply(doc, moveLayerOps(clock, doc, ids[3], -3));
  assert.deepEqual(doc.layers().map((l) => l.name), ["D", "B", "C", "A"]);
  apply(doc, moveLayerOps(clock, doc, ids[1], 5));
  assert.deepEqual(doc.layers().map((l) => l.name), ["D", "C", "A", "B"], "past the top it stays on top");
});

test("devices that get the same ops in any order see the same layers", () => {
  const ca = new Clock("a");
  const cb = new Clock("b");
  const src = new DrawDoc();
  const ops = [];
  const take = (made) => { for (const op of made.ops) { src.apply(op); ops.push(op); } return made; };
  const x = take(addLayerOps(ca, src, { name: "x", by: "m1" }));
  cb.atLeast(src.maxN);
  const y = take(addLayerOps(cb, src, { name: "y", by: "m2" }));
  take(setLayerOps(ca, src, y.id, { opacity: 0.7 }));
  take(moveLayerOps(cb, src, x.id, 1));
  take(removeLayerOps(ca, src, y.id));
  take(setLayerOps(cb, src, x.id, { mode: "screen" }));
  const random = rng(7);
  for (let i = 0; i < 20; i++) {
    const d = new DrawDoc();
    d.applyAll(shuffle(random, ops.slice()));
    assert.deepEqual(d.layers().map((l) => [l.id, l.order, l.mode, l.opacity]), src.layers().map((l) => [l.id, l.order, l.mode, l.opacity]));
  }
});

test("a layer taken away comes back with undo; undo and redo of a change put the values back", () => {
  const doc = new DrawDoc();
  const clock = new Clock("a");
  const layer = apply(doc, addLayerOps(clock, doc, { name: "선", by: "m" }));
  const changed = apply(doc, setLayerOps(clock, doc, layer.id, { opacity: 0.4, name: "그림자" }));
  for (const op of invertDrawOps(doc, clock, changed.atoms, "undo")) doc.apply(op);
  assert.deepEqual(doc.layers().map((l) => [l.name, l.opacity]), [["선", 1]]);
  for (const op of invertDrawOps(doc, clock, changed.atoms, "redo")) doc.apply(op);
  assert.deepEqual(doc.layers().map((l) => [l.name, l.opacity]), [["그림자", 0.4]]);
  const gone = apply(doc, removeLayerOps(clock, doc, layer.id));
  assert.equal(doc.layers().length, 0);
  for (const op of invertDrawOps(doc, clock, gone.atoms, "undo")) doc.apply(op);
  assert.equal(doc.layers().length, 1);
  for (const op of invertDrawOps(doc, clock, layer.atoms, "undo")) doc.apply(op);
  assert.equal(doc.layers().length, 0, "undoing its making takes it away");
});

test("ops that make no sense are set aside; a change that comes before its layer waits for it", () => {
  const doc = new DrawDoc();
  assert.equal(doc.apply({ t: "lset", id: "5@x", l: "1@x", f: { mode: "glow" } }), "unknown");
  assert.equal(doc.apply({ t: "lset", id: "6@x", l: "1@x", f: { opacity: 2 } }), "unknown");
  assert.equal(doc.apply({ t: "layer", id: "7@x", name: 5, by: "m", at: 1 }), "unknown");
  assert.equal(doc.apply({ t: "lset", id: "9@x", l: "8@x", f: { name: "먼저 온 이름" } }), "pending");
  assert.equal(doc.apply({ t: "layer", id: "8@x", name: "늦게 온 층", by: "m", at: 1 }), "applied");
  assert.equal(doc.layers()[0].name, "먼저 온 이름");
});

// 종이 (the owner, 21 November: "손그림 그거는 종이의 개념이고 뒷배경을 투명하게 할 수도"): the page's
// paper is one for everyone in the room, any of a few or none at all (see-through); undo puts it back.
test("the paper: white to begin with, one of a few or clear, the latest change wins, undone with one step", () => {
  const doc = new DrawDoc();
  const a = new Clock("a");
  const b = new Clock("b");
  assert.equal(doc.paper(), "white");
  assert.ok(PAPERS.some(([k]) => k === "clear"), "see-through is one of them");
  const toCream = apply(doc, paperOps(a, doc, "cream"));
  assert.equal(doc.paper(), "cream");
  const other = new DrawDoc();
  const toClear = paperOps(b, other, "clear");
  for (const op of [...toClear.ops, ...toCream.ops]) other.apply(op);
  for (const op of toClear.ops) doc.apply(op);
  assert.equal(doc.paper(), other.paper(), "both screens agree whatever the order");
  assert.equal(doc.apply({ t: "paper", id: a.next(), v: "plaid" }), "unknown", "only the papers there are");
  // Undo of my own change brings back what was before it.
  const mine = apply(doc, paperOps(a, doc, "black"));
  assert.equal(doc.paper(), "black");
  for (const op of invertDrawOps(doc, a, mine.atoms, "undo")) doc.apply(op);
  assert.equal(doc.paper(), other.paper());
});
