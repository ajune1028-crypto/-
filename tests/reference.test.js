import test from "node:test";
import assert from "node:assert/strict";
import { refSounds, addRefSound, removeRefSound, refNotes, addRefNote } from "../src/reference.js";

const memoryStore = () => {
  const data = new Map();
  return { get: (k, d) => (data.has(k) ? structuredClone(data.get(k)) : d), set: (k, v) => data.set(k, structuredClone(v)) };
};

test("레퍼런스 recordings: kept newest first on this device, at most 50, removable; notes stay apart", () => {
  const store = memoryStore();
  addRefNote(store, "가사 한 줄");
  const first = addRefSound(store, { name: "흥얼 1", dur: 2.5, notes: [{ t: 0.1, d: 0.4, p: 60, v: 0.8 }], peaks: "AAA=", blob: "b1" }, 1000);
  const second = addRefSound(store, { name: null, dur: 1.2, notes: [], peaks: "", blob: "b2" }, 2000);
  assert.deepEqual(refSounds(store).map((s) => [s.id, s.blob, s.name]), [[second.id, "b2", "녹음"], [first.id, "b1", "흥얼 1"]]);
  assert.equal(refNotes(store).length, 1, "text notes are kept apart");
  removeRefSound(store, first.id);
  assert.deepEqual(refSounds(store).map((s) => s.blob), ["b2"]);
  for (let i = 0; i < 60; i++) addRefSound(store, { name: "n" + i, dur: 1, notes: [], peaks: "", blob: "x" + i }, 3000 + i);
  assert.equal(refSounds(store).length, 50);
});
