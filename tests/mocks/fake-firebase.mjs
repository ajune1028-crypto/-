// A stand-in for a Firebase Realtime Database, as much of it as the app uses:
// the REST API (GET with shallow, PUT, POST, PATCH with multi-path keys, DELETE,
// print=silent, {".sv": "timestamp"}), event streams (put, patch, keep-alive),
// CORS for pages on another port, and the rules in docs/firebase-rules.json
// (a room is read only by its id, rooms are never listed, meta and batches are
// written once, presence is free). Tests use it to check the transport without
// an account; tools/e2e.mjs starts one for the browser scenarios.
//
// Test hooks: dropStreams() cuts every open stream (a lost connection),
// setDown(true) makes every request fail, hang(true) makes requests wait forever.

import { createServer } from "node:http";

const ROOM_ID = /^[a-z2-7]{12}$/;
const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

/** Firebase-style push ids: time first, so they sort in the order they were made. */
function pushIdMaker() {
  let lastTime = 0;
  let lastRandom = [];
  return () => {
    let now = Date.now();
    const same = now === lastTime;
    lastTime = now;
    const time = new Array(8);
    for (let i = 7; i >= 0; i--) {
      time[i] = PUSH_CHARS.charAt(now % 64);
      now = Math.floor(now / 64);
    }
    if (!same) lastRandom = Array.from({ length: 12 }, () => Math.floor(Math.random() * 64));
    else {
      let i = 11;
      for (; i >= 0 && lastRandom[i] === 63; i--) lastRandom[i] = 0;
      lastRandom[i]++;
    }
    return time.join("") + lastRandom.map((n) => PUSH_CHARS.charAt(n)).join("");
  };
}

const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Server values ({".sv": "timestamp"}) become the time; arrays are kept as the database does (as objects). */
function resolve(value, now) {
  if (Array.isArray(value)) return resolve(Object.fromEntries(value.map((v, i) => [String(i), v])), now);
  if (!isObject(value)) return value;
  if (value[".sv"] === "timestamp") return now;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const r = resolve(v, now);
    if (r !== null && !(isObject(r) && !Object.keys(r).length)) out[k] = r;
  }
  return Object.keys(out).length ? out : null;
}

