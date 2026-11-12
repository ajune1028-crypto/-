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
