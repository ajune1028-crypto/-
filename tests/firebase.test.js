import test from "node:test";
import assert from "node:assert/strict";
import { startFakeFirebase } from "./mocks/fake-firebase.mjs";
import { FirebaseTransport, serverFrom } from "../src/sync/firebase.js";
import { RoomSession } from "../src/sync/session.js";
import { memoryStorage } from "../src/sync/local.js";
import { openStore } from "../src/identity.js";
import { Clock } from "../src/core/crdt.js";
import { createRoomOps } from "../src/core/room.js";
import { spliceOps } from "../src/core/edit.js";

const ROOM = "abcdefghijk2";
const fast = { callTimeoutMs: 1500, heartbeatMs: 200, peerTimeoutMs: 900, quietMs: 1500, retry: [50, 100, 200] };
const until = async (check, ms = 3000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 15));
  }
};

async function setup(t, options = {}) {
  const server = await startFakeFirebase(options);
  const made = [];
  const transport = () => {
    const tr = new FirebaseTransport(server.url, fast);
    made.push(tr);
    return tr;
  };
  t.after(async () => {
    for (const tr of made) tr.close();
    await server.close();
  });
  return { server, transport };
}

test("the server address: only a plain https database address (or a test server on this machine) is taken", () => {
  assert.equal(serverFrom("https://hamkke-1-default-rtdb.asia-southeast1.firebasedatabase.app/"), "https://hamkke-1-default-rtdb.asia-southeast1.firebasedatabase.app");
  assert.equal(serverFrom("https://hamkke-1.firebaseio.com"), "https://hamkke-1.firebaseio.com");
  assert.equal(serverFrom("http://127.0.0.1:9000"), "http://127.0.0.1:9000");
  for (const bad of ["", "http://evil.example", "https://evil.example/x", "javascript:alert(1)", "https://a.firebaseio.com/rooms", null]) assert.equal(serverFrom(bad), null, String(bad));
});

test("a room made on one device opens on another by its id; a wrong id is missing; rooms are never listed", async (t) => {
  const { server, transport } = await setup(t);
  const a = transport();
  const b = transport();
  await a.createRoom({ id: ROOM, kind: "daily-text", name: "우리 방" });
  await a.createRoom({ id: ROOM, kind: "daily-text", name: "우리 방" }); // again: nothing changes, no error
  assert.ok(await b.openRoom(ROOM));
  assert.equal(await b.openRoom("zzzzzzzzzzzz"), null);
  assert.deepEqual(await b.listRooms(), []);
  assert.ok(!server.requests.some((r) => r === "GET /rooms"), "the list of rooms is never asked for");
  assert.equal(server.data().rooms[ROOM].meta.name, "우리 방");
  assert.equal(b.info().kind, "firebase");
});

test("ops stored on one device reach the other at once and load later exactly as written", async (t) => {
  const { transport } = await setup(t);
  const a = transport();
  await a.createRoom({ id: ROOM, kind: "creative-board", name: "보드" });
  const ca = await a.openRoom(ROOM);
  const cb = await transport().openRoom(ROOM);
  const got = [];
  cb.subscribe((doc, ops) => got.push([doc, ops]));
  assert.deepEqual(await cb.load("board"), []);
  // Arrays, empty lists and nested objects: the database would mangle them; they arrive as written.
  const ops = [{ t: "lasso", id: "1@a", pts: [0, 0, 100, 0, 100, 100], by: "m1" }, { t: "x", id: "2@a", list: [], deep: { a: [1, [2, 3]], e: {} } }];
  await ca.append("board", ops);
  await until(() => got.length);
  assert.deepEqual(got[0], ["board", ops]);
  await ca.append("s:2026-11-15", [{ t: "ins", id: "3@a" }]);
  assert.deepEqual((await until(async () => (await cb.docs()).includes("s:2026-11-15") && (await cb.docs()))).sort(), ["board", "s:2026-11-15"]);
  const late = await transport().openRoom(ROOM);
  assert.deepEqual(await late.load("board"), ops);
  assert.deepEqual(await late.load("s:2026-11-15"), [{ t: "ins", id: "3@a" }]);
});

