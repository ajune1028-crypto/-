// 나의 고유 코드 (the owner, 21 November: "처음 이 앱을 들어왔을 때 생기는 좀 복잡한 코드… '이건 당신의
// 식별 코드입니다. 이걸 안다면 당신의 모든 것들을 어디에서나 로그인할 수 있습니다'… 구글에서든 어디든").
// Made once on a device; typed on another device it brings everything of mine there: my rooms (and
// who I am in each), my houses, my stars, my settings, 비서's notes. No login: the code is the key.
//
// The code itself never leaves the device. Where my things are kept is a room whose id is a hash of
// the code (placeOf), and what is kept there is sealed with a key made from the code (sealFor:
// PBKDF2 → AES-GCM), so only someone who has the code can find it or read it. Each device adds what
// it holds now; everything kept comes together the same way whatever the order (mergeBundles).

// Letters and digits nobody mixes up: no 0/O, 1/I/L.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 16;
const GROUP = 4;

const subtle = () => globalThis.crypto.subtle;

/** A new code, e.g. "7KQ4-M2XD-9PFA-3WNE" (31^16, about 2^79 of them). */
export function newMyCode() {
  const out = [];
  const bytes = new Uint8Array(64);
  while (out.length < CODE_LENGTH) {
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) {
      // Only below 248 (8 × 31), so every letter is as likely as any other.
      if (b < 248 && out.length < CODE_LENGTH) out.push(ALPHABET[b % 31]);
    }
  }
  return formatCode(out.join(""));
}

/** The code as letters only, upper case (typed with spaces, dashes or in lower case is the same). */
export function normalizeCode(text) {
  return String(text || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function validCode(text) {
  const norm = normalizeCode(text);
  return norm.length === CODE_LENGTH && [...norm].every((c) => ALPHABET.includes(c));
}

/** In four groups: "7KQ4-M2XD-9PFA-3WNE". */
export function formatCode(norm) {
  const s = normalizeCode(norm);
  const parts = [];
  for (let i = 0; i < s.length; i += GROUP) parts.push(s.slice(i, i + GROUP));
  return parts.join("-");
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** The room where my things are kept: twelve letters from a hash of the code, never the code. */
export async function placeOf(code) {
  const digest = new Uint8Array(await subtle().digest("SHA-256", new TextEncoder().encode("hamkke-me:" + normalizeCode(code))));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 12) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 12) break;
  }
  return out;
}

const keys = new Map();
async function keyOf(code) {
  const norm = normalizeCode(code);
  if (!keys.has(norm)) {
    const base = await subtle().importKey("raw", new TextEncoder().encode(norm), "PBKDF2", false, ["deriveKey"]);
    keys.set(norm, subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode("hamkke-me-seal"), iterations: 120000 },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
  }
  return keys.get(norm);
}

const toB64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** What I keep, sealed with my code: "v1." + base64 of a fresh iv and the AES-GCM sealed JSON. */
export async function sealFor(code, value) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, await keyOf(code), new TextEncoder().encode(JSON.stringify(value))));
  const all = new Uint8Array(iv.length + data.length);
  all.set(iv);
  all.set(data, iv.length);
  return "v1." + toB64(all);
}

/** Opened with my code; null when it is not mine (another code) or not whole. */
export async function openFor(code, sealed) {
  try {
    if (typeof sealed !== "string" || !sealed.startsWith("v1.")) return null;
    const all = fromB64(sealed.slice(3));
    const plain = await subtle().decrypt({ name: "AES-GCM", iv: all.subarray(0, 12) }, await keyOf(code), all.subarray(12));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

/**
 * What every device kept, as one: every room and house (the newest of each by its own `at`), the
 * stars, the settings saved last, 비서's notes; a room forgotten on any device stays forgotten. The
 * same result in any order.
 */
export function mergeBundles(list) {
  const kept = list.filter((b) => b && typeof b === "object")
    .sort((a, b) => (a.at || 0) - (b.at || 0) || (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  const forgotten = new Set(kept.flatMap((b) => (Array.isArray(b.forgotten) ? b.forgotten : [])));
  const newest = (key) => {
    const byId = new Map();
    for (const b of kept) {
      for (const x of Array.isArray(b[key]) ? b[key] : []) {
        if (!x || typeof x.id !== "string") continue;
        const was = byId.get(x.id);
        if (!was || (x.at || 0) >= (was.at || 0)) byId.set(x.id, x);
      }
    }
    return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  };
  const rooms = newest("rooms").filter((r) => !forgotten.has(r.id));
  const houses = newest("houses").map((h) => ({ ...h, rooms: (h.rooms || []).filter((id) => !forgotten.has(id)) }));
  const stars = [...new Set(kept.flatMap((b) => (Array.isArray(b.stars) ? b.stars : [])))].filter((id) => !forgotten.has(id)).sort();
  const settings = Object.assign({}, ...kept.map((b) => (b.settings && typeof b.settings === "object" ? b.settings : {})));
  return { at: Math.max(0, ...kept.map((b) => b.at || 0)), rooms, houses, stars, settings, notes: newest("notes"), forgotten: [...forgotten].sort() };
}
