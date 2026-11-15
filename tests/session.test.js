import test from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/core/crdt.js";
import { spliceOps } from "../src/core/edit.js";
import { createRoomOps } from "../src/core/room.js";
import { LocalTransport, memoryStorage } from "../src/sync/local.js";
import { RoomSession } from "../src/sync/session.js";
import { openStore, DEFAULT_SETTINGS, rememberRoom, roomEntry, forgetRoom } from "../src/identity.js";
import { until, sleep } from "./helpers.js";

const DAY = "2026-11-12";
const DOC = "s:" + DAY;
let seq = 0;

/** One browser: shared storage; each `device()` is a tab with its own transport and session. */
function world(t) {
  const storage = memoryStorage();
  const ns = "t" + ++seq;
  const open = [];
  t.after(() => open.forEach((x) => x.close()));
  const transport = (opts = {}) => { const tr = new LocalTransport({ ns, storage, ...opts }); open.push(tr); return tr; };
  const session = (tr, roomId, store = openStore(memoryStorage()), extra = {}) => {
    const s = new RoomSession({ transport: tr, roomId, store, retry: [5, 5, 5], ...extra });
    open.push(s);
    return s;
  };
  return { storage, transport, session };
}

async function makeRoom(tr, session, id = "roomroomroom") {
  await tr.createRoom({ id, kind: "daily-text", name: "방" });
  const s = session(tr, id);
  assert.equal(await s.open(), "ok");
  s.commit("room", createRoomOps(s.clock, { kind: "daily-text", name: "방", tz: "Asia/Seoul", now: 1, memberId: "m1", memberName: "가", pin: null }));
  return s;
}

function type(s, text, by = "m1") {
  const sheet = s.sheet(DAY);
  const r = spliceOps(sheet, s.clock, { by, now: 1 }, sheet.ids().slice(), sheet.text().length, 0, text, false);
  s.commit(DOC, r.ops);
}

test("opening a room that does not exist resolves 'missing'", async (t) => {
  const w = world(t);
  assert.equal(await w.session(w.transport(), "nosuchroomxx").open(), "missing");
});

test("a new session loads what was written before it opened", async (t) => {
  const w = world(t);
  const a = await makeRoom(w.transport(), w.session);
  type(a, "안녕");
  await until(() => a.pending === 0);
  const b = w.session(w.transport(), "roomroomroom");
  assert.equal(await b.open(), "ok");
  assert.equal(b.room.meta("name"), "방");
  assert.deepEqual(b.days(), [DAY]);
  assert.equal((await b.loadSheet(DAY)).text(), "안녕");
});

test("two sessions on one namespace converge while both are open", async (t) => {
  const w = world(t);
  const a = await makeRoom(w.transport(), w.session);
  const b = w.session(w.transport(), "roomroomroom");
  await b.open();
  await b.loadSheet(DAY);
  let changes = 0;
  b.on("change", () => changes++);
  type(a, "하나 ");
  type(b, "둘 ", "m2");
  type(a, "셋");
  await until(() => a.sheet(DAY).text() === b.sheet(DAY).text() && a.sheet(DAY).text().length === 6);
  assert.ok(changes > 0);
  assert.deepEqual(a.sheet(DAY).ids(), b.sheet(DAY).ids());
});

test("a sheet nobody loaded yet is loaded when live ops for it arrive", async (t) => {
  const w = world(t);
  const a = await makeRoom(w.transport(), w.session);
  type(a, "먼저 ");
  await until(() => a.pending === 0);
  const b = w.session(w.transport(), "roomroomroom");
  await b.open();
  type(a, "나중");
  await until(() => b.sheet(DAY).text() === "먼저 나중");
});

