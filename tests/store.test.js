// The device's store (identity.js openStore): a write that does not fit (the device's space is full)
// must not make everything else look unset. The owner (27 November): "색 내가 설정해가지고… 색이 그거대로
// 안 나와" - one full write used to make every later read answer "nothing set" (my colour, my theme).
import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/identity.js";

/** A localStorage that holds only so many characters, as a browser's does. */
function cappedStorage(limit) {
  const map = new Map();
  const size = () => [...map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      const was = map.get(k);
      map.set(k, String(v));
      if (size() > limit) {
        if (was === undefined) map.delete(k);
        else map.set(k, was);
        throw new Error("QuotaExceededError");
      }
    },
    removeItem: (k) => void map.delete(k),
  };
}

test("a write that does not fit leaves what was kept before readable, and later writes still reach the device", () => {
  const storage = cappedStorage(3000);
  openStore(storage).set("settings", { accent: "#14a37f", theme: "dark" }); // an earlier day
  const store = openStore(storage); // today
  store.set("big", "x".repeat(5000)); // does not fit
  assert.deepEqual(store.get("settings", {}), { accent: "#14a37f", theme: "dark" }, "my colour is still my colour");
  assert.equal(store.get("big", ""), "x".repeat(5000), "what did not fit is still there for now");
  store.set("settings", { accent: "#d93a3a", theme: "dark" });
  assert.deepEqual(openStore(storage).get("settings", {}), { accent: "#d93a3a", theme: "dark" }, "a later change is kept on the device");
  assert.equal(openStore(storage).get("big", null), null, "the one that did not fit was never kept");
});

test("once it fits, a key that did not is read from the device again", () => {
  const storage = cappedStorage(3000);
  const store = openStore(storage);
  store.set("note", "y".repeat(5000));
  store.set("note", "short");
  assert.equal(store.get("note", ""), "short");
  assert.equal(openStore(storage).get("note", ""), "short");
});
