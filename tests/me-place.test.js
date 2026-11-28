// What 나의 고유 코드 carries to my other devices (sync/me-place.js): rooms, houses, stars and the
// settings that are mine wherever I am - now also where the line between 일상 and 창작 stands (a share
// of the width, the same on a phone and a tablet). A board's arrangement stays on its device: its
// cells are counted from that screen's width.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thingsOf, putOn } from "../src/sync/me-place.js";
import { openStore } from "../src/identity.js";
import { memoryStorage } from "../src/sync/local.js";

test("the line between the halves goes with my code; a board's cells stay on the device", () => {
  const here = openStore(memoryStorage());
  here.set("settings", { homeSplit: 0.58, roomView: "board" });
  here.set("homeBoard", { r1: [0, 0, 1, 1] });
  const things = thingsOf(here);
  assert.equal(things.get("set:homeSplit"), 0.58);
  assert.equal(things.get("set:roomView"), "board");
  assert.ok(![...things.keys()].some((k) => k.includes("homeBoard")), "the board's cells are this device's");
  const there = openStore(memoryStorage());
  const changed = putOn(there, { rooms: [], houses: [], stars: [], settings: { homeSplit: 0.58 } });
  assert.deepEqual(changed, ["homeSplit"]);
  assert.equal(there.get("settings", {}).homeSplit, 0.58);
});
