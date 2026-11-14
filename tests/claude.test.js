import test from "node:test";
import assert from "node:assert/strict";
import { Clock, Sheet } from "../src/core/crdt.js";
import { spliceOps } from "../src/core/edit.js";
import { ClaudeTransport } from "../src/sync/claude.js";
import { RoomSession } from "../src/sync/session.js";
import { openStore } from "../src/identity.js";
import { memoryStorage } from "../src/sync/local.js";
import { makeRuntime } from "./mocks/claude-runtime.js";
import { until, sleep } from "./helpers.js";

const ROOM = "roomroomroom";
const DOC = "s:2026-11-12";
const opts = { coalesceMs: 5, firstSnapshotMs: 500 };

async function pair(t, rt = makeRuntime()) {
  const ta = await ClaudeTransport.connect(rt.view(), opts);
  const tb = await ClaudeTransport.connect(rt.view(), opts);
  await ta.createRoom({ id: ROOM, kind: "daily-text", name: "방" });
  const a = await ta.openRoom(ROOM);
  const b = await tb.openRoom(ROOM);
  t.after(() => { a.close(); b.close(); });
  return { rt, ta, tb, a, b };
}

function typed(text, replica = "aaaaaa") {
  const sheet = new Sheet();
  return spliceOps(sheet, new Clock(replica), { by: "m1", now: 1 }, [], 0, 0, text, false).ops;
}

test("connect resolves null when the store is unavailable or never answers", async () => {
  assert.equal(await ClaudeTransport.connect(makeRuntime({ db: false }).view(), opts), null);
  assert.equal(await ClaudeTransport.connect(makeRuntime({ hang: true }).view(), { ...opts, timeoutMs: 20 }), null);
  assert.equal(await ClaudeTransport.connect({ use() { throw new Error("boom"); } }, opts), null);
});

test("a room that was never created does not open", async () => {
  const t = await ClaudeTransport.connect(makeRuntime().view(), opts);
  assert.equal(await t.openRoom("nosuchroomxx"), null);
});

test("ops reach the other view through the store alone when live messages are dropped", async (t) => {
  const rt = makeRuntime();
  rt.lossy = true;
  const { a, b } = await pair(t, rt);
  const got = [];
  b.subscribe((doc, ops) => got.push(...ops.map((o) => doc + o.v)));
  await a.append(DOC, typed("가나"));
  await until(() => got.length === 2);
  assert.deepEqual(got, [DOC + "가", DOC + "나"]);
});

test("live messages arrive before the store write finishes", async (t) => {
  const rt = makeRuntime();
  rt.writeDelayMs = 300;
  const { a, b } = await pair(t, rt);
  const got = [];
  b.subscribe((doc, ops) => got.push(...ops));
  const writing = a.append(DOC, typed("가"));
  await until(() => got.length === 1, 150);
  await writing;
});

test("a late joiner sees which docs exist and loads all of each", async (t) => {
  const { rt, a } = await pair(t);
  await a.append(DOC, typed("가나다"));
  await a.append("room", [{ t: "meta", id: "1@aaaaaa", k: "name", v: "방" }]);
  const tc = await ClaudeTransport.connect(rt.view(), opts);
  const c = await tc.openRoom(ROOM);
  t.after(() => c.close());
  assert.deepEqual((await c.docs()).sort(), ["room", DOC].sort());
  assert.equal((await c.load(DOC)).length, 3);
  assert.equal((await c.load("s:1999-01-01")).length, 0);
});

test("history is not pushed through subscribe when a view opens", async (t) => {
  const { rt, a } = await pair(t);
  await a.append(DOC, typed("옛날 글"));
  const tc = await ClaudeTransport.connect(rt.view(), opts);
  const c = await tc.openRoom(ROOM);
  t.after(() => c.close());
  let pushed = 0;
  c.subscribe(() => pushed++);
  await c.load(DOC);
  await sleep(30);
  assert.equal(pushed, 0);
});

test("a 5,000-character paste keeps every live message under 3,500 bytes and still converges", async (t) => {
  const { rt, a, b } = await pair(t);
  const ops = typed("가나다 ".repeat(1250));
  const sheet = new Sheet();
  b.subscribe((doc, got) => sheet.applyAll(got));
  await a.append(DOC, ops);
  await until(() => sheet.text().length === 5000, 4000);
  assert.ok(rt.sent.every((m) => m.bytes <= 3500), "largest " + Math.max(0, ...rt.sent.map((m) => m.bytes)));
  assert.ok(rt.sent.length <= 20, "live burst " + rt.sent.length);
});

