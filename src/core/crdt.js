// Sequence CRDT for one sheet of text.
//
// Every change is an op. Ops can arrive in any order and more than once; the
// result is the same on every device. Order comes from ids only, never from
// wall-clock time, so a device with a wrong clock cannot scramble the text.

export const ROOT = "0";

const ID_RE = /^[1-9]\d{0,14}@[A-Za-z0-9_-]{1,24}$/;
const MAX_UNKNOWN = 500;

export function makeId(n, replica) {
  return n + "@" + replica;
}

function parse(id) {
  if (id === ROOT) return [0, ""];
  const i = id.indexOf("@");
  return [Number(id.slice(0, i)), id.slice(i + 1)];
}

export function validId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

export function cmpId(a, b) {
  if (a === b) return 0;
  const [an, ar] = parse(a);
  const [bn, br] = parse(b);
  if (an !== bn) return an < bn ? -1 : 1;
  return ar < br ? -1 : 1;
}

/** Lamport clock: every id it hands out is greater than every id it has seen. */
export class Clock {
  constructor(replica) {
    this.replica = replica;
    this.n = 0;
  }

  next() {
    return makeId(++this.n, this.replica);
  }

  see(id) {
    if (!validId(id)) return;
    this.atLeast(parse(id)[0]);
  }

  atLeast(n) {
    if (n > this.n) this.n = n;
  }
}

function greater(node, n, r) {
  return node.n > n || (node.n === n && node.r > r);
}

/** A hidden photo's data URL stays small enough for the trial store's records. */
export const MAX_ATT_CHARS = 45000;
/** 표시: highlight colours for chosen words, 빨주노초파남보. */
export const MARK_COLORS = ["red", "orange", "yellow", "green", "blue", "navy", "purple"];
/** A recording hidden in words is at most a minute (its sound is a file in the room's "files" doc). */
export const MAX_SOUND_MS = 60000;

export class Sheet {
  constructor() {
    this.version = 0;
    this.head = { id: ROOT, n: 0, r: "", next: null };
    this.nodes = new Map([[ROOT, this.head]]);
    this.seen = new Set();
    this.waiting = new Map();
    this.ready = [];
    this.pendingCount = 0;
    this.maxN = 0;
    this.mix = new Map();
    this.atts = new Map(); // photos and recordings hidden in words: id → { ch, to, kind, …, by, at, rm }
    this.markMap = new Map(); // 표시: id → { ch, to, c, by, at, rm }
    this.lockMap = new Map(); // 잠금: id → { ch, to, by, at, rm }
    this.unknown = [];
    this.cache = null;
  }

  /** Number of characters ever inserted, hidden ones included. */
  get size() {
    return this.nodes.size - 1;
  }

  get(id) {
    return this.nodes.get(id);
  }

  apply(op) {
    const result = this.step(op);
    // Ops that were waiting for a char this op created. A queue, not recursion:
    // a long paste delivered backwards would otherwise overflow the stack.
    while (this.ready.length) {
      const list = this.waiting.get(this.ready.pop());
      if (!list) continue;
      this.waiting.delete(list.key);
      this.pendingCount -= list.length;
      for (const waiting of list) this.step(waiting);
    }
    return result;
  }

  step(op) {
    if (!op || typeof op !== "object" || !validId(op.id)) return this.setAside(op);
    if (this.seen.has(op.id)) return "dup";
    switch (op.t) {
      case "ins":
        return this.applyIns(op);
      case "set":
        if (!validId(op.ch) || !isUnit(op.v)) return this.setAside(op);
        return this.onChar(op, (node) => {
          if (cmpId(op.id, node.vAt) > 0) {
            node.v = op.v;
            node.vAt = op.id;
          }
        });
      case "vis":
        if (!validId(op.ch) || !Number.isSafeInteger(op.n) || op.n < 1 || op.n > 1e9) return this.setAside(op);
        return this.onChar(op, (node) => {
          if (op.n > node.rm) node.rm = op.n;
        });
      case "att": {
        // A photo (its small picture in the op) or a recording (a file of the room) hidden in the
        // words from ch to to; it waits for both letters.
        const by = typeof op.by === "string" && op.by.length <= 40;
        const photo = op.kind === "photo" && typeof op.data === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(op.data) &&
          op.data.length <= MAX_ATT_CHARS && [op.w, op.h].every((v) => Number.isInteger(v) && v > 0 && v <= 4096);
        const sound = op.kind === "sound" && validId(op.file) && Number.isInteger(op.dur) && op.dur > 0 && op.dur <= MAX_SOUND_MS;
        if (!validId(op.ch) || !validId(op.to) || !by || !(photo || sound)) return this.setAside(op);
        return this.range(op, this.atts, photo ? { kind: "photo", data: op.data, w: op.w, h: op.h } : { kind: "sound", file: op.file, dur: op.dur });
      }
      case "mark": {
        if (!validId(op.ch) || !validId(op.to) || !MARK_COLORS.includes(op.c) || typeof op.by !== "string" || op.by.length > 40) return this.setAside(op);
        return this.range(op, this.markMap, { c: op.c });
      }
      case "lock": {
        if (!validId(op.ch) || !validId(op.to) || typeof op.by !== "string" || op.by.length > 40) return this.setAside(op);
        return this.range(op, this.lockMap, {});
      }
      case "arm":
        return this.unrange(op, this.atts, op.a);
      case "mrm":
        return this.unrange(op, this.markMap, op.m);
      case "krm":
        return this.unrange(op, this.lockMap, op.k);
      case "mix":
        if (!validId(op.ch) || ![0, 1, 2].includes(op.lv)) return this.setAside(op);
        return this.onChar(op, () => {
          const cur = this.mix.get(op.ch);
          if (!cur || cmpId(op.id, cur.at) > 0) this.mix.set(op.ch, { lv: op.lv, at: op.id });
        });
      default:
        return this.setAside(op);
    }
  }

