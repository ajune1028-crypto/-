// Carries ops between screens of one browser: storage keeps them, a
// BroadcastChannel passes them on. Used for tests and when nothing else is
// available. `setOffline` imitates a dropped connection.

import { Emitter } from "./transport.js";

export function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

function browserStorage() {
  try {
    const s = globalThis.localStorage;
    s.setItem("hamkke:probe", "1");
    s.removeItem("hamkke:probe");
    return s;
  } catch {
    return memoryStorage();
  }
}

const randomKey = () => Math.random().toString(36).slice(2, 10);

export class LocalTransport {
  constructor({ ns = "main", storage, offline = false } = {}) {
    this.ns = ns;
    this.storage = storage ?? browserStorage();
    this.offline = offline;
    this.channels = new Set();
    this.lastError = null;
    try {
      this.bus = new BroadcastChannel("hamkke:" + ns);
      this.bus.onmessage = (event) => this.deliver(event.data, null);
    } catch {
      // Some sandboxed pages refuse it; this screen then only talks to itself.
      this.bus = { postMessage() {}, close() {} };
    }
  }

  read(key, fallback) {
    try {
      const raw = this.storage.getItem(this.ns + ":" + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  write(key, value) {
    this.storage.setItem(this.ns + ":" + key, JSON.stringify(value));
  }

  async createRoom({ id, kind, name }) {
    const rooms = this.read("rooms", []);
    if (rooms.some((r) => r.id === id)) return;
    rooms.push({ id, kind, name, at: Date.now() });
    this.write("rooms", rooms);
  }

  async listRooms() {
    return this.read("rooms", []);
  }

  async openRoom(id) {
    if (!this.read("rooms", []).some((r) => r.id === id)) return null;
    const channel = new LocalChannel(this, id);
    this.channels.add(channel);
    return channel;
  }

  setOffline(offline) {
    if (this.offline === offline) return;
    this.offline = offline;
    for (const channel of this.channels) channel.statusChanged();
  }

  /** Hands a message to every open channel of that room except the sender. */
  deliver(msg, sender) {
    if (this.offline || !msg) return;
    for (const channel of this.channels) {
      if (channel !== sender && channel.room === msg.room && channel.key !== msg.from) channel.handle(msg);
    }
  }

  info() {
    return {
      kind: "local",
      db: "ok",
      live: this.offline ? "offline" : "connected",
      peers: Math.max(0, ...[...this.channels].map((c) => c.peers.size + 1)),
      lastError: this.lastError,
    };
  }

  close() {
    for (const channel of [...this.channels]) channel.close();
    this.bus.close();
  }
}

class LocalChannel {
  constructor(transport, room) {
    this.transport = transport;
    this.room = room;
    this.key = randomKey();
    this.events = new Emitter();
    this.peers = new Map();
    this.state = {};
    this.closed = false;
    this.post({ kind: "hello" });
  }

  post(msg) {
    if (this.closed || this.transport.offline) return;
    const full = { ...msg, room: this.room, from: this.key };
    this.transport.bus.postMessage(full);
    queueMicrotask(() => this.transport.deliver(full, this));
  }

  handle(msg) {
    if (msg.kind === "ops") this.events.emit("ops", msg);
    else if (msg.kind === "presence") {
      this.peers.set(msg.from, msg.state);
      this.events.emit("peers", this.peerList());
    } else if (msg.kind === "hello") this.post({ kind: "presence", state: this.state });
    else if (msg.kind === "bye" && this.peers.delete(msg.from)) this.events.emit("peers", this.peerList());
  }

  peerList() {
    return [
      { key: this.key, isMe: true, state: this.state },
      ...[...this.peers].map(([key, state]) => ({ key, isMe: false, state })),
    ];
  }

  online() {
    if (this.transport.offline) throw new Error("offline");
  }

  async docs() {
    this.online();
    return this.transport.read("docs:" + this.room, []);
  }

  async load(docId) {
    this.online();
    return this.transport.read("log:" + this.room + ":" + docId, []);
  }

  async append(docId, ops) {
    this.online();
    const key = "log:" + this.room + ":" + docId;
    const log = this.transport.read(key, []);
    log.push(...ops);
    try {
      this.transport.write(key, log);
      const docs = this.transport.read("docs:" + this.room, []);
      if (!docs.includes(docId)) this.transport.write("docs:" + this.room, [...docs, docId]);
    } catch (err) {
      this.transport.lastError = String(err?.message || err);
      throw err;
    }
    this.post({ kind: "ops", doc: docId, ops });
  }

  subscribe(fn) {
    return this.events.on("ops", (msg) => fn(msg.doc, msg.ops));
  }

  setPresence(state) {
    this.state = state;
    this.post({ kind: "presence", state });
    this.events.emit("peers", this.peerList());
  }

  onPresence(fn) {
    fn(this.peerList());
    return this.events.on("peers", fn);
  }

  onStatus(fn) {
    fn(this.transport.offline ? "offline" : "online");
    return this.events.on("status", fn);
  }

  statusChanged() {
    const offline = this.transport.offline;
    if (offline) this.peers.clear();
    else {
      this.post({ kind: "hello" });
      this.post({ kind: "presence", state: this.state });
    }
    this.events.emit("peers", this.peerList());
    this.events.emit("status", offline ? "offline" : "online");
  }

  close() {
    if (this.closed) return;
    this.post({ kind: "bye" });
    this.closed = true;
    this.transport.channels.delete(this);
  }
}
