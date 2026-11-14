import test from "node:test";
import assert from "node:assert/strict";
import { Sheet, Clock } from "../src/core/crdt.js";
import { spliceOps, attachOps, detachOps } from "../src/core/edit.js";
import { rng, shuffle } from "./helpers.js";

const PHOTO = "data:image/jpeg;base64," + "A".repeat(200);

function typed(text) {
  const sheet = new Sheet();
  const clock = new Clock("a");
  const ops = spliceOps(sheet, clock, { by: "m1", now: 1 }, [], 0, 0, text, false).ops;
  for (const op of ops) sheet.apply(op);
  return { sheet, clock, ops };
}

test("a photo hidden in words: kept on the words it was put on, removable, the same in any order", () => {
  const { sheet, clock, ops } = typed("바다 갔던 날");
  const ids = sheet.ids();
  const att = attachOps(sheet, clock, { ch: ids[0], to: ids[1], data: PHOTO, w: 320, h: 240, by: "m1", at: 5 });
  for (const op of att.ops) sheet.apply(op);
  assert.deepEqual(sheet.attachments().map((a) => [a.ch, a.to, a.w, a.h, a.data.length]), [[ids[0], ids[1], 320, 240, PHOTO.length]]);
  const gone = detachOps(sheet, clock, att.ops[0].id);
  for (const op of gone.ops) sheet.apply(op);
  assert.equal(sheet.attachments().length, 0);
  // Another device gets everything shuffled: the photo waits for its letters, the removal for the photo.
  for (const seed of [1, 2, 3]) {
    const other = new Sheet();
    for (const op of shuffle(rng(seed), [...ops, ...att.ops])) other.apply(op);
    assert.equal(other.attachments().length, 1, "seed " + seed);
    const late = new Sheet();
    for (const op of shuffle(rng(seed), [...ops, ...att.ops, ...gone.ops])) late.apply(op);
    assert.equal(late.attachments().length, 0, "removed, seed " + seed);
  }
});

test("only small image data is taken", () => {
  const { sheet, clock } = typed("가나");
  const ids = sheet.ids();
  const bad = [
    { data: "javascript:alert(1)", w: 10, h: 10 },
    { data: "data:image/jpeg;base64," + "A".repeat(50000), w: 10, h: 10 },
    { data: PHOTO, w: 0, h: 10 },
  ];
  for (const b of bad) {
    const op = attachOps(sheet, clock, { ch: ids[0], to: ids[1], by: "m1", ...b }).ops[0];
    assert.equal(sheet.apply(op), "unknown");
  }
  assert.equal(sheet.attachments().length, 0);
});