test("chunks roll over at 200 ops and no chunk nears the document size limit", async (t) => {
  const { rt, a } = await pair(t);
  await a.append(DOC, typed("x".repeat(450)));
  const chunks = [...rt.store.entries()].filter(([path]) => path.startsWith(`rooms/${ROOM}/logs/`)).map(([, d]) => d);
  assert.deepEqual(chunks.map((c) => c.ops.length).sort((x, y) => y - x), [200, 200, 50]);
  assert.ok(chunks.every((c) => c.d === DOC && JSON.stringify(c).length < 60000));
});

test("a rejected write rejects the append, and appending again stores the ops once", async (t) => {
  const { rt, a } = await pair(t);
  rt.failWrites = 1;
  const ops = typed("가");
  await assert.rejects(a.append(DOC, ops));
  await a.append(DOC, ops);
  const stored = [...rt.store.entries()].filter(([path]) => path.includes("/logs/")).flatMap(([, d]) => d.ops);
  assert.equal(stored.length, 1);
});

test("rooms created by one view are listed by another", async (t) => {
  const { tb } = await pair(t);
  assert.deepEqual((await tb.listRooms()).map((r) => [r.id, r.kind, r.name]), [[ROOM, "daily-text", "방"]]);
});

test("presence shows the other screen and marks only this screen as me", async (t) => {
  const { a, b } = await pair(t);
  let peers = [];
  b.onPresence((p) => { peers = p; });
  a.setPresence({ m: "m1", i: "3@x" });
  await until(() => peers.some((p) => !p.isMe && p.state.m === "m1"));
  assert.equal(peers.filter((p) => p.isMe).length, 1);
});

test("without a live channel the transport still works through the store", async (t) => {
  const rt = makeRuntime({ room: false });
  const { a, b } = await pair(t, rt);
  const got = [];
  b.subscribe((doc, ops) => got.push(...ops));
  await a.append(DOC, typed("가"));
  await until(() => got.length === 1);
  assert.equal(a.transport.info().live, "none");
});

test("two sessions over the trial transport converge, and a failed write goes offline then online", async (t) => {
  const rt = makeRuntime();
  const ta = await ClaudeTransport.connect(rt.view(), opts);
  const tb = await ClaudeTransport.connect(rt.view(), opts);
  await ta.createRoom({ id: ROOM, kind: "daily-text", name: "방" });
  const mk = (tr) => new RoomSession({ transport: tr, roomId: ROOM, store: openStore(memoryStorage()), retry: [5, 5] });
  const a = mk(ta);
  const b = mk(tb);
  t.after(() => { a.close(); b.close(); });
  assert.equal(await a.open(), "ok");
  assert.equal(await b.open(), "ok");
  await b.loadSheet("2026-11-12");
  const statuses = [];
  a.on("status", (s) => statuses.push(s));
  rt.failWrites = 1;
  const sheet = a.sheet("2026-11-12");
  a.commit(DOC, spliceOps(sheet, a.clock, { by: "m1", now: 1 }, [], 0, 0, "같이 써요", false).ops);
  await until(() => a.pending === 0 && b.sheet("2026-11-12").text() === "같이 써요");
  assert.deepEqual(statuses, ["offline", "online"]);
  assert.equal(ta.info().kind, "claude");
});

test("a viewer who may not write is reported as read-only, and recovers when a write succeeds", async (t) => {
  const { rt, ta, a } = await pair(t);
  rt.denyWrites = true;
  await assert.rejects(a.append(DOC, typed("가")));
  assert.equal(ta.info().db, "read-only");
  assert.equal(ta.readOnly, true);
  rt.denyWrites = false;
  await a.append(DOC, typed("가"));
  assert.equal(ta.info().db, "ok");
});

test("a full store is reported as full until a write goes through again", async (t) => {
  const { rt, ta, a } = await pair(t);
  rt.full = true;
  await assert.rejects(a.append(DOC, typed("가")));
  assert.equal(ta.full, true);
  assert.equal(ta.info().db, "full");
  rt.full = false;
  await a.append(DOC, typed("가"));
  assert.equal(ta.full, false);
});

// ---- a store that misbehaves ---------------------------------------------------

test("the store is ready as soon as it answers, even when the live channel never does", async () => {
  const log = [];
  const t0 = Date.now();
  const t = await ClaudeTransport.connect(makeRuntime({ hangRoom: true }).view(), { ...opts, timeoutMs: 400, log: (line) => log.push(line) });
  assert.ok(t, "connected");
  assert.ok(Date.now() - t0 < 200, "did not wait for the live channel: " + (Date.now() - t0) + " ms");
  assert.equal(t.info().live, "none");
  await t.createRoom({ id: ROOM, kind: "daily-text", name: "방" });
  const channel = await t.openRoom(ROOM);
  await channel.append(DOC, typed("가"));
  // load() reads what the store's snapshots have delivered, which follows the write.
  await until(async () => (await channel.load(DOC)).length === 1);
  assert.deepEqual((await channel.load(DOC)).map((o) => o.v), ["가"]);
  channel.close();
  await until(() => log.some((line) => line.startsWith("live none")));
  assert.ok(log.some((line) => line.startsWith("db ok")), log.join(" | "));
});