test("offline edits are delivered after going online", async (t) => {
  const w = world(t);
  const trA = w.transport();
  const a = await makeRoom(trA, w.session);
  const b = w.session(w.transport(), "roomroomroom");
  await b.open();
  await b.loadSheet(DAY);
  await until(() => a.pending === 0);
  const seen = [];
  a.on("status", (s) => seen.push(s));
  trA.setOffline(true);
  type(a, "끊긴 채로 씀");
  type(b, "상대는 계속 씀 ", "m2");
  await sleep(40);
  assert.equal(a.sheet(DAY).text(), "끊긴 채로 씀");
  assert.ok(a.pending > 0);
  assert.ok(!b.sheet(DAY).text().includes("끊긴"));
  trA.setOffline(false);
  await until(() => a.pending === 0 && a.sheet(DAY).text() === b.sheet(DAY).text());
  assert.ok(b.sheet(DAY).text().includes("끊긴 채로 씀") && b.sheet(DAY).text().includes("상대는 계속 씀"));
  assert.deepEqual(seen, ["offline", "online"]);
});

test("the outbox survives closing and reopening", async (t) => {
  const w = world(t);
  const trA = w.transport();
  const a = await makeRoom(trA, w.session);
  await until(() => a.pending === 0);
  const store = openStore(memoryStorage());
  const a2 = w.session(trA, "roomroomroom", store);
  await a2.open();
  trA.setOffline(true);
  type(a2, "저장 안 된 글");
  assert.ok(a2.pending > 0);
  a2.close();
  trA.setOffline(false);
  const a3 = w.session(trA, "roomroomroom", store);
  await a3.open();
  await until(() => a3.pending === 0);
  const b = w.session(w.transport(), "roomroomroom");
  await b.open();
  assert.equal((await b.loadSheet(DAY)).text(), "저장 안 된 글");
  assert.deepEqual(store.get("outbox:roomroomroom", []), []);
});

test("two tabs sharing one device store never make the same id", async (t) => {
  const w = world(t);
  const tr = w.transport();
  const a = await makeRoom(tr, w.session);
  const store = openStore(memoryStorage());
  const x = w.session(w.transport(), "roomroomroom", store);
  const y = w.session(w.transport(), "roomroomroom", store);
  await x.open();
  await y.open();
  assert.notEqual(x.clock.replica, y.clock.replica);
  await x.loadSheet(DAY);
  await y.loadSheet(DAY);
  type(x, "가나다", "m1");
  type(y, "abc", "m1");
  await until(() => [a, x, y].every((s) => s.sheet(DAY).text().length === 6 && s.sheet(DAY).text() === a.sheet(DAY).text()));
  assert.equal(new Set(a.sheet(DAY).ids()).size, 6);
});

test("presence reaches the other session and goes away on close", async (t) => {
  const w = world(t);
  const a = await makeRoom(w.transport(), w.session);
  const b = w.session(w.transport(), "roomroomroom");
  await b.open();
  a.setPresence({ m: "m1", i: "5@x" });
  await until(() => b.peers.some((p) => !p.isMe && p.state.m === "m1" && p.state.i === "5@x"));
  assert.equal(b.peers.filter((p) => p.isMe).length, 1);
  a.close();
  await until(() => b.peers.every((p) => p.isMe));
});

test("ops of an unknown kind raise 'unknown' once and do not break the sheet", async (t) => {
  const w = world(t);
  const a = await makeRoom(w.transport(), w.session);
  let raised = 0;
  a.on("unknown", () => raised++);
  type(a, "글");
  a.receive(DOC, [{ t: "future-thing", id: "999@zzzzzz" }, { t: "another", id: "1000@zzzzzz" }]);
  a.receive(DOC, [{ t: "future-thing", id: "1001@zzzzzz" }]);
  assert.equal(raised, 1);
  assert.equal(a.sheet(DAY).text(), "글");
});

test("a store over storage that throws is unavailable but still works from memory", () => {
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() {} };
  const store = openStore(broken);
  assert.equal(store.available, false);
  assert.deepEqual(store.get("settings", DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.theme, "system");
  assert.equal(DEFAULT_SETTINGS.songMode, "piano", "the song room starts on piano");
  store.set("last", { name: "가", pin: "12345" });
  assert.deepEqual(store.get("last", null), { name: "가", pin: "12345" });
});

