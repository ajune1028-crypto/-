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

// The last letter checks the others, the way an ISBN-10 does (weights 1, 2, 3, … and a prime
// modulus; public, written here from its description). Syncthing's Luhn mod N needs an even alphabet
// and ours has 31 letters, a prime, which suits the weighted sum: every letter typed wrong and every
// swap of two neighbours changes the sum, so a mistyped code is caught before it opens an empty
// universe.
function weightedSum(letters) {
  let sum = 0;
  for (let i = 0; i < letters.length; i++) sum += (i + 1) * ALPHABET.indexOf(letters[i]);
  return sum % ALPHABET.length;
}
function checkLetter(letters) {
  // Σ i·dᵢ over all sixteen must be 0 (mod 31); the sixteenth weighs 16, and 16 × 2 = 32 ≡ 1.
  const n = ALPHABET.length;
  return ALPHABET[(n - ((2 * weightedSum(letters)) % n)) % n];
}

/** A new code, e.g. "7KQ4-M2XD-9PFA-3WNE": fifteen random letters (31^15, about 2^74) and a check letter. */
export function newMyCode() {
  const out = [];
  const bytes = new Uint8Array(64);
  while (out.length < CODE_LENGTH - 1) {
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) {
      // Only below 248 (8 × 31), so every letter is as likely as any other.
      if (b < 248 && out.length < CODE_LENGTH - 1) out.push(ALPHABET[b % 31]);
    }
  }
  return formatCode(out.join("") + checkLetter(out.join("")));
}

/** The code as letters only, upper case (typed with spaces, dashes or in lower case is the same). */
export function normalizeCode(text) {
  return String(text || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function validCode(text) {
  const norm = normalizeCode(text);
  return norm.length === CODE_LENGTH && [...norm].every((c) => ALPHABET.includes(c)) && weightedSum(norm) === 0;
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

// What every device keeps of mine is a set of registers, one per thing: "room:<id>", "house:<id>",
// "star:<id>", "set:<setting>". Each holds the value and when this universe last changed it; a thing
// taken away is a register too (gone), so a room forgotten on one device stays forgotten everywhere
// until it is entered again later, and an older device cannot bring it back. The newest write wins
// (the LWW-element-set of the CRDT literature, Shapiro et al. 2011); ties go the same way everywhere.

const keyOrder = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const later = (it, was) => !was || it.at > was.at || (it.at === was.at && JSON.stringify(it) > JSON.stringify(was));

/** Every device's registers as one: the newest of each. The same result in any order, any number of times. */
export function mergeBundles(list) {
  const best = new Map();
  for (const b of list) {
    for (const it of b && Array.isArray(b.items) ? b.items : []) {
      if (!it || typeof it.key !== "string" || !Number.isFinite(it.at)) continue;
      if (later(it, best.get(it.key))) best.set(it.key, it);
    }
  }
  return { items: [...best.values()].sort(keyOrder) };
}

/**
 * This device's things now, as registers. `things` maps a key to its value as it stands; `ledger`
 * is what was written before ({ key: { at, h, gone } }). A changed value is written `now`, an
 * unchanged one keeps its time, one no longer there is written gone `now`. Returns the registers
 * and the ledger to keep.
 */
export function itemsNow(things, ledger = {}, now = Date.now()) {
  const items = [];
  const next = {};
  for (const [key, v] of things) {
    const h = JSON.stringify(v);
    const was = ledger[key];
    const at = was && !was.gone && was.h === h ? was.at : now;
    next[key] = { at, h };
    items.push({ key, at, v });
  }
  for (const [key, was] of Object.entries(ledger)) {
    if (next[key]) continue;
    const at = was.gone ? was.at : now;
    next[key] = { at, gone: true };
    items.push({ key, at, gone: true });
  }
  return { items: items.sort(keyOrder), ledger: next };
}

/** The ledger that says "this device already has exactly these" (after the universe was put on it). */
export function ledgerOf(items) {
  const out = {};
  for (const it of items) out[it.key] = it.gone ? { at: it.at, gone: true } : { at: it.at, h: JSON.stringify(it.v) };
  return out;
}

/** The registers read back as rooms, houses, stars and settings; a forgotten room leaves its house and its star. */
export function viewOf(items) {
  const out = { rooms: [], houses: [], stars: [], settings: {} };
  for (const it of items) {
    if (it.gone) continue;
    const cut = it.key.indexOf(":");
    const kind = it.key.slice(0, cut);
    const id = it.key.slice(cut + 1);
    if (kind === "room") out.rooms.push({ ...it.v, id });
    else if (kind === "house") out.houses.push({ ...it.v, id });
    else if (kind === "star") out.stars.push(id);
    else if (kind === "set") out.settings[id] = it.v;
  }
  const gone = new Set(items.filter((it) => it.gone && it.key.startsWith("room:")).map((it) => it.key.slice(5)));
  out.houses = out.houses.map((h) => ({ ...h, rooms: (h.rooms || []).filter((r) => !gone.has(r)) }));
  out.stars = out.stars.filter((id) => !gone.has(id));
  return out;
}
