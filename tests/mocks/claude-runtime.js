// A stand-in for the trial page's runtime (`window.claude`), modelled on its
// documented behaviour: a shared document store with live snapshots, and a
// live channel whose messages are never stored and may be dropped.
// Each `view()` is one open screen; all views share one store.

const clone = (v) => JSON.parse(JSON.stringify(v));
const later = (fn, ms = 0) => { setTimeout(fn, ms); };

export function makeRuntime({ db = true, room = true, hang = false } = {}) {
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
    full: false,
    writes: 0,
    sent: [],
    store,
    view,
  };

  const docsIn = (col) => [...store.keys()].filter((p) => p.startsWith(col + "/") && !p.slice(col.length + 1).includes("/")).sort();
  const snapDoc = (path) => ({ id: path.split("/").pop(), exists: store.has(path), data: () => (store.has(path) ? clone(store.get(path)) : undefined) });

  function notify(path, type) {
    const col = path.slice(0, path.lastIndexOf("/"));
    for (const w of watchers) {
      if (w.col !== col) continue;
      later(() => {
        if (!watchers.has(w)) return;
        w.next({ docs: docsIn(col).map(snapDoc), docChanges: () => [{ type, doc: snapDoc(path) }] });
      }, rt.snapshotDelayMs);
    }
  }

  function makeDb() {
    const doc = (path) => ({
      path,
      async get() { return snapDoc(path); },
      async set(data) {
        rt.writes++;
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
    const collection = (col) => ({
      path: col,
      doc: (id) => doc(col + "/" + id),
      async get() { return { docs: docsIn(col).map(snapDoc) }; },
      onSnapshot(next) {
        const w = { col, next };
        watchers.add(w);
        later(() => {
          if (!watchers.has(w)) return;
          const docs = docsIn(col).map(snapDoc);
          next({ docs, docChanges: () => docs.map((d) => ({ type: "added", doc: d })) });
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
      const peersFor = (who) => [...group].map((m) => ({ peer: m.peer, isMe: m === who, sameTab: m === who, kind: "viewer", guest: false, by: null, presence: m.presence, updatedAt: 0 }));
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
            for (const h of m.handlers.get(topic) || []) later(() => h({ topic, data: clone(data), peer, isMe: false, sameTab: false, kind: "viewer", guest: false, by: null }));
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
        if (hang) return new Promise(() => {});
        return Promise.resolve(parts[name] ?? null);
      },
    };
  }

  return rt;
}