test("a store keeps values across instances over the same storage, under its prefix", () => {
  const storage = memoryStorage();
  const one = openStore(storage, "devA:");
  assert.equal(one.available, true);
  rememberRoom(one, { id: "r1", kind: "daily-text", name: "방", memberId: "m1" }, 10);
  rememberRoom(one, { id: "r2", kind: "daily-text", name: "둘", memberId: "m2" }, 20);
  rememberRoom(one, { id: "r1", kind: "daily-text", name: "방 새이름", memberId: "m1" }, 30);
  const again = openStore(storage, "devA:");
  assert.deepEqual(again.get("rooms", []).map((r) => r.id), ["r1", "r2"]);
  assert.equal(roomEntry(again, "r1").name, "방 새이름");
  assert.equal(roomEntry(openStore(storage, "devB:"), "r1"), null);
  forgetRoom(again, "r1");
  assert.deepEqual(openStore(storage, "devA:").get("rooms", []).map((r) => r.id), ["r2"]);
});

test("a remembered room keeps who is in it (their colours) for home, until it is told again", () => {
  const store = openStore(memoryStorage(), "p:");
  rememberRoom(store, { id: "r1", kind: "daily-text", name: "방", memberId: "m1", people: ["red", "blue"] }, 10);
  assert.deepEqual(roomEntry(store, "r1").people, ["red", "blue"]);
  rememberRoom(store, { id: "r1", kind: "daily-text", name: "방 새이름", memberId: "m1" }, 20);
  assert.deepEqual(roomEntry(store, "r1").people, ["red", "blue"], "an entry told without people keeps the ones it knew");
  rememberRoom(store, { id: "r1", kind: "daily-text", name: "방", memberId: "m1", people: ["red", "blue", "green", "teal", "pink", "olive", "brown"] }, 30);
  assert.deepEqual(roomEntry(store, "r1").people, ["red", "blue", "green", "teal", "pink", "olive"], "six at most");
});

test("the local transport works where BroadcastChannel is refused", async (t) => {
  const real = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = class { constructor() { throw new Error("refused"); } };
  t.after(() => { globalThis.BroadcastChannel = real; });
  const tr = new LocalTransport({ ns: "nobus", storage: memoryStorage() });
  t.after(() => tr.close());
  await tr.createRoom({ id: "roomroomroom", kind: "daily-text", name: "방" });
  const s = new RoomSession({ transport: tr, roomId: "roomroomroom", store: openStore(memoryStorage()), retry: [5] });
  t.after(() => s.close());
  assert.equal(await s.open(), "ok");
  type(s, "혼자서도 써져요");
  await until(() => s.pending === 0);
  assert.equal(s.sheet(DAY).text(), "혼자서도 써져요");
});

test("a song document travels between screens like the sheets do", async (t) => {
  const { SongDoc, sourceOp, addClipOps } = await import("../src/core/song.js");
  const w = world(t);
  const a = await makeRoom(w.transport(), w.session);
  const b = w.session(w.transport(), "roomroomroom");
  await b.open();
  const songB = await b.load("song");
  assert.ok(songB instanceof SongDoc);
  const songA = await a.load("song");
  const src = sourceOp(a.clock, songA, { duration: 1, notes: [{ t: 0, d: 0.5, p: 60, v: 1 }], peaks: "", by: "m1", at: 1 });
  a.commit("song", [src]);
  a.commit("song", addClipOps(a.clock, songA, { src: src.id, row: 0, start: 0, length: 1000, by: "m1", at: 1 }).ops);
  await until(() => songB.layout().length === 1);
  assert.equal(songB.source(src.id).notes[0].p, 60);
  // A third screen opened later reads the whole song from storage.
  await until(() => a.pending === 0);
  const c = w.session(w.transport(), "roomroomroom");
  await c.open();
  assert.equal((await c.load("song")).layout().length, 1);
});

test("documents no type claims are ignored", async (t) => {
  const w = world(t);
  const a = await makeRoom(w.transport(), w.session);
  assert.equal(a.doc("nonsense"), null);
  a.commit("nonsense", [{ t: "x", id: a.clock.next() }]);
  assert.equal(a.doc("nonsense"), null);
});
