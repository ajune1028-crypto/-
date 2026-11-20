// A room's shared facts: its name and kind, and the people in it; and its 역사 (the owner: "처음 시작한
// 날짜, 그리고 현재 지금 수정한 날짜 가장 최근에, 그리고 방에 누가 언제 들어갔는지"):
//   seen { m, at }        someone came in (noted at most once in half an hour)
//   did  { m, at, k, n }  what someone made: k a kind of work (녹음, 그림, 글…), n how many, gathered
//                         over ten minutes
//
// There is no login. A person is a name and a colour inside one room, and may
// set a five-digit personal code so another device can become the same person.

import { cmpId, validId } from "./crdt.js";
import { PALETTE } from "./paint.js";
import { dayKey } from "./time.js";

export const WORK_KINDS = ["녹음", "노래", "글", "그림", "카드", "보드", "애니", "게임"];
const SEEN_EVERY_MS = 30 * 60 * 1000;
const MAX_LOG = 4000;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const MEMBER_ID = /^[a-z0-9]{1,24}$/;
const MAX_FAILS = 5;
const LOCK_MS = 30000;
const MAX_UNKNOWN = 200;

function randomString(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join("");
}

export function newRoomId() {
  return randomString(12);
}

export function newMemberId() {
  return randomString(8);
}

export function newReplicaId() {
  return randomString(6);
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * SHA-256 in plain JavaScript. The browser's own digest only exists on secure
 * pages, and a code set on one device must check the same way on every other.
 */
export function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rot = (x, n) => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

async function digest(text) {
  return sha256Hex(text);
}

/** What is stored instead of a password or personal code. */
export async function makeVerifier(secret) {
  const salt = randomString(8);
  return { salt, hash: await digest(salt + ":" + secret) };
}

export async function checkVerifier(secret, verifier) {
  if (!validVerifier(verifier) || typeof secret !== "string") return false;
  return (await digest(verifier.salt + ":" + secret)) === verifier.hash;
}

function validVerifier(v) {
  return !!v && typeof v === "object" && typeof v.salt === "string" && typeof v.hash === "string" && v.salt.length <= 32 && v.hash.length === 64;
}

export function validPin(s) {
  return typeof s === "string" && /^\d{5}$/.test(s);
}

/** Five wrong tries, then a 30-second wait. */
export class Attempts {
  constructor() {
    this.fails = 0;
    this.until = 0;
  }

  fail(now) {
    this.fails++;
    if (this.fails >= MAX_FAILS) {
      this.fails = 0;
      this.until = now + LOCK_MS;
    }
  }

  ok() {
    this.fails = 0;
    this.until = 0;
  }

  lockedMs(now) {
    return Math.max(0, this.until - now);
  }
}

const FIELD_OK = {
  name: (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 20,
  color: (v) => Number.isInteger(v) && v >= 0 && v < PALETTE.length,
  pin: (v) => v === null || validVerifier(v),
  joinedAt: (v) => Number.isFinite(v),
};

function plain(v, depth = 0) {
  if (v === null || ["string", "number", "boolean"].includes(typeof v)) return typeof v !== "string" || v.length <= 2000;
  if (typeof v !== "object" || depth > 3) return false;
  return Object.values(v).every((x) => plain(x, depth + 1));
}

/** Last-writer-wins registers: one per room fact, one per field of each person. */
export class RoomState {
  constructor() {
    this.version = 0;
    this.facts = new Map();
    this.people = new Map();
    this.unknown = [];
    this.log = []; // seen and did, as they came
    this.logIds = new Set();
  }

  apply(op) {
    if (!op || typeof op !== "object" || !validId(op.id)) return this.setAside(op);
    if (op.t === "meta") {
      if (typeof op.k !== "string" || !op.k || op.k.length > 32 || !plain(op.v)) return this.setAside(op);
      return this.put(this.facts, op.k, op);
    }
    if (op.t === "mem") {
      if (typeof op.m !== "string" || !MEMBER_ID.test(op.m) || !FIELD_OK[op.k] || !FIELD_OK[op.k](op.v)) return this.setAside(op);
      if (!this.people.has(op.m)) this.people.set(op.m, new Map());
      return this.put(this.people.get(op.m), op.k, op);
    }
    if (op.t === "seen" || op.t === "did") {
      const ok = typeof op.m === "string" && MEMBER_ID.test(op.m) && Number.isFinite(op.at) && op.at > 0 &&
        (op.t === "seen" || (WORK_KINDS.includes(op.k) && Number.isInteger(op.n) && op.n >= 1 && op.n <= 100000));
      if (!ok) return this.setAside(op);
      if (this.logIds.has(op.id)) return "dup";
      this.logIds.add(op.id);
      this.log.push(op.t === "seen" ? { t: "seen", id: op.id, m: op.m, at: op.at } : { t: "did", id: op.id, m: op.m, at: op.at, k: op.k, n: op.n });
      if (this.log.length > MAX_LOG) {
        this.log.sort((a, b) => a.at - b.at || cmpId(a.id, b.id));
        this.log.splice(0, this.log.length - MAX_LOG);
      }
      this.version++;
      return "applied";
    }
    return this.setAside(op);
  }

  applyAll(ops) {
    const before = this.version;
    for (const op of ops) this.apply(op);
    return this.version !== before;
  }

  put(map, key, op) {
    const cur = map.get(key);
    if (cur && cmpId(op.id, cur.at) <= 0) return "dup";
    map.set(key, { v: op.v, at: op.id });
    this.version++;
    return "applied";
  }

  setAside(op) {
    if (this.unknown.length < MAX_UNKNOWN) this.unknown.push(op);
    return "unknown";
  }

  meta(key) {
    return this.facts.get(key)?.v;
  }

  member(id) {
    const fields = this.people.get(id);
    const name = fields?.get("name")?.v;
    if (!name) return null;
    return {
      id,
      name,
      color: fields.get("color")?.v ?? 0,
      pin: fields.get("pin")?.v ?? null,
      joinedAt: fields.get("joinedAt")?.v ?? 0,
    };
  }

  /** Everyone who has a name, in the order they joined. */
  members() {
    return [...this.people.keys()]
      .map((id) => this.member(id))
      .filter(Boolean)
      .sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
  }

  /** Whether this person's coming in was noted within the last half hour. */
  seenRecently(memberId, now) {
    return this.log.some((e) => e.t === "seen" && e.m === memberId && now - e.at >= 0 && now - e.at < SEEN_EVERY_MS);
  }

  /**
   * The room's story: { createdAt, createdBy, lastAt, lastBy (the latest change), visits: [{ m, at }]
   * newest first, days: [{ day ("YYYY-MM-DD" in the room's time zone), work: [{ m, k, n }] }] newest first }.
   * Rooms from before this was kept have their start and their people's first coming in.
   */
  history() {
    const tz = this.meta("tz") || "UTC";
    const byTime = (a, b) => b.at - a.at || cmpId(b.id, a.id);
    const log = this.log.slice().sort(byTime);
    const visits = log.filter((e) => e.t === "seen").map(({ m, at }) => ({ m, at }));
    for (const p of this.members()) if (p.joinedAt && !visits.some((v) => v.m === p.id && v.at <= p.joinedAt + 1000)) visits.push({ m: p.id, at: p.joinedAt });
    visits.sort((a, b) => b.at - a.at || (a.m < b.m ? -1 : 1));
    const work = log.filter((e) => e.t === "did");
    const last = work[0];
    const days = new Map();
    for (const e of work.slice().reverse()) {
      const day = dayKey(e.at, tz);
      if (!days.has(day)) days.set(day, new Map());
      const key = e.m + "|" + e.k;
      const all = days.get(day);
      all.set(key, { m: e.m, k: e.k, n: (all.get(key)?.n || 0) + e.n });
    }
    return {
      createdAt: this.meta("createdAt") ?? null,
      createdBy: this.meta("createdBy") ?? null,
      lastAt: last ? last.at : null,
      lastBy: last ? last.m : null,
      visits,
      days: [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, all]) => ({ day, work: [...all.values()] })),
    };
  }

  /** The lowest palette index nobody uses; once all are taken, the least used. */
  freeColor() {
    const used = new Array(PALETTE.length).fill(0);
    for (const m of this.members()) used[m.color]++;
    return used.indexOf(Math.min(...used));
  }
}

