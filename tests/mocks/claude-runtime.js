// A stand-in for the trial page's runtime (`window.claude`), modelled on its
// documented behaviour: a shared document store with live snapshots, and a
// live channel whose messages are never stored and may be dropped.
// Each `view()` is one open screen; all views share one store.

const clone = (v) => JSON.parse(JSON.stringify(v));
const later = (fn, ms = 0) => { setTimeout(fn, ms); };
const never = () => new Promise(() => {});

/** Delivered snapshots, messages and peers are frozen, as the platform's are. */
function freeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const key of Object.keys(v)) freeze(v[key]);
  }
  return v;
}

const SEGMENT = /^[A-Za-z0-9_\-.~:@+]+$/;
/** The store's path grammar: builders throw a TypeError for a path that breaks it. */
function checkPath(path, document) {
  const parts = String(path).split("/");
  for (const part of parts) {
    if (!SEGMENT.test(part) || part === "." || part === ".." || new TextEncoder().encode(part).length > 200) throw new TypeError("bad path segment: " + part);
  }
  if (parts.length > 16 || new TextEncoder().encode(String(path)).length > 1000) throw new TypeError("path too long: " + path);
  if ((parts.length % 2 === 0) !== document) throw new TypeError(path + ": " + (document ? "a document path has an even number of segments" : "a collection path has an odd number of segments"));
}

export function makeRuntime({ db = true, room = true, hang = false, hangRoom = false, roomDelayMs = 0 } = {}) {
  const store = new Map();
  const watchers = new Set();
  const groups = new Map();
  let nextPeer = 0;

  const rt = {
    lossy: false,
    snapshotDelayMs: 0,
    writeDelayMs: 0,
    failWrites: 0,
    denyWrites: false,
    rejectWrites: null,
    hangWrites: false,
    hangReads: false,
    full: false,
    writes: 0,
    sent: [],
    store,
    view,
  };

  const docsIn = (col) => [...store.keys()].filter((p) => p.startsWith(col + "/") && !p.slice(col.length + 1).includes("/")).sort();
  const snapDoc = (path) => {
    const body = store.has(path) ? freeze(clone(store.get(path))) : undefined;
    return freeze({ id: path.split("/").pop(), exists: body !== undefined, data: () => body, metadata: { fromCache: false, hasPendingWrites: false } });
  };

  function notify(path, type) {
    const col = path.slice(0, path.lastIndexOf("/"));
    for (const w of watchers) {
      if (w.col !== col) continue;
      later(() => {
        if (!watchers.has(w)) return;
        w.next(freeze({ docs: docsIn(col).map(snapDoc), docChanges: () => [{ type, doc: snapDoc(path) }] }));
      }, rt.snapshotDelayMs);
    }
  }

  function makeDb() {
    const doc = (path) => (checkPath(path, true), {
      path,
      async get() { return rt.hangReads ? never() : snapDoc(path); },
      async delete() { if (store.delete(path)) notify(path, "removed"); },
      async set(data) {
        rt.writes++;
        if (rt.hangWrites) return never();
        if (rt.rejectWrites) throw { code: rt.rejectWrites, message: "refused in this view" };
        if (!data || typeof data !== "object" || Array.isArray(data)) throw { code: "invalid_argument", message: "a document body is a plain object" };
        if (rt.writeDelayMs) await new Promise((r) => later(r, rt.writeDelayMs));
        if (rt.failWrites > 0) { rt.failWrites--; throw { code: "unavailable", message: "try again" }; }
        if (rt.denyWrites) throw { code: "invalid_argument", message: "this viewer may not write" };
        if (rt.full) throw { code: "quota_exceeded", message: "database is full" };
        if (JSON.stringify(data).length > 256 * 1024) throw { code: "invalid_argument", message: "document too large" };
        const type = store.has(path) ? "modified" : "added";
        store.set(path, clone(data));
        notify(path, type);
      },
    });
    const collection = (col) => (checkPath(col, false), {
      path: col,
      doc: (id) => doc(col + "/" + id),
      async get() { return rt.hangReads ? never() : freeze({ docs: docsIn(col).map(snapDoc) }); },
      onSnapshot(next) {
        const w = { col, next };
        watchers.add(w);
        later(() => {
          if (!watchers.has(w)) return;
          const docs = docsIn(col).map(snapDoc);
          next(freeze({ docs, docChanges: () => docs.map((d) => ({ type: "added", doc: d })) }));
        }, rt.snapshotDelayMs);
        return () => watchers.delete(w);
      },
    });
    return { doc, collection };
  }

  function makeRoom(peer) {
    const join = async (name) => {
      if (!groups.has(name)) groups.set(name, new Set());
      const group = groups.get(name);
      const me = { peer, presence: {}, handlers: new Map(), peerHandlers: new Set() };
      group.add(me);
      const peersFor = (who) => freeze([...group].map((m) => ({ peer: m.peer, isMe: m === who, sameTab: m === who, kind: "viewer", guest: false, by: null, presence: clone(m.presence), updatedAt: 0 })));
      const tellPeers = () => { for (const m of group) for (const h of m.peerHandlers) later(() => h({ peers: peersFor(m), joined: [], left: [], updated: [] })); };
      tellPeers();
      return {
        name,
        async emit(topic, data) {
          const bytes = new TextEncoder().encode(JSON.stringify(data)).length;
          if (bytes > 4096) throw { code: "invalid_argument", message: "over 4 KiB" };
          rt.sent.push({ topic, bytes });
          if (rt.lossy) return;
          for (const m of group) {
            if (m === me) continue;
            for (const h of m.handlers.get(topic) || []) later(() => h(freeze({ topic, data: clone(data), peer, isMe: false, sameTab: false, kind: "viewer", guest: false, by: null })));
          }
        },
        on(topic, handler) {
          if (!me.handlers.has(topic)) me.handlers.set(topic, new Set());
          me.handlers.get(topic).add(handler);
          return () => me.handlers.get(topic).delete(handler);
        },
        async presence(patch) { me.presence = { ...me.presence, ...patch }; tellPeers(); },
        peers: () => peersFor(me),
        onPeers(handler) { me.peerHandlers.add(handler); later(() => handler({ peers: peersFor(me), joined: [], left: [], updated: [] })); return () => me.peerHandlers.delete(handler); },
        connected: () => true,
        onConnection(handler) { later(() => handler(true)); return () => {}; },
        async leave() { group.delete(me); tellPeers(); },
      };
    };
    return { join };
  }

  function view() {
    const peer = "peer" + ++nextPeer;
    const parts = { db: db ? makeDb() : null, room: room ? makeRoom(peer) : null };
    return {
      use(name) {
        if (hang || (name === "room" && hangRoom)) return never();
        if (name === "room" && roomDelayMs) return new Promise((resolve) => later(() => resolve(parts.room), roomDelayMs));
        return Promise.resolve(parts[name] ?? null);
      },
    };
  }

  return rt;
}
