// Transport for the trial page that runs inside Claude.
//
// The page offers a shared document store and a live channel. Ops are written
// to the store (the lasting record) and also sent over the live channel (fast,
// but unstored and allowed to drop). Whatever the live channel misses arrives
// through the store's snapshots.

import { Emitter } from "./transport.js";

const MAX_CHUNK_OPS = 200;
const MAX_CHUNK_CHARS = 48000;
const MAX_LIVE_BYTES = 3500;
const LIVE_ENVELOPE = 80;
const MAX_LIVE_BURST = 20;
const OFFLINE_AFTER_MS = 2500;
const JOIN_TIMEOUT_MS = 5000;

const encoder = new TextEncoder();
const byteLength = (text) => encoder.encode(text).length;
const randomKey = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");
const describe = (err) => String(err?.code || "") + (err?.message ? " " + err.message : "") || String(err);

/** Resolves with the value, or null when it rejects or takes too long. */
function settle(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value ?? null);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export class ClaudeTransport {
  /** Null when this view has no store: the caller falls back to another transport. */
  static async connect(claude, { timeoutMs = 10000, coalesceMs = 250, firstSnapshotMs = 10000 } = {}) {
    const use = (name) => {
      try {
        return settle(claude.use(name), timeoutMs);
      } catch {
        return Promise.resolve(null);
      }
    };
    const [db, live] = await Promise.all([use("db"), use("room")]);
    return db ? new ClaudeTransport(db, live, { coalesceMs, firstSnapshotMs }) : null;
  }

  constructor(db, live, { coalesceMs, firstSnapshotMs }) {
    this.db = db;
    this.live = live;
    this.coalesceMs = coalesceMs;
    this.firstSnapshotMs = firstSnapshotMs;
    this.channels = new Set();
    this.lastError = null;
    this.readOnly = false;
    this.full = false;
  }

  async createRoom({ id, kind, name }) {
    await this.db.doc("rooms/" + id).set({ id, kind, name, at: Date.now() });
  }

  async listRooms() {
    const snap = await this.db.collection("rooms").get();
    return snap.docs
      .map((doc) => doc.data())
      .filter((r) => r && typeof r.id === "string" && typeof r.name === "string" && typeof r.kind === "string");
  }

  async openRoom(id) {
    const snap = await this.db.doc("rooms/" + id).get();
    if (!snap.exists) return null;
    const channel = new ClaudeChannel(this, id);
    this.channels.add(channel);
    await channel.start();
    return channel;
  }

  info() {
    const channels = [...this.channels];
    const joined = channels.filter((c) => c.named);
    return {
      kind: "claude",
      db: this.readOnly ? "read-only" : this.full ? "full" : "ok",
      live: !this.live || !joined.length ? "none" : joined.every((c) => c.connected) ? "connected" : "reconnecting",
      peers: Math.max(0, ...channels.map((c) => c.peerList().length)),
      pending: channels.reduce((n, c) => n + c.queued(), 0),
      lastError: this.lastError,
    };
  }
}

class ClaudeChannel {
  constructor(transport, room) {
    this.transport = transport;
    this.room = room;
    this.replica = randomKey();
    this.events = new Emitter();
    this.logs = transport.db.collection("rooms/" + room + "/logs");
    this.chunks = new Map();
    this.delivered = new Map();
    this.writers = new Map();
    this.named = null;
    this.connected = true;
    this.peers = [];
    this.state = {};
    this.status = "online";
    this.offs = [];
    this.offlineTimer = null;
    this.closed = false;
    this.firstDone = false;
    this.first = new Promise((resolve) => {
      this.gotFirst = resolve;
    });
  }

