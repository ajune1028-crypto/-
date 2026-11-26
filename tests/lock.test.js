import test from "node:test";
import assert from "node:assert/strict";
import { roomKeyFrom, keyText, keyFromText, sealValue, openValue, isSealed, validRoomPassword } from "../src/core/lock.js";
import { sealedTransport, isLockedRoom, keyOpens } from "../src/sync/sealed.js";
import { createRoomOps } from "../src/core/room.js";
import { spliceOps } from "../src/core/edit.js";
import { LocalTransport, memoryStorage } from "../src/sync/local.js";
import { RoomSession } from "../src/sync/session.js";
import { openStore } from "../src/identity.js";
import { until } from "./helpers.js";

// A room with a password (the owner: "들어갈 때 비밀번호도 정할 수 있게"): a real lock. Its key comes from
// the password and the room's id; everything the room sends is sealed with it.

test("lock: the same password makes the same key for the same room only; a sealed value opens with it and nothing else", async () => {
  assert.ok(validRoomPassword("우리집") === false && validRoomPassword("우리 집이야") && !validRoomPassword("   ab  "));
  const a = await roomKeyFrom("우리 집이야", "abcdefghijkl");
  const again = await roomKeyFrom(" 우리 집이야 ", "abcdefghijkl");
  const otherRoom = await roomKeyFrom("우리 집이야", "mnopqrstuvwx");
  assert.equal(await keyText(a), await keyText(again), "spaces at the ends do not matter");
  assert.notEqual(await keyText(a), await keyText(otherRoom), "another room, another key");
  const sealed = await sealValue(a, { t: "name", v: "비밀 일기" });
  assert.ok(!sealed.includes("비밀") && !sealed.includes("name"), "nothing readable");
  assert.deepEqual(await openValue(await keyFromText(await keyText(a)), sealed), { t: "name", v: "비밀 일기" }, "the kept key opens it");
  assert.equal(await openValue(otherRoom, sealed), null, "another key opens nothing");
  assert.equal(await openValue(await roomKeyFrom("우리 집이아", "abcdefghijkl"), sealed), null, "a wrong password opens nothing");
  assert.ok(isSealed({ s: sealed }) && !isSealed({ s: sealed, t: "x" }) && !isSealed({ t: "name" }));
});

test("lock: a locked room's ops are stored sealed; a device with the key reads them, one without reads nothing, and an unsealed op never gets in", async (t) => {
  const storage = memoryStorage();
  const ns = "lock" + Date.now();
  const opened = [];
  t.after(() => opened.forEach((x) => x.close()));
  const tr = () => { const x = new LocalTransport({ ns, storage }); opened.push(x); return x; };
  const roomId = "lockedroomab";
  const key = await roomKeyFrom("우리 집이야", roomId);
  const host = tr();
  await host.createRoom({ id: roomId, kind: "daily-text", name: "" });
  const s = new RoomSession({ transport: sealedTransport(host, roomId, key), roomId, store: openStore(memoryStorage()), retry: [5, 5, 5] });
  opened.push(s);
  assert.equal(await s.open(), "ok");
  s.commit("room", createRoomOps(s.clock, { kind: "daily-text", name: "비밀 일기", tz: "Asia/Seoul", now: 1, memberId: "m1", memberName: "가", pin: null }));
  const sheet = s.sheet("2026-11-26");
  s.commit("s:2026-11-26", spliceOps(sheet, s.clock, { by: "m1", now: 1 }, sheet.ids().slice(), 0, 0, "오늘의 비밀", false).ops);
  const raw = tr();
  await until(async () => (await (await raw.openRoom(roomId)).load("s:2026-11-26")).length > 0);
  const stored = await (await raw.openRoom(roomId)).load("s:2026-11-26");
  assert.ok(stored.every(isSealed), "stored sealed: " + JSON.stringify(stored).slice(0, 120));
  assert.ok(!JSON.stringify(stored).includes("비밀"), "the words are not in what is stored");
  assert.equal(await isLockedRoom(raw, roomId), true);
  assert.equal(await keyOpens(raw, roomId, key), true);
  assert.equal(await keyOpens(raw, roomId, await roomKeyFrom("틀린 비밀번호", roomId)), false);
  // A friend with the password reads it all.
  const friend = new RoomSession({ transport: sealedTransport(tr(), roomId, await roomKeyFrom("우리 집이야", roomId)), roomId, store: openStore(memoryStorage()), retry: [5, 5, 5] });
  opened.push(friend);
  assert.equal(await friend.open(), "ok");
  await friend.loadDoc("s:2026-11-26");
  await until(() => friend.sheet("2026-11-26").text() === "오늘의 비밀");
  assert.equal(friend.room.meta("name"), "비밀 일기");
  // An unsealed op slipped into the store is left out.
  await (await raw.openRoom(roomId)).append("s:2026-11-26", [{ forged: true }]);
  const late = new RoomSession({ transport: sealedTransport(tr(), roomId, key), roomId, store: openStore(memoryStorage()), retry: [5, 5, 5] });
  opened.push(late);
  assert.equal(await late.open(), "ok");
  await late.loadDoc("s:2026-11-26");
  await until(() => late.sheet("2026-11-26").text() === "오늘의 비밀");
});
