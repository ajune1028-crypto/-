// A room's shared facts: its name and kind, and the people in it.
//
// There is no login. A person is a name and a colour inside one room, and may
// set a five-digit personal code so another device can become the same person.

import { cmpId, validId } from "./crdt.js";
import { PALETTE } from "./paint.js";

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

async function digest(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
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

  /** The lowest palette index nobody uses; once all are taken, the least used. */
  freeColor() {
    const used = new Array(PALETTE.length).fill(0);
    for (const m of this.members()) used[m.color]++;
    return used.indexOf(Math.min(...used));
  }
}

/** Ops that set fields of one person. */
export function memberOps(clock, memberId, fields) {
  return Object.entries(fields).map(([k, v]) => ({ t: "mem", id: clock.next(), m: memberId, k, v }));
}

export function createRoomOps(clock, { kind, name, tz, now, memberId, memberName, pin }) {
  const facts = { kind, name, tz, createdAt: now, createdBy: memberId };
  return [
    ...Object.entries(facts).map(([k, v]) => ({ t: "meta", id: clock.next(), k, v })),
    ...memberOps(clock, memberId, { name: memberName, color: 0, pin: pin ?? null, joinedAt: now }),
  ];
}

export function joinOps(clock, room, { memberId, name, pin, now }) {
  return memberOps(clock, memberId, { name, color: room.freeColor(), pin: pin ?? null, joinedAt: now });
}
