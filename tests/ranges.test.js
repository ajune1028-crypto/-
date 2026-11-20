import test from "node:test";
import assert from "node:assert/strict";
import { Sheet, Clock, MARK_COLORS } from "../src/core/crdt.js";
import { spliceOps, invertOps, rangeOps, unrangeOps, lockedEdit, attachSoundOps } from "../src/core/edit.js";
import { FileDoc, fileOps, FILE_PART_CHARS } from "../src/core/files.js";
import { encodeAdpcm, decodeAdpcm } from "../src/audio/adpcm.js";
import { rng, shuffle } from "./helpers.js";

function typed(text) {
  const sheet = new Sheet();
  const clock = new Clock("a");
  const ops = spliceOps(sheet, clock, { by: "m1", now: 1 }, [], 0, 0, text, false).ops;
  for (const op of ops) sheet.apply(op);
  return { sheet, clock, ops, log: [...ops] };
}
const run = (s, made) => { for (const op of made.ops) { s.sheet.apply(op); s.log.push(op); } return made; };

test("표시: a colour on chosen words; it comes off; undo and redo; the same in any order", () => {
  const s = typed("오늘 바다 갔어");
  const ids = s.sheet.ids();
  assert.deepEqual(MARK_COLORS, ["red", "orange", "yellow", "green", "blue", "navy", "purple"]);
  const mark = run(s, rangeOps(s.sheet, s.clock, "mark", { ch: ids[3], to: ids[4], c: "yellow", by: "m1" }));
  assert.deepEqual(s.sheet.marks().map((m) => [m.ch, m.to, m.c]), [[ids[3], ids[4], "yellow"]]);
  run(s, { ops: invertOps(s.sheet, s.clock, mark.atoms, "undo") });
  assert.equal(s.sheet.marks().length, 0);
  run(s, { ops: invertOps(s.sheet, s.clock, mark.atoms, "redo") });
  assert.equal(s.sheet.marks().length, 1);
  run(s, unrangeOps(s.sheet, s.clock, "mark", mark.id));
  assert.equal(s.sheet.marks().length, 0);
  assert.equal(s.sheet.apply({ t: "mark", id: s.clock.next(), ch: ids[0], to: ids[1], c: "pink", by: "m1" }), "unknown", "only the seven colours");
  for (const seed of [1, 2, 3]) {
    const other = new Sheet();
    for (const op of shuffle(rng(seed), s.log)) other.apply(op);
    assert.deepEqual(other.marks(), s.sheet.marks(), "seed " + seed);
  }
});

test("잠금: locked words cannot be changed or removed (typing at their edges is fine); unlocking frees them", () => {
  const s = typed("가나다라마");
  const ids = s.sheet.ids();
  const lock = run(s, rangeOps(s.sheet, s.clock, "lock", { ch: ids[1], to: ids[3], by: "m1" }));
  assert.deepEqual(s.sheet.locks().map((l) => [l.ch, l.to, l.by]), [[ids[1], ids[3], "m1"]]);
  // lockedEdit(sheet, ids on screen, index, deleted count): true when the change touches a locked letter.
  assert.equal(lockedEdit(s.sheet, ids, 2, 1), true, "removing 다");
  assert.equal(lockedEdit(s.sheet, ids, 0, 2), true, "removing 가나");
  assert.equal(lockedEdit(s.sheet, ids, 2, 0), true, "typing between 나 and 다");
  assert.equal(lockedEdit(s.sheet, ids, 1, 0), false, "typing before 나");
  assert.equal(lockedEdit(s.sheet, ids, 4, 0), false, "typing after 라");
  assert.equal(lockedEdit(s.sheet, ids, 4, 1), false, "removing 마");
  run(s, unrangeOps(s.sheet, s.clock, "lock", lock.id));
  assert.equal(lockedEdit(s.sheet, ids, 2, 1), false);
});

test("이 날 전체 잠그기: the whole day is locked - no letter is changed, removed or added anywhere, new days are not; it is undone and freed; the same in any order", async () => {
  const { dayLockOps } = await import("../src/core/edit.js");
  const s = typed("가나다라마");
  const ids = s.sheet.ids();
  assert.equal(s.sheet.dayLock(), null);
  const lock = run(s, dayLockOps(s.sheet, s.clock, { by: "m1", at: 5 }));
  assert.equal(s.sheet.dayLock().by, "m1");
  assert.equal(s.sheet.dayLock().id, lock.id);
  for (const [index, del, what] of [[0, 0, "typing at the start"], [5, 0, "typing at the end"], [2, 0, "typing in the middle"], [4, 1, "removing 마"], [0, 5, "removing it all"]]) {
    assert.equal(lockedEdit(s.sheet, ids, index, del), true, what);
  }
  // Undone (and done again) like a word lock; freed by unlocking.
  run(s, { ops: invertOps(s.sheet, s.clock, lock.atoms, "undo") });
  assert.equal(s.sheet.dayLock(), null);
  assert.equal(lockedEdit(s.sheet, ids, 5, 0), false);
  run(s, { ops: invertOps(s.sheet, s.clock, lock.atoms, "redo") });
  assert.ok(s.sheet.dayLock());
  run(s, unrangeOps(s.sheet, s.clock, "lock", lock.id));
  assert.equal(s.sheet.dayLock(), null);
  // A day lock on an empty day too, and a nonsense one is set aside.
  const empty = new Sheet();
  const clock = new Clock("b");
  for (const op of dayLockOps(empty, clock, { by: "m2" }).ops) empty.apply(op);
  assert.equal(lockedEdit(empty, [], 0, 0), true, "nothing can be written on a locked empty day");
  assert.equal(empty.apply({ t: "lock", id: clock.next(), ch: "0", to: "0", by: "m2", at: 1 }), "unknown", "the whole day only with all");
  for (const seed of [1, 2, 3]) {
    const other = new Sheet();
    for (const op of shuffle(rng(seed), s.log)) other.apply(op);
    assert.deepEqual(other.dayLock(), s.sheet.dayLock(), "seed " + seed);
  }
});