  async start() {
    this.offs.push(
      this.logs.onSnapshot(
        (snap) => this.onSnapshot(snap),
        (err) => {
          this.transport.lastError = describe(err);
          this.setStatus("offline");
        },
      ),
    );
    if (!this.transport.live) return;
    let named = null;
    try {
      named = await settle(this.transport.live.join(this.room), JOIN_TIMEOUT_MS);
    } catch {
      named = null;
    }
    if (!named || this.closed) return;
    this.named = named;
    const dead = (err) => {
      // This view cannot use the live channel; the store alone still works.
      this.transport.lastError = describe(err);
      this.named = null;
      clearTimeout(this.offlineTimer);
      this.events.emit("peers", this.peerList());
    };
    this.offs.push(
      named.on("ops", (msg) => this.onLive(msg), dead),
      named.onPeers((change) => this.onPeers(change?.peers), dead),
      named.onConnection((connected) => this.onConnection(connected), dead),
    );
  }

  // ---- reading ---------------------------------------------------------------

  onSnapshot(snap) {
    const first = !this.firstDone;
    const docs = !first && typeof snap.docChanges === "function"
      ? snap.docChanges().filter((change) => change.type !== "removed").map((change) => change.doc)
      : snap.docs;
    for (const doc of docs) {
      const data = doc.data();
      if (!data || typeof data.d !== "string" || !Array.isArray(data.ops)) continue;
      this.chunks.set(doc.id, data);
      const had = this.delivered.get(doc.id) || 0;
      if (data.ops.length <= had) continue;
      this.delivered.set(doc.id, data.ops.length);
      // History is read with load(); my own chunks I already have.
      if (first || data.r === this.replica) continue;
      this.events.emit("ops", { doc: data.d, ops: data.ops.slice(had) });
    }
    if (first) {
      this.firstDone = true;
      this.gotFirst(true);
    }
  }

  async ready() {
    if (this.firstDone) return;
    if (!(await settle(this.first, this.transport.firstSnapshotMs))) throw new Error("store did not answer");
  }

  async docs() {
    await this.ready();
    return [...new Set([...this.chunks.values()].map((chunk) => chunk.d))];
  }

  async load(docId) {
    await this.ready();
    return [...this.chunks.values()].filter((chunk) => chunk.d === docId).flatMap((chunk) => chunk.ops);
  }

  subscribe(fn) {
    return this.events.on("ops", (msg) => fn(msg.doc, msg.ops));
  }

  onLive(msg) {
    if (!msg || msg.sameTab) return;
    const data = msg.data;
    if (data && typeof data.d === "string" && Array.isArray(data.o)) this.events.emit("ops", { doc: data.d, ops: data.o });
  }

  // ---- writing ---------------------------------------------------------------

  append(docId, ops) {
    if (this.closed) return Promise.reject(new Error("closed"));
    this.sendLive(docId, ops);
    let writer = this.writers.get(docId);
    if (!writer) {
      writer = { chunk: 0, written: [], size: 0, ids: new Set(), queue: [], timer: null, busy: false };
      this.writers.set(docId, writer);
    }
    return new Promise((resolve, reject) => {
      writer.queue.push({ ops, resolve, reject });
      this.schedule(docId, writer);
    });
  }

  /** Fast path: small groups over the live channel. Large bursts are left to the store. */
  sendLive(docId, ops) {
    if (!this.named) return;
    const groups = [];
    let group = [];
    let bytes = 0;
    for (const op of ops) {
      const size = byteLength(JSON.stringify(op)) + 1;
      if (size > MAX_LIVE_BYTES - LIVE_ENVELOPE) continue;
      if (bytes + size > MAX_LIVE_BYTES - LIVE_ENVELOPE) {
        groups.push(group);
        group = [];
        bytes = 0;
      }
      group.push(op);
      bytes += size;
    }
    if (group.length) groups.push(group);
    if (groups.length > MAX_LIVE_BURST) return;
    for (const o of groups) Promise.resolve(this.named.emit("ops", { d: docId, o })).catch(() => {});
  }

  schedule(docId, writer) {
    if (writer.busy || writer.timer) return;
    writer.timer = setTimeout(() => {
      writer.timer = null;
      this.drain(docId, writer);
    }, this.transport.coalesceMs);
  }

