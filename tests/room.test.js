import test from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/core/crdt.js";
import {
  newRoomId, newMemberId, newReplicaId, makeVerifier, checkVerifier, validPin, Attempts,
  RoomState, createRoomOps, joinOps, memberOps,
} from "../src/core/room.js";
import { rng, shuffle } from "./helpers.js";

test("ids use the lowercase base32 alphabet, have fixed lengths and do not repeat", () => {
  const seen = new Set();
  for (let i = 0; i < 10000; i++) seen.add(newRoomId());
  assert.equal(seen.size, 10000);
  assert.match(newRoomId(), /^[a-z2-7]{12}$/);
  assert.match(newMemberId(), /^[a-z2-7]{8}$/);
  assert.match(newReplicaId(), /^[a-z2-7]{6}$/);
});

test("a verifier accepts the right secret and rejects a wrong one", async () => {
  const v = await makeVerifier("12345");
  assert.equal(await checkVerifier("12345", v), true);
  assert.equal(await checkVerifier("12346", v), false);
  assert.equal(await checkVerifier("12345", null), false);
  assert.notEqual((await makeVerifier("12345")).hash, v.hash, "salted");
  assert.ok(!JSON.stringify(v).includes("12345"));
});

test("validPin accepts exactly five digits", () => {
  assert.equal(validPin("12345"), true);
  for (const bad of ["1234", "123456", "12a45", " 12345", "", null, 12345]) assert.equal(validPin(bad), false, String(bad));
});

test("five failures lock for 30 seconds and success resets", () => {
  const a = new Attempts();
  for (let i = 0; i < 4; i++) a.fail(1000);
  assert.equal(a.lockedMs(1000), 0);
  a.fail(1000);
  assert.equal(a.lockedMs(1000), 30000);
  assert.equal(a.lockedMs(21000), 10000);
  assert.equal(a.lockedMs(31000), 0);
  for (let i = 0; i < 4; i++) a.fail(40000);
  a.ok();
  a.fail(40000);
  assert.equal(a.lockedMs(40000), 0);
});

test("creating a room sets its info and its first person", () => {
  const c = new Clock("aaaaaa");
  const room = new RoomState();
  room.applyAll(createRoomOps(c, { kind: "daily-text", name: "우리 방", tz: "Asia/Seoul", now: 5, memberId: "m1", memberName: "나", pin: null }));
  assert.equal(room.meta("kind"), "daily-text");
  assert.equal(room.meta("name"), "우리 방");
  assert.equal(room.meta("tz"), "Asia/Seoul");
  assert.equal(room.meta("createdBy"), "m1");
  assert.deepEqual(room.members(), [{ id: "m1", name: "나", color: 0, pin: null, joinedAt: 5 }]);
});

test("joining takes the lowest unused colour, then the least used", () => {
  const c = new Clock("aaaaaa");
  const room = new RoomState();
  room.applyAll(createRoomOps(c, { kind: "daily-text", name: "r", tz: "UTC", now: 0, memberId: "m0", memberName: "a", pin: null }));
  for (let i = 1; i < 8; i++) {
    assert.equal(room.freeColor(), i);
    room.applyAll(joinOps(c, room, { memberId: "m" + i, name: "p" + i, pin: null, now: i }));
  }
  assert.equal(room.freeColor(), 0);
  room.applyAll(joinOps(c, room, { memberId: "m8", name: "p8", pin: null, now: 8 }));
  assert.equal(room.freeColor(), 1);
  assert.equal(room.member("m8").color, 0);
});

test("room info and each person's fields are last-writer-wins in any order", () => {
  const c = new Clock("aaaaaa");
  const d = new Clock("bbbbbb");
  const ops = [
    ...createRoomOps(c, { kind: "daily-text", name: "첫 이름", tz: "UTC", now: 0, memberId: "m1", memberName: "가", pin: null }),
    { t: "meta", id: d.next(), k: "name", v: "먼저 바꿈" },
  ];
  d.atLeast(c.n);
  ops.push({ t: "meta", id: d.next(), k: "name", v: "나중에 바꿈" }, ...memberOps(d, "m1", { name: "나", color: 3 }));
  for (let seed = 1; seed <= 50; seed++) {
    const room = new RoomState();
    room.applyAll(shuffle(rng(seed), [...ops, ...ops.slice(0, 3)]));
    assert.equal(room.meta("name"), "나중에 바꿈");
    assert.deepEqual(room.member("m1"), { id: "m1", name: "나", color: 3, pin: null, joinedAt: 0 });
  }
});

test("malformed room ops are set aside and change nothing", () => {
  const room = new RoomState();
  const bad = [null, { t: "mem", id: "1@a", m: "m1", k: "color", v: 99 }, { t: "mem", id: "2@a", m: "m1", k: "name", v: "" },
    { t: "mem", id: "3@a", m: "m1", k: "name", v: "x".repeat(21) }, { t: "mem", id: "4@a", m: "m1", k: "pin", v: "12345" },
    { t: "meta", id: "5@a", k: "", v: 1 }, { t: "what", id: "6@a" }, { t: "mem", id: "7@a", m: "M 1", k: "name", v: "a" }];
  for (const op of bad) assert.equal(room.apply(op), "unknown");
  assert.deepEqual(room.members(), []);
  assert.equal(room.unknown.length, bad.length);
});