test("files in parts: a big file travels as several ops and is whole once every part is there, in any order", () => {
  const data = Array.from({ length: 3 * FILE_PART_CHARS + 123 }, (_, i) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[i % 64]).join("");
  const clock = new Clock("a");
  const made = fileOps(clock, { type: "audio/adpcm", data, by: "m1" });
  assert.equal(made.ops.length, 4);
  assert.ok(made.ops.every((op) => op.data.length <= FILE_PART_CHARS));
  for (const seed of [1, 2, 3]) {
    const doc = new FileDoc();
    const parts = shuffle(rng(seed), made.ops);
    for (const op of parts.slice(0, 3)) doc.apply(op);
    assert.equal(doc.file(made.id), null, "not whole yet");
    doc.apply(parts[3]);
    assert.deepEqual(doc.file(made.id), { type: "audio/adpcm", data, by: "m1" });
    assert.equal(doc.apply(parts[0]), "dup");
  }
  const doc = new FileDoc();
  for (const bad of [{ t: "fpart", id: clock.next(), f: made.id, i: 0, n: 1, type: "audio/adpcm", data: "<script>", by: "m1" }, { t: "fpart", id: clock.next(), f: made.id, i: 3, n: 2, type: "audio/adpcm", data: "AA", by: "m1" }, { t: "fpart", id: clock.next(), f: made.id, i: 0, n: 1, type: "text/html", data: "AA", by: "m1" }]) {
    assert.equal(doc.apply(bad), "unknown");
  }
});

test("a recording hidden in words points at its file and its length; bad lengths are set aside", () => {
  const s = typed("노래 불렀어");
  const ids = s.sheet.ids();
  const clock = s.clock;
  run(s, attachSoundOps(s.sheet, clock, { ch: ids[0], to: ids[1], file: "7@a", dur: 4200, by: "m1" }));
  assert.deepEqual(s.sheet.attachments().map((a) => [a.kind, a.file, a.dur]), [["sound", "7@a", 4200]]);
  assert.equal(s.sheet.apply({ t: "att", id: clock.next(), ch: ids[0], to: ids[1], kind: "sound", file: "7@a", dur: 0, by: "m1", at: 1 }), "unknown");
  assert.equal(s.sheet.apply({ t: "att", id: clock.next(), ch: ids[0], to: ids[1], kind: "sound", file: "nope", dur: 100, by: "m1", at: 1 }), "unknown");
});

test("ADPCM keeps a voice at a quarter of its size and sounds close to it", () => {
  const rate = 12000;
  const n = rate; // one second
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / rate) + 0.2 * Math.sin((2 * Math.PI * 660 * i) / rate);
  const bytes = encodeAdpcm(pcm, rate);
  assert.ok(bytes.length < n / 2 + 32, "about four bits a sample: " + bytes.length);
  const back = decodeAdpcm(bytes);
  assert.equal(back.rate, rate);
  assert.equal(back.samples.length, n);
  let sig = 0;
  let err = 0;
  for (let i = 0; i < n; i++) { sig += pcm[i] ** 2; err += (pcm[i] - back.samples[i]) ** 2; }
  const snr = 10 * Math.log10(sig / err);
  assert.ok(snr > 18, "signal to noise " + snr.toFixed(1) + " dB");
});

// ---- a recording's original, shared under the name it has on the device that made it ----------

test("a file may carry a name (a recording's own key): found by it once whole, the same in any order; of two with one name the first made is it", () => {
  const clock = new Clock("a");
  const data = "QUJD".repeat(25000); // 100,000 characters: three parts
  const made = fileOps(clock, { type: "audio/adpcm", data, by: "m1", name: "b:take1" });
  assert.equal(made.ops.length, 3);
  assert.equal(made.ops[0].name, "b:take1");
  assert.ok(made.ops.slice(1).every((op) => op.name === undefined), "the name rides on the first part only");
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
    const doc = new FileDoc();
    order.slice(0, 2).forEach((i) => doc.apply(made.ops[i]));
    assert.equal(doc.named("b:take1"), null, "not whole yet");
    assert.ok(doc.namedProgress("b:take1") > 0 || !order.slice(0, 2).includes(0), "its progress shows once the first part has come");
    doc.apply(made.ops[order[2]]);
    assert.equal(doc.named("b:take1").data, data);
    assert.equal(doc.namedProgress("b:take1"), 1);
  }
  // Two devices sent the same recording at once: everyone takes the one whose id comes first.
  const other = fileOps(new Clock("b"), { type: "audio/adpcm", data: "QUJD", by: "m2", name: "b:take1" });
  const doc = new FileDoc();
  for (const op of [...other.ops, ...made.ops]) doc.apply(op);
  const doc2 = new FileDoc();
  for (const op of [...made.ops, ...other.ops]) doc2.apply(op);
  assert.equal(doc.named("b:take1").data, doc2.named("b:take1").data);
  assert.equal(doc.named("nothing"), null);
  // A name that is not a short text is not taken; the file itself still is.
  const bad = { ...fileOps(new Clock("c"), { type: "audio/adpcm", data: "QUJD", by: "m1" }).ops[0], name: 7 };
  const doc3 = new FileDoc();
  assert.equal(doc3.apply(bad), "unknown");
});
