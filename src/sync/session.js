// One open room on this screen.
//
// Changes are applied here first, so the screen never waits for the network,
// then handed to the transport. What could not be sent stays in an outbox that
// is saved on the device and sent when the connection returns.

import { Emitter } from "./transport.js";
import { Clock, Sheet } from "../core/crdt.js";
import { RoomState, newReplicaId } from "../core/room.js";

const SHEET = "s:";
const ROOM = "room";

export class RoomSession extends Emitter {
  constructor({ transport, roomId, store, clock = new Clock(newReplicaId()), retry = [1000, 2000, 5000, 10000] }) {
    super();
    this.transport = transport;
    this.roomId = roomId;
    this.store = store;
    this.clock = clock;
    this.retry = retry;
    this.room = new RoomState();
    this.sheets = new Map();
    this.known = new Set();
    this.loading = new Map();
    this.outbox = [];
    this.status = "online";
    this.peers = [];
    this.memberId = null;
    this.lastError = null;
    this.channel = null;
    this.offs = [];
    this.flushing = false;
    this.fails = 0;
    this.timer = null;
    this.warned = false;
    this.closed = false;
  }

  get outboxKey() {
    return "outbox:" + this.roomId;
  }

  /** Ops written here that the transport has not accepted yet. */
  get pending() {
    return this.outbox.reduce((n, entry) => n + entry.ops.length, 0);
  }

  get me() {
    return this.memberId ? this.room.member(this.memberId) : null;
  }

  setMe(memberId) {
    this.memberId = memberId;
  }

  async open() {
    this.channel = await this.transport.openRoom(this.roomId);
    if (!this.channel) return "missing";
    this.offs = [
      this.channel.subscribe((doc, ops) => this.receive(doc, ops)),
      this.channel.onStatus((status) => this.setStatus(status)),
      this.channel.onPresence((peers) => {
        this.peers = peers;
        this.emit("peers", peers);
      }),
    ];
    for (const entry of this.store.get(this.outboxKey, [])) {
      this.absorb(entry.doc, entry.ops);
      this.outbox.push(entry);
    }
    await this.loadDoc(ROOM);
    await this.refreshDays();
    this.flush();
    return "ok";
  }

  async refreshDays() {
    try {
      for (const doc of await this.channel.docs()) if (doc.startsWith(SHEET)) this.known.add(doc.slice(SHEET.length));
    } catch (err) {
      this.failed(err);
    }
  }

  /** Days that have a sheet, oldest first. */
  days() {
    return [...this.known].sort();
  }

  sheet(day) {
    let sheet = this.sheets.get(day);
    if (!sheet) {
      sheet = new Sheet();
      this.sheets.set(day, sheet);
    }
    return sheet;
  }

  async loadSheet(day) {
    await this.loadDoc(SHEET + day);
    return this.sheet(day);
  }

  loadDoc(doc) {
    if (!this.loading.has(doc)) {
      const job = this.channel.load(doc).then(
        (ops) => this.absorb(doc, ops),
        (err) => {
          this.loading.delete(doc);
          this.failed(err);
        },
      );
      this.loading.set(doc, job);
    }
    return this.loading.get(doc);
  }

  target(doc) {
    if (doc === ROOM) return this.room;
    if (typeof doc !== "string" || !doc.startsWith(SHEET)) return null;
    const day = doc.slice(SHEET.length);
    this.known.add(day);
    return this.sheet(day);
  }

  /** Applies ops to the right doc and tells listeners what changed. */
  absorb(doc, ops) {
    const target = this.target(doc);
    if (!target || !Array.isArray(ops) || !ops.length) return;
    for (const op of ops) this.clock.see(op?.id);
    const strangers = target.unknown.length;
    const changed = target.applyAll(ops);
    if (target.unknown.length > strangers && !this.warned) {
      this.warned = true;
      this.emit("unknown");
    }
    if (changed) this.emit("change", { doc });
  }

  /** Ops from another screen. */
  receive(doc, ops) {
    if (typeof doc === "string" && doc.startsWith(SHEET) && !this.loading.has(doc)) this.loadDoc(doc);
    this.absorb(doc, ops);
  }

  /** My own change: shown at once, then sent. */
  commit(doc, ops) {
    if (!ops.length || this.closed) return;
    this.absorb(doc, ops);
    const last = this.outbox[this.outbox.length - 1];
    if (last && last.doc === doc) last.ops.push(...ops);
    else this.outbox.push({ doc, ops: ops.slice() });
    this.persist();
    this.flush();
  }

  persist() {
    this.store.set(this.outboxKey, this.outbox);
  }

  async flush() {
    if (this.flushing || this.closed || !this.channel) return;
    this.flushing = true;
    try {
      while (this.outbox.length && !this.closed) {
        const entry = this.outbox[0];
        const count = entry.ops.length;
        try {
          await this.channel.append(entry.doc, entry.ops.slice(0, count));
        } catch (err) {
          this.failed(err);
          this.retryLater();
          return;
        }
        entry.ops.splice(0, count);
        if (!entry.ops.length) this.outbox.shift();
        this.fails = 0;
        this.persist();
        this.setStatus("online");
        this.emit("sent");
      }
    } finally {
      this.flushing = false;
    }
  }

  retryLater() {
    if (this.closed) return;
    clearTimeout(this.timer);
    const delay = this.retry[Math.min(this.fails, this.retry.length - 1)];
    this.fails++;
    this.timer = setTimeout(() => this.flush(), delay);
  }

  failed(err) {
    this.lastError = String(err?.message || err);
    this.setStatus("offline");
  }

  setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this.emit("status", status);
    if (status === "online") {
      this.flush();
      this.catchUp();
    }
  }

  /** After a gap, read everything again; ops already applied are ignored. */
  catchUp() {
    const docs = new Set([ROOM, ...this.loading.keys(), ...[...this.sheets.keys()].map((day) => SHEET + day)]);
    for (const doc of docs) {
      this.channel.load(doc).then((ops) => this.absorb(doc, ops), (err) => this.failed(err));
    }
    this.refreshDays().then(() => this.emit("change", { doc: ROOM }));
  }

  setPresence(state) {
    this.channel?.setPresence(state);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    for (const off of this.offs) off();
    this.channel?.close();
  }
}