  /** Applies many ops; true when anything changed. */
  applyAll(ops) {
    const before = this.version;
    for (const op of ops) this.apply(op);
    return this.version !== before;
  }

  applyIns(op) {
    const afterOk = op.after === ROOT || validId(op.after);
    const metaOk = typeof op.by === "string" && op.by.length > 0 && op.by.length <= 40 && Number.isFinite(op.at);
    if (!afterOk || !isUnit(op.v) || !metaOk || cmpId(op.id, op.after) <= 0) return this.setAside(op);
    const parent = this.nodes.get(op.after);
    if (!parent) return this.wait(op.after, op);

    const [n, r] = parse(op.id);
    const node = { id: op.id, n, r, v: op.v, vAt: op.id, by: op.by, at: op.at, rm: 0, next: null };
    let prev = parent;
    while (prev.next && greater(prev.next, n, r)) prev = prev.next;
    node.next = prev.next;
    prev.next = node;
    this.nodes.set(op.id, node);
    this.done(op);
    this.ready.push(op.id);
    return "applied";
  }

  onChar(op, change) {
    const node = this.nodes.get(op.ch);
    if (!node) return this.wait(op.ch, op);
    change(node);
    this.done(op);
    return "applied";
  }

  /** Something kept on the words from ch to to (a photo, a recording, a 표시, a 잠금); it waits for both letters. */
  range(op, map, fields) {
    if (!this.nodes.has(op.ch)) return this.wait(op.ch, op);
    if (!this.nodes.has(op.to)) return this.wait(op.to, op);
    const before = map.get(op.id);
    map.set(op.id, { id: op.id, ch: op.ch, to: op.to, ...fields, by: op.by, at: op.at, rm: before ? before.rm : 0 });
    this.done(op);
    this.ready.push(op.id);
    return "applied";
  }

  /** Its removes counter: odd is taken off, even is back. */
  unrange(op, map, target) {
    if (!validId(target) || !Number.isSafeInteger(op.n) || op.n < 1 || op.n > 1e9) return this.setAside(op);
    const r = map.get(target);
    if (!r) return this.wait(target, op);
    if (op.n > r.rm) r.rm = op.n;
    this.done(op);
    return "applied";
  }

  done(op) {
    this.seen.add(op.id);
    this.version++;
    const n = parse(op.id)[0];
    if (n > this.maxN) this.maxN = n;
  }

  wait(missing, op) {
    let list = this.waiting.get(missing);
    if (!list) {
      list = [];
      list.key = missing;
      this.waiting.set(missing, list);
    }
    list.push(op);
    this.pendingCount++;
    return "pending";
  }

  setAside(op) {
    if (this.unknown.length < MAX_UNKNOWN) this.unknown.push(op);
    return "unknown";
  }

  view() {
    if (this.cache && this.cache.version === this.version) return this.cache;
    const chars = [];
    const ids = [];
    const before = new Map([[ROOT, 0]]);
    for (let node = this.head.next; node; node = node.next) {
      before.set(node.id, ids.length);
      if (node.rm % 2 === 0) {
        chars.push({ id: node.id, v: node.v, by: node.by, at: node.at });
        ids.push(node.id);
      }
    }
    this.cache = { version: this.version, chars, ids, before, text: chars.map((c) => c.v).join("") };
    return this.cache;
  }

  /** Visible characters in order. */
  chars() {
    return this.view().chars;
  }

  ids() {
    return this.view().ids;
  }

  text() {
    return this.view().text;
  }

  isVisible(id) {
    const node = this.nodes.get(id);
    return !!node && id !== ROOT && node.rm % 2 === 0;
  }

  /** Caret position right after the given char; works for hidden chars too. */
  indexAfter(id) {
    const before = this.view().before.get(id);
    if (before === undefined) return 0;
    return before + (this.isVisible(id) ? 1 : 0);
  }

  /** Photos hidden in words, oldest first: [{ id, ch, to, kind, data, w, h, by, at }]. */
  attachments() {
    return [...this.atts.values()].filter((a) => a.rm % 2 === 0).sort((p, q) => cmpId(p.id, q.id));
  }

  /** 표시 on the words, oldest first. */
  marks() {
    return [...this.markMap.values()].filter((m) => m.rm % 2 === 0).sort((p, q) => cmpId(p.id, q.id));
  }

  /** 잠금 on the words, oldest first. */
  locks() {
    return [...this.lockMap.values()].filter((l) => l.rm % 2 === 0).sort((p, q) => cmpId(p.id, q.id));
  }

  mixLevel(id) {
    const entry = this.mix.get(id);
    return entry ? entry.lv : 0;
  }
}

function isUnit(v) {
  return typeof v === "string" && v.length === 1;
}
