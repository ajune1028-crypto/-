// Files kept on this device: recordings (and later photos). Stored in the
// browser's IndexedDB, which holds megabytes where localStorage holds little.
// Where IndexedDB is refused (some sandboxed frames, private windows), files
// live in memory until the page closes.
//
// A recording's own sound reaches friends through the room (ui/share-take.js);
// this store is only what this device keeps.

const STORE = "files";

export function newBlobId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return "b" + Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
}

/** The promise's answer, or `fallback` once `ms` have passed without one. */
function within(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

export class BlobStore {
  /**
   * waitMs: how long to wait for the browser's database before going on without it. Some app
   * views (sandboxed frames) never answer at all, neither yes nor no, and whatever waited on them
   * stopped with them (the whiteboard's ▶ never played).
   */
  constructor(name = "hamkke-files", { waitMs = 2500 } = {}) {
    this.name = name;
    this.waitMs = waitMs;
    this.memory = new Map();
    this.opening = null;
  }

  db() {
    if (!this.opening) {
      const open = new Promise((resolve) => {
        try {
          const req = indexedDB.open(this.name, 1);
          req.onupgradeneeded = () => req.result.createObjectStore(STORE);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      // Not answered in time: this page keeps its files in memory from now on.
      this.opening = within(open, this.waitMs, null);
    }
    return this.opening;
  }

  /** Keeps bytes under an id. Never throws and never waits long: memory always works. */
  async put(id, bytes, type = "application/octet-stream") {
    const record = { type, data: bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    this.memory.set(id, record);
    const db = await this.db();
    if (!db) return false;
    return within(new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(record, id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    }), this.waitMs, false);
  }

  /** { type, data: ArrayBuffer } or null (also when the database does not answer in time). */
  async get(id) {
    if (this.memory.has(id)) return this.memory.get(id);
    const db = await this.db();
    if (!db) return null;
    return within(new Promise((resolve) => {
      try {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
        req.onsuccess = () => {
          if (req.result) this.memory.set(id, req.result);
          resolve(req.result || null);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    }), this.waitMs, null);
  }
}
