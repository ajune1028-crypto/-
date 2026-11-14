// One open room on this screen.
//
// Changes are applied here first, so the screen never waits for the network,
// then handed to the transport. What could not be sent stays in an outbox that
// is saved on the device and sent when the connection returns.
//
// A room holds several documents, each a list of ops: "room" (name, people),
// and whatever its kind needs: "s:<day>" sheets for text, "song" for songs.
// DOC_TYPES says which object holds which document. A new room kind adds a
// line there; nothing else in the session changes.

import { Emitter } from "./transport.js";
import { Clock, Sheet } from "../core/crdt.js";
import { RoomState, newReplicaId } from "../core/room.js";
import { SongDoc } from "../core/song.js";
import { InkDoc } from "../core/ink.js";
import { BoardDoc } from "../core/board.js";

const SHEET = "s:";
const ROOM = "room";

/**
 * Which object holds a document, by its id. Every holder takes ops with
 * applyAll(ops) → changed?, and keeps ops it cannot read in `unknown`.
 */
export const DOC_TYPES = [
  { test: (doc) => doc === ROOM, make: () => new RoomState() },
  { test: (doc) => doc.startsWith(SHEET) && doc.length > SHEET.length, make: () => new Sheet() },
  { test: (doc) => doc === "song", make: () => new SongDoc() },
  // Drawings on a day's sheet.
  { test: (doc) => doc.startsWith("k:") && doc.length > 2, make: () => new InkDoc() },
  // The whiteboard's cards and lines.
  { test: (doc) => doc === "board", make: () => new BoardDoc() },
];

export class RoomSession extends Emitter {
  constructor({ transport, roomId, store, clock = new Clock(newReplicaId()), retry = [1000, 2000, 5000, 10000], types = DOC_TYPES }) {
    super();
    this.transport = transport;
    this.roomId = roomId;
    this.store = store;
    this.clock = clock;
    this.retry = retry;
    this.types = types;
    this.docs = new Map();
    this.room = this.doc(ROOM);
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
    await this.refreshDocs();
    this.flush();
    return "ok";
  }

  /** Learns which documents the room has, so day sheets can be listed before they are read. */
  async refreshDocs() {
    try {
      for (const doc of await this.channel.docs()) if (doc.startsWith(SHEET)) this.known.add(doc.slice(SHEET.length));
    } catch (err) {
      this.failed(err);
    }
  }

  /** The object holding a document, made on first use; null for an id no type claims. */
  doc(id) {
    let held = this.docs.get(id);
    if (!held) {
      const type = typeof id === "string" ? this.types.find((t) => t.test(id)) : null;
      if (!type) return null;
      held = type.make();
      this.docs.set(id, held);
    }
    return held;
  }

  /** Reads a document's stored ops (once) and resolves with its holder. */
  async load(id) {
    await this.loadDoc(id);
    return this.doc(id);
  }

  // ---- day sheets of the text room ------------------------------------------------

  /** Days that have a sheet, oldest first. */
  days() {
    return [...this.known].sort();
  }

  sheet(day) {
    return this.doc(SHEET + day);
  }

  async loadSheet(day) {
    return this.load(SHEET + day);
  }

  // ---- receiving --------------------------------------------------------------------

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
    const held = this.doc(doc);
    if (held && doc.startsWith(SHEET)) this.known.add(doc.slice(SHEET.length));
    return held;
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

  /** Ops from another screen. A document nobody read yet is read in full first. */
  receive(doc, ops) {
    if (typeof doc === "string" && doc !== ROOM && this.doc(doc) && !this.loading.has(doc)) this.loadDoc(doc);
    this.absorb(doc, ops);
  }

  // ---- sending ----------------------------------------------------------------------

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
    const docs = new Set([ROOM, ...this.loading.keys(), ...this.docs.keys()]);
    for (const doc of docs) {
      this.channel.load(doc).then((ops) => this.absorb(doc, ops), (err) => this.failed(err));
    }
    this.refreshDocs().then(() => this.emit("change", { doc: ROOM }));
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
