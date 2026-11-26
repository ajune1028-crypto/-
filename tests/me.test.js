import test from "node:test";
import assert from "node:assert/strict";
import { newMyCode, normalizeCode, validCode, formatCode, placeOf, sealFor, openFor, mergeBundles, itemsNow, ledgerOf, viewOf, CODE_LENGTH } from "../src/core/me.js";

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

test("my code: what two devices keep comes together as registers - the newest of each wins, a forgotten room stays forgotten, an older device cannot bring it back", () => {
  const phone = itemsNow(new Map([["room:aaaaaaaaaaaa", { name: "일기", kind: "daily-text" }], ["room:bbbbbbbbbbbb", { name: "노래" }], ["star:aaaaaaaaaaaa", true], ["set:theme", "dark"]]), {}, 10);
  // The iPad renames 노래, makes a house, chooses light later.
  const pad = itemsNow(new Map([["room:bbbbbbbbbbbb", { name: "노래 (새 이름)" }], ["room:cccccccccccc", { name: "그림" }], ["house:h1", { name: "가족", rooms: ["aaaaaaaaaaaa", "cccccccccccc"] }], ["set:theme", "light"]]), {}, 20);
  // The phone forgets 일기 at 30 (its ledger knew it; now it is no longer there).
  const phone2 = itemsNow(new Map([["room:bbbbbbbbbbbb", { name: "노래" }], ["set:theme", "dark"]]), phone.ledger, 30);
  assert.ok(phone2.items.some((it) => it.key === "room:aaaaaaaaaaaa" && it.gone && it.at === 30), "forgetting is written down");
  assert.equal(phone2.items.find((it) => it.key === "room:bbbbbbbbbbbb").at, 10, "unchanged keeps its time");
  const m = mergeBundles([phone2, pad]);
  const v = viewOf(m.items);
  assert.deepEqual(v.rooms.map((r) => r.id).sort(), ["bbbbbbbbbbbb", "cccccccccccc"], "일기 forgotten on the phone stays forgotten");
  assert.equal(v.rooms.find((r) => r.id === "bbbbbbbbbbbb").name, "노래 (새 이름)", "the newest of each");
  assert.deepEqual(v.houses[0].rooms, ["cccccccccccc"], "a house holds only rooms still there");
  assert.deepEqual(v.stars, [], "no star on a forgotten room");
  assert.equal(v.settings.theme, "light", "the setting changed last");
  assert.deepEqual(mergeBundles([pad, phone2, pad]), m, "the same in any order, any number of times");
  // The first phone bundle (older) cannot bring 일기 back; entering it again later can.
  assert.ok(!viewOf(mergeBundles([phone, phone2, pad]).items).rooms.some((r) => r.id === "aaaaaaaaaaaa"));
  const again = itemsNow(new Map([["room:aaaaaaaaaaaa", { name: "일기" }]]), {}, 40);
  assert.ok(viewOf(mergeBundles([phone2, pad, again]).items).rooms.some((r) => r.id === "aaaaaaaaaaaa"), "entered again later, it is back");
});

test("my code: a device that has just been given the universe has nothing new to say until something changes", () => {
  const other = itemsNow(new Map([["room:aaaaaaaaaaaa", { name: "일기" }], ["set:theme", "dark"]]), {}, 10);
  const ledger = ledgerOf(mergeBundles([other]).items);
  const mine = itemsNow(new Map([["room:aaaaaaaaaaaa", { name: "일기" }], ["set:theme", "dark"]]), ledger, 99);
  assert.ok(mine.items.every((it) => it.at === 10), "nothing written again: " + JSON.stringify(mine.items));
  const changed = itemsNow(new Map([["room:aaaaaaaaaaaa", { name: "일기" }], ["set:theme", "light"]]), mine.ledger, 120);
  assert.equal(changed.items.find((it) => it.key === "set:theme").at, 120);
});

// Like an ISBN-10 (weighted sum, prime modulus): the last letter checks the others, so a code typed with
// one letter wrong - or two neighbours swapped - is caught at once instead of opening an empty universe.
test("my code: its last letter checks the rest - any one letter typed wrong, or two neighbours swapped, is caught", () => {
  const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  for (let round = 0; round < 40; round++) {
    const norm = normalizeCode(newMyCode());
    assert.ok(validCode(norm), "a new code is valid: " + norm);
    for (let i = 0; i < norm.length; i++) {
      for (const c of ALPHABET) {
        if (c === norm[i]) continue;
        const wrong = norm.slice(0, i) + c + norm.slice(i + 1);
        assert.ok(!validCode(wrong), `one letter wrong at ${i} (${norm} → ${wrong}) is caught`);
      }
    }
    for (let i = 0; i + 1 < norm.length; i++) {
      const a = norm[i];
      const b = norm[i + 1];
      if (a === b) continue;
      const swapped = norm.slice(0, i) + b + a + norm.slice(i + 2);
      assert.ok(!validCode(swapped), `two neighbours swapped at ${i} (${norm} → ${swapped}) is caught`);
    }
  }
});