  async drain(docId, writer) {
    if (writer.busy) return;
    writer.busy = true;
    try {
      while (writer.queue.length && !this.closed) {
        const batch = writer.queue.splice(0);
        try {
          await this.write(docId, writer, batch.flatMap((entry) => entry.ops));
          for (const entry of batch) entry.resolve();
        } catch (err) {
          this.transport.lastError = describe(err);
          if (err?.code === "invalid_argument") this.transport.readOnly = true;
          if (err?.code === "quota_exceeded") this.transport.full = true;
          for (const entry of batch) entry.reject(err instanceof Error ? err : new Error(describe(err)));
        }
      }
    } finally {
      writer.busy = false;
    }
  }

  /** Appends to this screen's chunk documents, one write in flight at a time. */
  async write(docId, writer, ops) {
    const fresh = ops.filter((op) => !writer.ids.has(op.id));
    let i = 0;
    while (i < fresh.length) {
      let take = 0;
      let size = writer.size;
      while (i + take < fresh.length && writer.written.length + take < MAX_CHUNK_OPS) {
        const cost = JSON.stringify(fresh[i + take]).length + 1;
        if (writer.written.length + take > 0 && size + cost > MAX_CHUNK_CHARS) break;
        size += cost;
        take++;
      }
      if (take === 0) {
        this.nextChunk(writer);
        continue;
      }
      const next = writer.written.concat(fresh.slice(i, i + take));
      const id = docId + "~" + this.replica + "~" + writer.chunk;
      await this.logs.doc(id).set({ d: docId, r: this.replica, c: writer.chunk, ops: next });
      this.transport.readOnly = false;
      this.transport.full = false;
      for (let j = i; j < i + take; j++) writer.ids.add(fresh[j].id);
      writer.written = next;
      writer.size = size;
      i += take;
      if (writer.written.length >= MAX_CHUNK_OPS || writer.size >= MAX_CHUNK_CHARS) this.nextChunk(writer);
    }
  }

  nextChunk(writer) {
    writer.chunk++;
    writer.written = [];
    writer.size = 0;
  }

  queued() {
    let n = 0;
    for (const writer of this.writers.values()) for (const entry of writer.queue) n += entry.ops.length;
    return n;
  }

  // ---- presence and status ---------------------------------------------------

  setPresence(state) {
    this.state = state;
    if (this.named) Promise.resolve(this.named.presence(state)).catch(() => {});
    else this.events.emit("peers", this.peerList());
  }

  onPeers(peers) {
    if (!Array.isArray(peers)) return;
    this.peers = peers.map((p) => ({
      key: String(p.peer),
      isMe: !!p.sameTab,
      state: p.presence && typeof p.presence === "object" ? p.presence : {},
    }));
    this.events.emit("peers", this.peerList());
  }

  peerList() {
    if (this.named && this.peers.length) return this.peers;
    return [{ key: "me", isMe: true, state: this.state }];
  }

  onPresence(fn) {
    fn(this.peerList());
    return this.events.on("peers", fn);
  }

  onConnection(connected) {
    this.connected = !!connected;
    clearTimeout(this.offlineTimer);
    if (connected) this.setStatus("online");
    else {
      // Short drops are normal; only a lasting one counts as offline.
      this.offlineTimer = setTimeout(() => this.setStatus("offline"), OFFLINE_AFTER_MS);
    }
  }

  setStatus(status) {
    if (status === this.status || this.closed) return;
    this.status = status;
    this.events.emit("status", status);
  }

  onStatus(fn) {
    fn(this.status);
    return this.events.on("status", fn);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.offlineTimer);
    for (const writer of this.writers.values()) clearTimeout(writer.timer);
    for (const off of this.offs) off?.();
    if (this.named) Promise.resolve(this.named.leave()).catch(() => {});
    this.transport.channels.delete(this);
  }
}
