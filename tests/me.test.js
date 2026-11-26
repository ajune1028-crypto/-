import test from "node:test";
import assert from "node:assert/strict";
import { newMyCode, normalizeCode, validCode, formatCode, placeOf, sealFor, openFor, mergeBundles, CODE_LENGTH } from "../src/core/me.js";

// 나의 고유 코드 (the owner, 21 November): made the first time the app opens, more complex than a room's
// five digits; whoever knows it gets into everything of theirs from anywhere.

test("my code: sixteen letters and digits nobody mixes up, in four groups; typed any way it is read back", () => {
  const code = newMyCode();
  assert.match(code, /^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}$/);
  assert.equal(normalizeCode(code).length, CODE_LENGTH);
  assert.ok(validCode(code));
  assert.ok(validCode(code.toLowerCase().replace(/-/g, " ")), "lower case, spaces instead of dashes");
  assert.equal(formatCode(normalizeCode(code.toLowerCase())), code);
  assert.ok(!validCode("ABCD-EFGH-IJKL-MNOP"), "I, L and O are never in a code");
  assert.ok(!validCode("ABCD-EFGH"), "too short");
  assert.notEqual(newMyCode(), newMyCode(), "a new one every time");
});

test("my code: where my things are kept is found from the code alone, never the code itself", async () => {
  const code = "7KQ4-M2XD-9PFA-3WNE";
  const place = await placeOf(code);
  assert.match(place, /^[a-z2-7]{12}$/, "a room id");
  assert.equal(await placeOf(code.toLowerCase()), place, "the same however it was typed");
  assert.notEqual(await placeOf("7KQ4-M2XD-9PFA-3WNF"), place);
  assert.ok(!place.includes("7kq4"), "the code is not in it");
});

test("my code: what is kept is sealed; only the same code opens it", async () => {
  const code = newMyCode();
  const bundle = { at: 5, rooms: [{ id: "abcdefghijkl", name: "우리 방", memberId: "m1", at: 1 }] };
  const sealed = await sealFor(code, bundle);
  assert.equal(typeof sealed, "string");
  assert.ok(!sealed.includes("우리 방") && !sealed.includes("abcdefghijkl"), "nothing readable in it");
  assert.deepEqual(await openFor(code, sealed), bundle);
  assert.equal(await openFor(newMyCode(), sealed), null, "another code cannot open it");
});

test("my code: what two devices kept comes together - every room, the newest of each, forgotten ones stay gone", () => {
  const phone = { at: 10, rooms: [{ id: "aaaaaaaaaaaa", name: "일기", at: 3 }, { id: "bbbbbbbbbbbb", name: "노래", at: 4 }], houses: [{ id: "h1", name: "가족", rooms: ["aaaaaaaaaaaa"], at: 1 }], stars: ["aaaaaaaaaaaa"], settings: { theme: "dark" }, forgotten: [] };
  const pad = { at: 20, rooms: [{ id: "bbbbbbbbbbbb", name: "노래 (새 이름)", at: 9 }, { id: "cccccccccccc", name: "그림", at: 8 }], houses: [], stars: [], settings: { theme: "light" }, forgotten: ["aaaaaaaaaaaa"] };
  const m = mergeBundles([phone, pad]);
  assert.deepEqual(m.rooms.map((r) => r.id).sort(), ["bbbbbbbbbbbb", "cccccccccccc"], "the one forgotten on the iPad stays forgotten");
  assert.equal(m.rooms.find((r) => r.id === "bbbbbbbbbbbb").name, "노래 (새 이름)", "the newest of each");
  assert.equal(m.houses.length, 1);
  assert.deepEqual(m.stars, [], "a forgotten room is not starred");
  assert.equal(m.settings.theme, "light", "the settings saved last");
  assert.deepEqual(mergeBundles([pad, phone]), m, "the same in any order");
});
