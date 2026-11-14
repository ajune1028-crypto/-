// Files kept on this device: recordings (and later photos). Stored in the
// browser's IndexedDB, which holds megabytes where localStorage holds little.
// Where IndexedDB is refused (some sandboxed frames, private windows), files
// live in memory until the page closes.
//
// Sharing a file with other devices is the transport's job (putBlob/getBlob,
// planned with the public deployment); until then a recording plays as the
// original only on the device that made it, and as piano everywhere.

const STORE = "files";

export function newBlobId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return "b" + Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
}

export class BlobStore {
  constructor(name = "hamkke-files") {
    this.name = name;
    this.memory = new Map();
    this.opening = null;
  }

  db() {
    if (!this.opening) {
      this.opening = new Promise((resolve) => {
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
    }
    return this.opening;
  }

  /** Keeps bytes under an id. Never throws: memory always works. */
  async put(id, bytes, type = "application/octet-stream") {
    const record = { type, data: bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    this.memory.set(id, record);
    const db = await this.db();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(record, id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  /** { type, data: ArrayBuffer } or null. */
  async get(id) {
    if (this.memory.has(id)) return this.memory.get(id);
    const db = await this.db();
    if (!db) return null;
    return new Promise((resolve) => {
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
    });
  }
}
