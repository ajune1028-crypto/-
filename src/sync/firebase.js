// Transport for the public address: a Firebase Realtime Database, spoken to
// over its REST API with fetch (no SDK, no library). Any browser that can open
// the page can join a room by its link; nothing here needs Claude.
//
//   rooms/<room>/meta                { id, kind, name, at }        written once
//   rooms/<room>/docs/<doc>/<key>    { o: "[ops as JSON]", w, t }  batches, never changed
//   rooms/<room>/peers/<screen>      { s: "{state as JSON}", t }   who is here, refreshed
//
// A screen in a room keeps one event stream on rooms/<room>. Its first message
// is the whole room (what load() reads); then come the batches any screen
// stores and presence changes. Ops travel as JSON text, so the database keeps
// them exactly (it would turn arrays into objects and drop empty ones).
//
// Rooms are not listed: the rules (docs/firebase-rules.json) let a room be read
// only by its id, so a room is as private as its link. Batches are written
// once and never overwritten or deleted by anyone.

import { Emitter } from "./transport.js";

const ROOM_ID = /^[a-z2-7]{12}$/;
const DOC_ID = /^[\w:-]{1,40}$/;
const randomKey = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * The database's address from a setting: a plain https address of a Firebase
 * Realtime Database, or a test server on this machine. Anything else is null,
 * so a link cannot point the app at someone else's server.
 */
export function serverFrom(text) {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/\/+$/, "");
  if (/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(firebaseio\.com|firebasedatabase\.app)$/.test(t)) return t;
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(t)) return t;
  return null;
}

function parseOps(text) {
  try {
    const ops = JSON.parse(text);
    return Array.isArray(ops) ? ops : [];
  } catch {
    return [];
  }
}

/** Sets `value` at `path` inside a plain tree (null removes); returns the new root. */
function setAt(root, path, value) {
  if (!path.length) return value;
  const top = root && typeof root === "object" ? root : {};
  let at = top;
  for (const key of path.slice(0, -1)) {
    if (!at[key] || typeof at[key] !== "object") at[key] = {};
    at = at[key];
  }
  const last = path[path.length - 1];
  if (value === null || value === undefined) delete at[last];
  else at[last] = value;
  return top;
}

export class FirebaseTransport {
  constructor(base, { fetchFn = null, callTimeoutMs = 8000, heartbeatMs = 20000, peerTimeoutMs = 60000, quietMs = 75000, retry = [1000, 2000, 5000, 10000, 20000], log = () => {} } = {}) {
    this.base = serverFrom(base);
    if (!this.base) throw new Error("not a database address: " + base);
    this.fetchFn = fetchFn || ((...args) => globalThis.fetch(...args));
    this.callTimeoutMs = callTimeoutMs;
    this.heartbeatMs = heartbeatMs;
    this.peerTimeoutMs = peerTimeoutMs;
    this.quietMs = quietMs;
    this.retry = retry;
    this.log = log;
    this.channels = new Set();
    this.lastError = null;
    this.readOnly = false;
  }

  url(path, query = "") {
    return this.base + "/" + path.split("/").map(encodeURIComponent).join("/") + ".json" + (query ? "?" + query : "");
  }

  note(label, err) {
    this.lastError = label + ": " + (err?.code ? err.code + " " : "") + (err?.message || err);
    this.log(this.lastError);
  }

