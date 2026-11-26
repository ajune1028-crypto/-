import test from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/core/crdt.js";
import { FileDoc, fileOps, missingParts, partOps } from "../src/core/files.js";
import { shareTake, shareDone } from "../src/ui/share-take.js";
import { encodeWav } from "../src/audio/wav.js";

/** A device: its own blob store, and a session on a room whose files doc is shared by reference. */
function device(files, blobs = new Map()) {
  const clock = new Clock("d" + Math.random().toString(36).slice(2, 6));
  const sent = [];
  const session = {
    clock, memberId: "m1", docs: {}, transport: {}, partPauseMs: 0,
    load: async (doc) => (doc === "files" ? files : null),
    commit: (doc, ops) => { if (doc === "files") { for (const op of ops) files.apply(op); sent.push(...ops); } },
  };
  const app = { transport: {}, blobs: { get: async (key) => blobs.get(key) || null } };
  return { app, session, sent, blobs };
}
const tone = (seconds, rate = 24000) => Float32Array.from({ length: seconds * rate }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate));

test("files: the parts a file still lacks, and ops that send just those under the same file", () => {
  const doc = new FileDoc();
  const clock = new Clock("a");
  const data = "A".repeat(100000);
  const made = fileOps(clock, { type: "audio/adpcm", data, by: "m1", name: "take-1" });
  doc.apply(made.ops[0]);
  doc.apply(made.ops[2]);
  const m = missingParts(doc, "take-1");
  assert.deepEqual(m.missing, [1]);
  assert.equal(m.n, 3);
  const more = partOps(clock, { f: m.f, n: m.n, type: "audio/adpcm", data, by: "m1", only: m.missing });
  assert.equal(more.length, 1);
  for (const op of more) doc.apply(op);
  assert.equal(doc.named("take-1").data, data, "whole again");
  assert.equal(missingParts(doc, "nothing"), null);
});

test("a take whose sending was cut short is finished by the device with the original when it opens the room again", async () => {
  const files = new FileDoc();
  const blobs = new Map([["take-1", { data: encodeWav(tone(12), 24000) }]]);
  // First visit: only the first part made it before the room was left.
  const first = device(files, blobs);
  first.session.commit = (doc, ops) => { if (doc === "files" && !first.cut) { files.apply(ops[0]); first.cut = true; } };
  shareTake(first.app, first.session, "take-1");
  await shareDone(first.session);
  assert.ok(files.namedProgress("take-1") > 0 && files.namedProgress("take-1") < 1, "half sent");
  // Later, a new visit on the same device: the rest goes, and only the rest.
  const again = device(files, blobs);
  shareTake(again.app, again.session, "take-1");
  await shareDone(again.session);
  assert.equal(files.namedProgress("take-1"), 1, "whole");
  assert.ok(again.sent.every((op) => op.i > 0), "the part already there was not sent again");
});

test("a take not found on this device yet is tried again later, not given up for good", async () => {
  const files = new FileDoc();
  const blobs = new Map();
  const d = device(files, blobs);
  shareTake(d.app, d.session, "take-2");
  await shareDone(d.session);
  assert.equal(files.namedProgress("take-2"), 0);
  blobs.set("take-2", { data: encodeWav(tone(2), 24000) });
  shareTake(d.app, d.session, "take-2");
  await shareDone(d.session);
  assert.equal(files.namedProgress("take-2"), 1);
});

// A room kept on this device only (no server named: the public address before Firebase) has nobody
// to send the sound to, and the take is already here: a copy in the room's files would only fill the
// device's small store (localStorage, about 5 MB) until nothing more could be kept.
test("a room on this device only sends no copy of the take", async () => {
  const files = new FileDoc();
  const blobs = new Map([["take-3", { data: encodeWav(tone(3), 24000) }]]);
  const d = device(files, blobs);
  const here = { local: true };
  Object.assign(d.app, { limited: true, transport: here, local: () => here });
  d.session.transport = here;
  shareTake(d.app, d.session, "take-3");
  await shareDone(d.session);
  assert.equal(d.sent.length, 0);
  assert.equal(files.namedProgress("take-3"), 0);
  // The same device with a shared room (test devices share theirs, a server, the trial page) sends it.
  const shared = device(files, blobs);
  Object.assign(shared.app, { limited: false, transport: here, local: () => here });
  shared.session.transport = here;
  shareTake(shared.app, shared.session, "take-3");
  await shareDone(shared.session);
  assert.equal(files.namedProgress("take-3"), 1);
});

// The owner (26 November): "원본이 아직 오지 않았어요… 다른 사람이 올린 것도 못 봐". A whole song put in (five
// minutes) was never sent at all: the room's files took about four minutes at most and the rest was
// skipped without a word. Now long takes go too (fifteen minutes at 16 kHz, then 8 kHz up to thirty).
test("a five-minute take goes to the room too (it used to be skipped without a word); a twenty-minute one goes at a lower rate", async () => {
  const files = new FileDoc();
  const blobs = new Map([["long-take", { data: encodeWav(tone(300, 16000), 16000) }], ["very-long", { data: encodeWav(tone(1200, 8000), 8000) }]]);
  const d = device(files, blobs);
  shareTake(d.app, d.session, "long-take");
  shareTake(d.app, d.session, "very-long");
  await shareDone(d.session);
  assert.equal(files.namedProgress("long-take"), 1, "five minutes: whole in the room");
  assert.equal(files.namedProgress("very-long"), 1, "twenty minutes: whole in the room");
  const { decodeAdpcm } = await import("../src/audio/adpcm.js");
  const { fromBase64 } = await import("../src/core/b64.js");
  const five = decodeAdpcm(fromBase64(files.named("long-take").data));
  assert.equal(five.rate, 16000);
  assert.ok(Math.abs(five.samples.length / five.rate - 300) < 1, "all five minutes: " + five.samples.length / five.rate);
  const twenty = decodeAdpcm(fromBase64(files.named("very-long").data));
  assert.equal(twenty.rate, 8000, "a very long one at 8 kHz");
  assert.ok(Math.abs(twenty.samples.length / twenty.rate - 1200) < 1);
});
