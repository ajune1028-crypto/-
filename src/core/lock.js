// A room with a password (the owner, 21 November: "집과 방은 주소… 들어갈 때 비밀번호도 정할 수 있게"):
// a real lock, not a screen that says no. The room's key is made from its password (PBKDF2-SHA256,
// 600,000 rounds, salted with the room's id, as Trystero makes its room keys) and every op and every
// presence of the room travels sealed with it (AES-GCM, a fresh 12-byte iv each time, as Excalidraw
// seals what its rooms send). Whoever stores or carries the room sees sealed letters only; a wrong
// password opens nothing. The password itself is never kept: this device keeps the key it made.

const ROUNDS = 600000;
const subtle = () => globalThis.crypto.subtle;

const toB64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** A password a room can have: four letters or more (any letters, spaces at the ends ignored). */
export function validRoomPassword(text) {
  return typeof text === "string" && text.trim().length >= 4 && text.trim().length <= 64;
}

/** The room's key from its password. Slow on purpose (about a second on a phone), once per device. */
export async function roomKeyFrom(password, roomId) {
  const base = await subtle().importKey("raw", new TextEncoder().encode(String(password).trim()), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode("hamkke-room:" + roomId), iterations: ROUNDS },
    base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

/** The key as text, to keep on this device (and in 나의 고유 코드's sealed bundle). */
export async function keyText(key) {
  return toB64(new Uint8Array(await subtle().exportKey("raw", key)));
}

export async function keyFromText(text) {
  return subtle().importKey("raw", fromB64(text), { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

/** A value sealed with the key: "v1." + base64 of the iv and the AES-GCM sealed JSON. */
export async function sealValue(key, value) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value))));
  const all = new Uint8Array(iv.length + data.length);
  all.set(iv);
  all.set(data, iv.length);
  return "v1." + toB64(all);
}

/** The value back, or null when this key cannot open it (another room's, a wrong password, cut short). */
export async function openValue(key, sealed) {
  try {
    if (typeof sealed !== "string" || !sealed.startsWith("v1.")) return null;
    const all = fromB64(sealed.slice(3));
    const plain = await subtle().decrypt({ name: "AES-GCM", iv: all.subarray(0, 12) }, key, all.subarray(12));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

/** An op of a locked room as it travels: { s: "v1.…" } and nothing else. */
export const isSealed = (op) => !!op && typeof op === "object" && typeof op.s === "string" && op.s.startsWith("v1.") && Object.keys(op).length === 1;