  /** One REST call with a time limit. Resolves with the parsed answer (null for none). */
  async call(method, path, body, query = "", { keepalive = false } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.callTimeoutMs);
    try {
      const res = await this.fetchFn(this.url(path, query), {
        method, signal: ctrl.signal, keepalive,
        // Plain text keeps a POST a "simple" request: no extra round trip before it.
        headers: body === undefined ? undefined : { "Content-Type": "text/plain;charset=UTF-8" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw fail(res.status === 401 || res.status === 403 ? "permission" : "http-" + res.status, text.slice(0, 200) || res.statusText);
      return text ? JSON.parse(text) : null;
    } catch (err) {
      const reason = ctrl.signal.aborted ? fail("timeout", "no answer in " + this.callTimeoutMs + " ms") : err?.code ? err : fail("network", String(err?.message || err));
      this.note(method + " " + path.split("/").slice(0, 3).join("/"), reason);
      throw reason;
    } finally {
      clearTimeout(timer);
    }
  }

  async createRoom({ id, kind, name }) {
    if (!ROOM_ID.test(id)) throw fail("bad-id", "not a room id");
    if (await this.call("GET", `rooms/${id}/meta`)) return;
    await this.call("PUT", `rooms/${id}/meta`, { id, kind: String(kind).slice(0, 40), name: String(name).slice(0, 60), at: Date.now() }, "print=silent");
  }

  /** Rooms are found by their links and codes only; the database never lists them. */
  async listRooms() {
    return [];
  }

  async openRoom(id) {
    if (!ROOM_ID.test(id)) return null;
    if (!(await this.call("GET", `rooms/${id}/meta`))) return null;
    const channel = new FirebaseChannel(this, id);
    this.channels.add(channel);
    channel.start();
    return channel;
  }

  info() {
    const channels = [...this.channels];
    return {
      kind: "firebase",
      db: this.base.replace(/^https?:\/\//, ""),
      live: !channels.length ? "none" : channels.every((c) => c.connected) ? "connected" : "reconnecting",
      peers: Math.max(0, ...channels.map((c) => c.peerList().length)),
      lastError: this.lastError,
    };
  }

  close() {
    for (const channel of [...this.channels]) channel.close();
  }
}

class FirebaseChannel {
  constructor(transport, room) {
    this.t = transport;
    this.room = room;
    this.key = randomKey();
    this.events = new Emitter();
    this.tree = {}; // the room as streamed
    this.seen = new Set(); // "doc/key" of batches already handed on or loaded
    this.state = null;
    this.others = []; // [{ key, state }] of the screens still here
    this.othersSig = "[]";
    this.newest = 0; // the latest server time seen in presence, and when it was seen here
    this.newestAt = 0;
    this.connected = false;
    this.offline = false;
    this.fails = 0;
    this.closed = false;
    this.first = new Promise((resolve) => (this.gotFirst = resolve));
    this.hadFirst = false;
  }

  start() {
    this.connect();
    this.beat = setInterval(() => this.sendPresence(), this.t.heartbeatMs);
    this.sweep = setInterval(() => this.peersChanged(), Math.max(250, this.t.peerTimeoutMs / 3));
    this.wake = () => {
      if (!this.connected && !this.reading) {
        clearTimeout(this.retryTimer);
        this.connect();
      }
    };
    globalThis.addEventListener?.("online", this.wake);
  }

  // ---- the stream ---------------------------------------------------------------------

  async connect() {
    if (this.closed || this.reading) return;
    this.reading = true;
    const ctrl = new AbortController();
    this.abort = ctrl;
    let quiet = null;
    // The database says something at least every half minute; silence longer than quietMs is a dead line.
    const hush = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => ctrl.abort(), this.t.quietMs);
    };
    try {
      hush();
      const res = await this.t.fetchFn(this.t.url(`rooms/${this.room}`), { headers: { Accept: "text/event-stream" }, signal: ctrl.signal });
      if (!res.ok || !res.body) throw fail(res.status === 401 || res.status === 403 ? "permission" : "http-" + res.status, "the stream was refused");
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        hush();
        buffer = (buffer + value).replace(/\r\n/g, "\n");
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          this.event(block);
        }
      }
      throw fail("network", "the stream ended");
    } catch (err) {
      if (!this.closed) {
        this.t.note("stream", ctrl.signal.aborted ? fail("timeout", "the stream went quiet") : err);
        this.lost();
      }
    } finally {
      clearTimeout(quiet);
      this.reading = false;
    }
  }

  lost() {
    if (this.closed) return;
    this.connected = false;
    this.abort?.abort();
    if (!this.offline) {
      this.offline = true;
      this.events.emit("status", "offline");
    }
    const delay = this.t.retry[Math.min(this.fails, this.t.retry.length - 1)];
    this.fails++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  event(block) {
    let type = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (type === "cancel" || type === "auth_revoked") {
      this.t.note("stream", fail("permission", type));
      return void this.lost();
    }
    if (type !== "put" && type !== "patch") return; // keep-alive
    let body = null;
    try {
      body = JSON.parse(data.join("\n"));
    } catch {
      return;
    }
    if (!body || typeof body.path !== "string") return;
    const at = body.path.split("/").filter(Boolean);
    if (type === "put") this.put(at, body.data);
    else if (body.data && typeof body.data === "object") {
      for (const [k, v] of Object.entries(body.data)) this.put([...at, ...k.split("/").filter(Boolean)], v);
    }
  }

  put(at, value) {
    this.tree = setAt(this.tree, at, value) || {};
    if (!this.tree || typeof this.tree !== "object") this.tree = {};
    if (!at.length) {
      // The whole room: at first, and again after a gap. Loads read it; nothing is handed on one by one.
      for (const [doc, batches] of Object.entries(this.tree.docs || {})) for (const key of Object.keys(batches || {})) this.seen.add(doc + "/" + key);
      this.fails = 0;
      this.connected = true;
      this.hadFirst = true;
      this.gotFirst();
      if (this.offline) {
        this.offline = false;
        this.events.emit("status", "online");
      }
      this.peersChanged();
      return;
    }
    if (at[0] === "docs") this.handOn(at, value);
    else if (at[0] === "peers") this.peersChanged();
  }

  /** New batches under `at` (docs, one doc, or one batch) go to the subscribers, by doc. */
  handOn(at, value) {
    const found = [];
    if (at.length === 1) {
      for (const [doc, batches] of Object.entries(value || {})) for (const [key, b] of Object.entries(batches || {})) found.push([doc, key, b]);
    } else if (at.length === 2) {
      for (const [key, b] of Object.entries(value || {})) found.push([at[1], key, b]);
    } else {
      const b = this.tree.docs?.[at[1]]?.[at[2]];
      if (b) found.push([at[1], at[2], b]);
    }
    const byDoc = new Map();
    for (const [doc, key, b] of found.sort((p, q) => (p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0))) {
      const id = doc + "/" + key;
      if (this.seen.has(id) || typeof b?.o !== "string") continue;
      this.seen.add(id);
      const ops = parseOps(b.o);
      if (!ops.length) continue;
      if (!byDoc.has(doc)) byDoc.set(doc, []);
      byDoc.get(doc).push(...ops);
    }
    for (const [doc, ops] of byDoc) this.events.emit("ops", { doc, ops });
  }

  async whenFirst() {
    if (this.hadFirst) return;
    let timer;
    await Promise.race([
      this.first,
      new Promise((_, reject) => (timer = setTimeout(() => reject(fail("timeout", "the room did not arrive in " + this.t.callTimeoutMs + " ms")), this.t.callTimeoutMs))),
    ]).finally(() => clearTimeout(timer));
  }

  // ---- the room channel promise ---------------------------------------------------------

  async docs() {
    await this.whenFirst();
    return Object.keys(this.tree.docs || {});
  }

  async load(doc) {
    await this.whenFirst();
    const batches = this.tree.docs?.[doc] || {};
    const ops = [];
    for (const key of Object.keys(batches).sort()) {
      this.seen.add(doc + "/" + key);
      ops.push(...parseOps(batches[key]?.o));
    }
    return ops;
  }

  async append(doc, ops) {
    if (!DOC_ID.test(doc)) throw fail("bad-doc", "not a document id: " + doc);
    const made = await this.t.call("POST", `rooms/${this.room}/docs/${doc}`, { o: JSON.stringify(ops), w: this.key, t: { ".sv": "timestamp" } });
    if (made?.name) this.seen.add(doc + "/" + made.name);
  }

  subscribe(fn) {
    return this.events.on("ops", (msg) => fn(msg.doc, msg.ops));
  }

  // ---- who is here --------------------------------------------------------------------

  setPresence(state) {
    this.state = state;
    this.events.emit("peers", this.peerList());
    this.sendSoon();
  }

  /** At most a few presence writes a second: a caret moving while typing is sent as it settles. */
  sendSoon() {
    if (this.sendTimer) return void (this.sendAgain = true);
    this.sendPresence();
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      if (this.sendAgain) {
        this.sendAgain = false;
        this.sendSoon();
      }
    }, 200);
  }

  sendPresence() {
    if (this.closed || !this.state) return;
    let s = JSON.stringify(this.state);
    if (s.length > 3900) s = "{}";
    this.t.call("PUT", `rooms/${this.room}/peers/${this.key}`, { s, t: { ".sv": "timestamp" } }, "print=silent").catch(() => {});
  }

  /** Who is here: screens whose last word is within peerTimeoutMs of the newest (server times, so clocks may differ). */
  peersChanged() {
    const all = this.tree.peers || {};
    for (const p of Object.values(all)) {
      if (Number.isFinite(p?.t) && p.t > this.newest) {
        this.newest = p.t;
        this.newestAt = Date.now();
      }
    }
    const now = this.newest + (Date.now() - this.newestAt);
    const alive = [];
    for (const [key, p] of Object.entries(all).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (key === this.key || !Number.isFinite(p?.t) || p.t < now - this.t.peerTimeoutMs) continue;
      let state = {};
      try {
        state = JSON.parse(p.s) || {};
      } catch {
        state = {};
      }
      alive.push({ key, state });
    }
    const sig = JSON.stringify(alive);
    if (sig === this.othersSig) return;
    this.othersSig = sig;
    this.others = alive;
    this.events.emit("peers", this.peerList());
  }

  peerList() {
    return [{ key: this.key, isMe: true, state: this.state || {} }, ...this.others.map((p) => ({ key: p.key, isMe: false, state: p.state }))];
  }

  onPresence(fn) {
    fn(this.peerList());
    return this.events.on("peers", fn);
  }

  onStatus(fn) {
    fn(this.offline ? "offline" : "online");
    return this.events.on("status", fn);
  }

  /** Tests: this screen stops saying it is here, as one that vanished would. */
  stopBeating() {
    clearInterval(this.beat);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.abort?.abort();
    clearInterval(this.beat);
    clearInterval(this.sweep);
    clearTimeout(this.retryTimer);
    clearTimeout(this.sendTimer);
    globalThis.removeEventListener?.("online", this.wake);
    this.t.channels.delete(this);
    // Goodbye; keepalive lets it leave even while the page closes.
    this.t.call("DELETE", `rooms/${this.room}/peers/${this.key}`, undefined, "print=silent", { keepalive: true }).catch(() => {});
  }
}