test("a person without a name yet is not listed", () => {
  const room = new RoomState();
  room.apply({ t: "mem", id: "1@a", m: "m1", k: "color", v: 2 });
  assert.deepEqual(room.members(), []);
  room.apply({ t: "mem", id: "2@a", m: "m1", k: "name", v: "가" });
  assert.equal(room.members().length, 1);
});

test("sha256Hex matches known vectors and the platform's own digest", async () => {
  const { sha256Hex } = await import("../src/core/room.js");
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const text of ["가나다라마바사 12345", "x".repeat(200), "salt1234:24680", "😀"]) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    assert.equal(sha256Hex(text), Buffer.from(bytes).toString("hex"), text.slice(0, 12));
  }
});

test("verifiers work where the browser offers no crypto.subtle", async () => {
  const subtle = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(crypto), "subtle") || Object.getOwnPropertyDescriptor(crypto, "subtle");
  Object.defineProperty(crypto, "subtle", { value: undefined, configurable: true });
  try {
    const v = await makeVerifier("24680");
    assert.equal(await checkVerifier("24680", v), true);
    assert.equal(await checkVerifier("24681", v), false);
  } finally {
    delete crypto.subtle;
    if (subtle && !("subtle" in crypto)) Object.defineProperty(crypto, "subtle", subtle);
  }
});

test("roomLink appends the room to the page address and drops any old hash", async () => {
  const { roomLink } = await import("../src/core/room.js");
  assert.equal(roomLink("https://claude.ai/artifact/AbC123", "abcdefgh2345"), "https://claude.ai/artifact/AbC123#r-abcdefgh2345");
  assert.equal(roomLink("https://example.com/app/?x=1#r-oldoldoldold", "abcdefgh2345"), "https://example.com/app/?x=1#r-abcdefgh2345");
});

test("the maker and a newcomer may bring the colour they prefer; without one the first free colour is theirs", () => {
  const clock = new Clock("a");
  const room = new RoomState();
  for (const op of createRoomOps(clock, { kind: "daily-text", name: "방", tz: "Asia/Seoul", now: 1, memberId: "m1", memberName: "가", color: 1 })) room.apply(op);
  assert.equal(room.member("m1").color, 1, "the maker's colour");
  for (const op of joinOps(clock, room, { memberId: "m2", name: "나", now: 2, color: 6 })) room.apply(op);
  assert.equal(room.member("m2").color, 6, "the newcomer's colour");
  for (const op of joinOps(clock, room, { memberId: "m3", name: "다", now: 3 })) room.apply(op);
  assert.equal(room.member("m3").color, 0, "no preference: the first free");
});

test("방의 역사: when it began and by whom, the latest change and by whom, who came in when (one visit per half hour), and what each made by day - the same in any order", async () => {
  const { RoomState, createRoomOps, joinOps, seenOps, didOps } = await import("../src/core/room.js");
  const day = (d, h, m = 0) => Date.UTC(2026, 10, d, h, m);
  const c = new Clock("a");
  const ops = [
    ...createRoomOps(c, { kind: "creative-song", name: "방", tz: "Asia/Seoul", now: day(14, 3), memberId: "m1", memberName: "나래", color: 2 }),
    ...seenOps(c, "m1", day(14, 3)),
  ];
  const room = new RoomState();
  room.applyAll(ops);
  ops.push(...joinOps(c, room, { memberId: "m2", name: "민수", now: day(15, 9) }));
  ops.push(...seenOps(c, "m2", day(15, 9)), ...didOps(c, "m2", { 녹음: 2, 그림: 14 }, day(15, 9, 20)));
  ops.push(...seenOps(c, "m1", day(20, 12)), ...didOps(c, "m1", { 글: 30 }, day(20, 12, 5)));
  const a = new RoomState();
  a.applyAll(ops);
  const hist = a.history();
  assert.equal(hist.createdAt, day(14, 3));
  assert.equal(hist.createdBy, "m1");
  assert.equal(hist.lastAt, day(20, 12, 5), "the latest change");
  assert.equal(hist.lastBy, "m1");
  assert.deepEqual(hist.visits.map((v) => [v.m, v.at]), [["m1", day(20, 12)], ["m2", day(15, 9)], ["m1", day(14, 3)]], "newest first");
  assert.deepEqual(hist.days.map((d) => [d.day, d.work.map((w) => [w.m, w.k, w.n])]), [
    ["2026-11-20", [["m1", "글", 30]]],
    ["2026-11-15", [["m2", "녹음", 2], ["m2", "그림", 14]]],
  ]);
  // Shuffled and repeated: the same story.
  const b = new RoomState();
  b.applyAll(shuffle(rng(3), [...ops, ...ops.slice(0, 6)]));
  assert.deepEqual(b.history(), hist);
  // A visit is noted at most once in half an hour.
  assert.equal(a.seenRecently("m1", day(20, 12, 20)), true);
  assert.equal(a.seenRecently("m1", day(20, 12, 40)), false);
  // Nonsense is set aside.
  assert.equal(new RoomState().apply({ t: "did", id: "1@x", m: "m1", at: 1, k: "해킹", n: 1 }), "unknown");
  assert.equal(new RoomState().apply({ t: "seen", id: "2@x", m: "M!", at: 1 }), "unknown");
});