test("a live channel that answers late is joined by rooms that are already open", async (t) => {
  const rt = makeRuntime({ roomDelayMs: 60 });
  const ta = await ClaudeTransport.connect(rt.view(), opts);
  const tb = await ClaudeTransport.connect(rt.view(), opts);
  await ta.createRoom({ id: ROOM, kind: "daily-text", name: "방" });
  const a = await ta.openRoom(ROOM);
  const b = await tb.openRoom(ROOM);
  t.after(() => { a.close(); b.close(); });
  assert.equal(ta.info().live, "none");
  await until(() => ta.info().live === "connected" && tb.info().live === "connected");
  rt.writeDelayMs = 300;
  const got = [];
  b.subscribe((doc, ops) => got.push(...ops));
  const writing = a.append(DOC, typed("가"));
  await until(() => got.length === 1, 150);
  await writing;
});

test("creating a room gives up with code timeout when the store never answers", async () => {
  const rt = makeRuntime();
  const t = await ClaudeTransport.connect(rt.view(), { ...opts, callTimeoutMs: 40 });
  rt.hangWrites = true;
  const t0 = Date.now();
  await assert.rejects(t.createRoom({ id: ROOM, kind: "daily-text", name: "방" }), (err) => err.code === "timeout");
  assert.ok(Date.now() - t0 < 400);
  assert.match(t.info().lastError, /^create: timeout/);
});

test("listing and opening rooms give up with code timeout when reads never answer", async () => {
  const rt = makeRuntime();
  const t = await ClaudeTransport.connect(rt.view(), { ...opts, callTimeoutMs: 40 });
  await t.createRoom({ id: ROOM, kind: "daily-text", name: "방" });
  rt.hangReads = true;
  await assert.rejects(t.listRooms(), (err) => err.code === "timeout");
  await assert.rejects(t.openRoom(ROOM), (err) => err.code === "timeout");
});

test("creating a room tries once more when the platform says unavailable, and reports any other refusal", async () => {
  const rt = makeRuntime();
  const t = await ClaudeTransport.connect(rt.view(), { ...opts, retryMs: 5 });
  rt.failWrites = 1;
  await t.createRoom({ id: ROOM, kind: "daily-text", name: "방" });
  assert.equal(rt.writes, 2);
  assert.equal((await t.listRooms()).length, 1);
  rt.rejectWrites = "capability_disabled";
  await assert.rejects(t.createRoom({ id: "otherotherxx", kind: "daily-text", name: "방" }), (err) => err.code === "capability_disabled");
  assert.match(t.info().lastError, /^create: capability_disabled/);
});

test("a chunk write that never answers rejects the append instead of blocking the room", async (t) => {
  const rt = makeRuntime();
  const ta = await ClaudeTransport.connect(rt.view(), { ...opts, callTimeoutMs: 40 });
  await ta.createRoom({ id: ROOM, kind: "daily-text", name: "방" });
  const a = await ta.openRoom(ROOM);
  t.after(() => a.close());
  rt.hangWrites = true;
  await assert.rejects(a.append(DOC, typed("가")), /timeout/);
  rt.hangWrites = false;
  await a.append(DOC, typed("가"));
  await until(async () => (await a.load(DOC)).length === 1);
  assert.deepEqual((await a.load(DOC)).map((o) => o.v), ["가"]);
});

test("a room that could not be finished can be dropped from the store", async () => {
  const rt = makeRuntime();
  const t = await ClaudeTransport.connect(rt.view(), opts);
  await t.createRoom({ id: ROOM, kind: "daily-text", name: "방" });
  await t.dropRoom(ROOM);
  assert.equal((await t.listRooms()).length, 0);
});

test("the stand-in store is as strict as the real one about paths and frozen data", async () => {
  const rt = makeRuntime();
  const db = await rt.view().use("db");
  assert.throws(() => db.doc("rooms"), TypeError);
  assert.throws(() => db.collection("rooms/abc"), TypeError);
  assert.throws(() => db.doc("rooms/has space"), TypeError);
  await db.doc("rooms/abc").set({ list: [{ n: 1 }] });
  const data = (await db.doc("rooms/abc").get()).data();
  assert.throws(() => { data.list[0].n = 2; }, TypeError);
});
