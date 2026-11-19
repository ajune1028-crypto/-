import test from "node:test";
import assert from "node:assert/strict";
import { BlobStore } from "../src/sync/blobs.js";

// Some app views (sandboxed frames) never answer indexedDB.open: no success, no error. A file
// store that waits for it forever stops whatever waits on it (the whiteboard's ▶ did).
test("a file store whose database never opens answers from memory after a short wait", async () => {
  const saved = globalThis.indexedDB;
  globalThis.indexedDB = { open: () => ({}) }; // a request that never fires
  try {
    const store = new BlobStore("never", { waitMs: 50 });
    const t0 = Date.now();
    assert.equal(await store.get("nope"), null);
    assert.ok(Date.now() - t0 < 1000, "it does not wait for ever");
    assert.equal(await store.put("a", new Uint8Array([1, 2, 3])), false, "not saved on the device");
    const kept = await store.get("a");
    assert.deepEqual([...new Uint8Array(kept.data)], [1, 2, 3], "but kept in memory while the page is open");
  } finally {
    if (saved === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = saved;
  }
});

test("a read that never finishes gives up too", async () => {
  const saved = globalThis.indexedDB;
  const db = { transaction: () => ({ objectStore: () => ({ get: () => ({}) }) }) };
  globalThis.indexedDB = { open: () => { const req = { result: db }; setTimeout(() => req.onsuccess?.(), 0); return req; } };
  try {
    const store = new BlobStore("stuck", { waitMs: 50 });
    const t0 = Date.now();
    assert.equal(await store.get("x"), null);
    assert.ok(Date.now() - t0 < 1000);
  } finally {
    if (saved === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = saved;
  }
});