/** Noting that someone came in. */
export function seenOps(clock, memberId, now = Date.now()) {
  return [{ t: "seen", id: clock.next(), m: memberId, at: now }];
}

/** Noting what someone made: counts by kind of work ({ 녹음: 2, 그림: 14 }). */
export function didOps(clock, memberId, counts, now = Date.now()) {
  return Object.entries(counts).filter(([k, n]) => WORK_KINDS.includes(k) && n > 0).map(([k, n]) => ({ t: "did", id: clock.next(), m: memberId, at: now, k, n: Math.min(100000, Math.round(n)) }));
}

/** Ops that set fields of one person. */
export function memberOps(clock, memberId, fields) {
  return Object.entries(fields).map(([k, v]) => ({ t: "mem", id: clock.next(), m: memberId, k, v }));
}

export function createRoomOps(clock, { kind, name, tz, now, memberId, memberName, pin, color = 0 }) {
  const facts = { kind, name, tz, createdAt: now, createdBy: memberId };
  return [
    ...Object.entries(facts).map(([k, v]) => ({ t: "meta", id: clock.next(), k, v })),
    ...memberOps(clock, memberId, { name: memberName, color, pin: pin ?? null, joinedAt: now }),
  ];
}

/** A newcomer's ops; `color` is the colour they prefer (their glass colour's), else the first free one. */
export function joinOps(clock, room, { memberId, name, pin, now, color = null }) {
  return memberOps(clock, memberId, { name, color: color ?? room.freeColor(), pin: pin ?? null, joinedAt: now });
}

/** The address that opens a room: the page's own address with the room after the #. */
export function roomLink(base, roomId) {
  return String(base).split("#")[0] + "#r-" + roomId;
}