export async function startFakeFirebase({ keepAliveMs = 30000, rules = true } = {}) {
  let root = null;
  let down = false;
  let hanging = false;
  const streams = new Set(); // { path: [...], res }
  const nextPushId = pushIdMaker();
  const requests = [];

  const get = (parts) => {
    let at = root;
    for (const p of parts) {
      if (!isObject(at) || !(p in at)) return null;
      at = at[p];
    }
    return at;
  };
  const set = (parts, value) => {
    if (!parts.length) {
      root = value;
      return;
    }
    if (!isObject(root)) root = {};
    let at = root;
    const trail = [];
    for (const p of parts.slice(0, -1)) {
      if (!isObject(at[p])) at[p] = {};
      trail.push([at, p]);
      at = at[p];
    }
    const last = parts[parts.length - 1];
    if (value === null) delete at[last];
    else at[last] = value;
    // Empty objects vanish, as in the database.
    for (let i = trail.length - 1; i >= 0; i--) {
      const [parent, key] = trail[i];
      if (isObject(parent[key]) && !Object.keys(parent[key]).length) delete parent[key];
    }
    if (isObject(root) && !Object.keys(root).length) root = null;
  };

  // ---- rules (docs/firebase-rules.json) ------------------------------------------------

  const only = (value, keys) => Object.keys(value).every((k) => keys.includes(k));
  const canRead = (parts) => !rules || (parts[0] === "rooms" && parts.length >= 2 && ROOM_ID.test(parts[1]));

  /** Whether writing `value` at `parts` is allowed, checked at the level the rules speak about. */
  function canWrite(parts, value) {
    if (!rules) return true;
    if (parts[0] !== "rooms" || parts.length < 3 || !ROOM_ID.test(parts[1])) return false;
    const [, room, part, a, b] = parts;
    if (part === "meta") {
      if (parts.length !== 3 || get(parts) !== null) return false;
      return isObject(value) && only(value, ["id", "kind", "name", "at"]) && value.id === room && typeof value.name === "string" && value.name.length <= 60 &&
        typeof value.kind === "string" && value.kind.length <= 40 && Number.isFinite(value.at);
    }
    if (part === "docs") {
      if (parts.length !== 5 || a.length > 40 || get(parts) !== null) return false;
      return isObject(value) && only(value, ["o", "w", "t"]) && typeof value.o === "string" && value.o.length <= 2000000 && typeof value.w === "string" && value.w.length <= 16 &&
        (value.t === undefined || Number.isFinite(value.t));
    }
    if (part === "peers") {
      if (parts.length !== 4 || a.length > 16) return false;
      return value === null || (isObject(value) && only(value, ["s", "t"]) && typeof value.s === "string" && value.s.length <= 4000 && Number.isFinite(value.t));
    }
    void b;
    return false;
  }

  // ---- streams ------------------------------------------------------------------------

  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  /** Tells every stream under or above `parts` what changed there. */
  function announce(parts, event = "put", patch = null) {
    for (const s of streams) {
      const n = Math.min(s.path.length, parts.length);
      if (s.path.slice(0, n).join("/") !== parts.slice(0, n).join("/")) continue;
      if (parts.length >= s.path.length) {
        const rel = "/" + parts.slice(s.path.length).join("/");
        if (event === "patch") send(s.res, "patch", { path: rel, data: patch });
        else send(s.res, "put", { path: rel, data: clone(get(parts)) });
      } else send(s.res, "put", { path: "/", data: clone(get(s.path)) });
    }
  }

  // ---- requests -----------------------------------------------------------------------

  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    if (hanging) return; // never answers
    if (down) return void req.socket.destroy();
    const url = new URL(req.url, "http://x");
    const m = /^\/(.*)\.json$/.exec(url.pathname);
    if (!m) return void res.writeHead(404).end(JSON.stringify({ error: "404 Not Found" }));
    const parts = m[1].split("/").filter(Boolean).map(decodeURIComponent);
    requests.push(req.method + " /" + parts.join("/"));
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const deny = () => reply(401, { error: "Permission denied" });
    const silent = url.searchParams.get("print") === "silent";

    if (req.method === "GET") {
      if (!canRead(parts)) return deny();
      if ((req.headers.accept || "").includes("text/event-stream")) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const stream = { path: parts, res };
        streams.add(stream);
        send(res, "put", { path: "/", data: clone(get(parts)) });
        const beat = setInterval(() => res.write("event: keep-alive\ndata: null\n\n"), keepAliveMs);
        const end = () => {
          clearInterval(beat);
          streams.delete(stream);
        };
        req.on("close", end);
        res.on("close", end);
        return;
      }
      const value = clone(get(parts));
      if (url.searchParams.get("shallow") === "true" && isObject(value)) return reply(200, Object.fromEntries(Object.keys(value).map((k) => [k, true])));
      return reply(200, value);
    }

    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body = null;
      if (req.method !== "DELETE") {
        try {
          body = JSON.parse(raw);
        } catch {
          return reply(400, { error: "Invalid data; couldn't parse JSON object, array, or value." });
        }
      }
      const now = Date.now();
      if (req.method === "PUT" || req.method === "DELETE") {
        const value = req.method === "DELETE" ? null : resolve(body, now);
        if (!canWrite(parts, value)) return deny();
        set(parts, value);
        announce(parts);
        return silent ? reply(204) : reply(200, clone(value));
      }
      if (req.method === "POST") {
        const at = [...parts, nextPushId()];
        const value = resolve(body, now);
        if (!canWrite(at, value)) return deny();
        set(at, value);
        announce(at);
        return silent ? reply(204) : reply(200, { name: at[at.length - 1] });
      }
      if (req.method === "PATCH") {
        if (!isObject(body)) return reply(400, { error: "Invalid data; patch must be an object." });
        const writes = Object.entries(body).map(([k, v]) => [[...parts, ...k.split("/").filter(Boolean)], resolve(v, now)]);
        if (!writes.every(([p, v]) => canWrite(p, v))) return deny();
        for (const [p, v] of writes) set(p, v);
        const patch = Object.fromEntries(writes.map(([p, v]) => [p.slice(parts.length).join("/"), clone(v)]));
        announce(parts, "patch", patch);
        return silent ? reply(204) : reply(200, clone(body));
      }
      reply(405, { error: "Method not allowed" });
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    data: () => clone(root),
    dropStreams() {
      for (const s of [...streams]) {
        streams.delete(s);
        s.res.destroy();
      }
    },
    setDown(v) {
      down = v;
      if (v) this.dropStreams();
    },
    hang(v) {
      hanging = v;
    },
    streamCount: () => streams.size,
    close() {
      this.dropStreams();
      server.closeAllConnections?.();
      return new Promise((r) => server.close(() => r()));
    },
  };
}