test("each screen sees who else is here; one that closes leaves; one that goes silent is dropped", async (t) => {
  const { server, transport } = await setup(t);
  const a = transport();
  await a.createRoom({ id: ROOM, kind: "daily-text", name: "방" });
  const ca = await a.openRoom(ROOM);
  const cb = await transport().openRoom(ROOM);
  let seen = [];
  cb.onPresence((peers) => (seen = peers));
  ca.setPresence({ m: "m1", caret: 3 });
  cb.setPresence({ m: "m2" });
  await until(() => seen.some((p) => !p.isMe && p.state.m === "m1"));
  assert.deepEqual(seen.find((p) => p.isMe).state, { m: "m2" });
  ca.close();
  await until(() => !seen.some((p) => !p.isMe));
  // A screen that vanishes without saying goodbye (its stream cut, no heartbeats) times out.
  const cc = await transport().openRoom(ROOM);
  cc.setPresence({ m: "m3" });
  await until(() => seen.some((p) => p.state.m === "m3"));
  cc.stopBeating();
  await until(() => !seen.some((p) => p.state.m === "m3"), 4000);
  void server;
});

test("a cut connection is noticed and mended; what was stored meanwhile is there after it comes back", async (t) => {
  const { server, transport } = await setup(t);
  const a = transport();
  await a.createRoom({ id: ROOM, kind: "daily-text", name: "방" });
  const ca = await a.openRoom(ROOM);
  const cb = await transport().openRoom(ROOM);
  await cb.load("room");
  const status = [];
  cb.onStatus((s) => status.push(s));
  server.setDown(true);
  await until(() => status.includes("offline"));
  await assert.rejects(ca.append("room", [{ t: "a", id: "1@a" }]));
  server.setDown(false);
  await ca.append("room", [{ t: "a", id: "1@a" }]);
  await until(() => status[status.length - 1] === "online", 4000);
  assert.deepEqual(await cb.load("room"), [{ t: "a", id: "1@a" }]);
});

test("a server that never answers: opening gives up after the time limit with a reason", async (t) => {
  const { server, transport } = await setup(t);
  server.hang(true);
  const t0 = Date.now();
  await assert.rejects(transport().openRoom(ROOM), (err) => err.code === "timeout");
  assert.ok(Date.now() - t0 < 3000);
});

test("what the rules refuse fails with a reason, and nothing stored is overwritten", async (t) => {
  const { server, transport } = await setup(t);
  const a = transport();
  await a.createRoom({ id: ROOM, kind: "daily-text", name: "처음 이름" });
  await assert.rejects(a.call("PUT", `rooms/${ROOM}/meta`, { id: ROOM, kind: "daily-text", name: "바꾼 이름", at: 1 }), (err) => err.code === "permission");
  await assert.rejects(a.call("GET", "rooms"), (err) => err.code === "permission");
  assert.equal(server.data().rooms[ROOM].meta.name, "처음 이름");
});

test("two room sessions over the database: what one types the other shows, and a third reads it all later", async (t) => {
  const { transport } = await setup(t);
  const people = [];
  const session = async () => {
    const s = new RoomSession({ transport: transport(), roomId: ROOM, store: openStore(memoryStorage(), "t:"), retry: [50, 100] });
    people.push(s);
    assert.equal(await s.open(), "ok");
    return s;
  };
  const maker = transport();
  await maker.createRoom({ id: ROOM, kind: "daily-text", name: "방" });
  const a = await session();
  a.commit("room", createRoomOps(a.clock, { kind: "daily-text", name: "방", tz: "Asia/Seoul", memberId: "m1", memberName: "가람", now: Date.now() }));
  const b = await session();
  const day = "s:2026-11-15";
  const sheet = (await a.load(day));
  a.commit(day, spliceOps(sheet, a.clock, { by: "m1", now: Date.now() }, [], 0, 0, "안녕", false).ops);
  await b.load(day);
  await until(() => b.doc(day).text() === "안녕");
  const c = await session();
  await c.load(day);
  assert.equal(c.doc(day).text(), "안녕");
  assert.equal(c.room.member("m1").name, "가람");
  for (const s of people) s.close();
  void Clock;
});
