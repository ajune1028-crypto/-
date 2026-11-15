// What home shows of a room at a glance (the UI review's 홈 미리보기, which the owner chose): the
// last line written, the song's notes as small bars, the board as a tiny map of its cards. It is
// worked out when one leaves the room and kept with the room on this device; a few hundred bytes.

import { clipSpan } from "./song.js";
import { songWidth } from "./board.js";

const MAX_LINE = 60;
const SHOWN_MS = 24000; // a long song shows how it begins
const MAX_NOTES = 48;
const MAX_CLIPS = 24;
const MAX_CARDS = 24;
const MAP_W = 100;
const MAP_H = 60;
const MAP_SCALE = 0.15; // one card is never drawn bigger than this share of its board size

/** The last line written on the latest sheet that has words. `texts`: the sheets, oldest first. */
export function textPreview(texts) {
  for (let i = texts.length - 1; i >= 0; i--) {
    const lines = String(texts[i] || "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const line = lines[lines.length - 1];
    return { t: "text", line: line.length > MAX_LINE ? line.slice(0, MAX_LINE - 1) + "…" : line };
  }
  return null;
}

/**
 * The song's notes as bars, [x, width, y]: x and width in thousandths of the part shown (the
 * first 24 seconds at most), y from 0 (the highest note) to 100 (the lowest). Muted clips sound
 * no notes. `clips` gives every clip as [x, width, row], for a song with few or no notes.
 */
export function songPreview(song) {
  const end = song.end();
  if (!end) return null;
  const shown = Math.min(end, SHOWN_MS);
  const at = (ms) => Math.max(0, Math.min(1000, Math.round((ms / shown) * 1000)));
  const span = (x, ms) => Math.max(1, Math.min(1000 - x, Math.round((ms / shown) * 1000)));
  const events = song.noteEvents(0, shown).slice(0, MAX_NOTES);
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of events) { lo = Math.min(lo, e.p); hi = Math.max(hi, e.p); }
  const notes = events.map((e) => {
    const x = at(e.at);
    return [x, span(x, e.d), hi === lo ? 50 : Math.round(((hi - e.p) / (hi - lo)) * 100)];
  });
  const clips = song.layout().filter((c) => c.start < shown).slice(0, MAX_CLIPS).map((c) => {
    const x = at(c.start);
    return [x, span(x, clipSpan(c)), c.lane];
  });
  return { t: "song", notes, clips };
}

/** About how big a card stands on the board (the screen knows exactly; this is for a tiny map). */
function cardSize(item) {
  const d = item.data || {};
  if (item.kind === "song") return [item.w || songWidth(d.dur || 1000), 64];
  if (item.kind === "photo") {
    const w = item.w || 200;
    return [w, Math.round((w * (d.h || 3)) / (d.w || 4))];
  }
  const text = String(item.text ?? d.text ?? "");
  const lines = Math.min(6, Math.max(1, text.split("\n").length));
  const longest = Math.max(...text.split("\n").map((l) => l.length), 1);
  return [item.w || Math.min(260, Math.max(60, longest * 14 + 24)), 36 * lines];
}

/** The board's cards as a small map, [x, y, width, height, kind (s song, n words, p photo)], within 100 × 60. */
export function boardPreview(board) {
  const items = board.items().slice(0, MAX_CARDS);
  if (!items.length) return null;
  const boxes = items.map((it) => {
    const [w, h] = cardSize(it);
    return { x: it.x || 0, y: it.y || 0, w, h, k: it.kind === "song" ? "s" : it.kind === "photo" ? "p" : "n" };
  });
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  const scale = Math.min(MAP_W / Math.max(1, x1 - x0), MAP_H / Math.max(1, y1 - y0), MAP_SCALE);
  // What is smaller than the map sits in its middle.
  const ox = Math.max(0, (MAP_W - (x1 - x0) * scale) / 2);
  const oy = Math.max(0, (MAP_H - (y1 - y0) * scale) / 2);
  const cards = boxes.map((b) => {
    const w = Math.max(2, Math.min(MAP_W, Math.round(b.w * scale)));
    const h = Math.max(2, Math.min(MAP_H, Math.round(b.h * scale)));
    return [Math.min(MAP_W - w, Math.round(ox + (b.x - x0) * scale)), Math.min(MAP_H - h, Math.round(oy + (b.y - y0) * scale)), w, h, b.k];
  });
  return { t: "board", cards };
}

const nums = (a, n) => Array.isArray(a) && a.length === n && a.every((v) => Number.isFinite(v));

/** True for a preview home may draw (what is kept on the device is read back with care). */
export function validPreview(p) {
  if (!p || typeof p !== "object") return false;
  if (p.t === "text") return typeof p.line === "string" && p.line.length <= 80;
  if (p.t === "song") {
    return Array.isArray(p.notes) && p.notes.length <= 64 && p.notes.every((n) => nums(n, 3)) &&
      (p.clips === undefined || (Array.isArray(p.clips) && p.clips.length <= 32 && p.clips.every((c) => nums(c, 3))));
  }
  if (p.t === "board") {
    return Array.isArray(p.cards) && p.cards.length <= 32 &&
      p.cards.every((c) => Array.isArray(c) && c.length === 5 && nums(c.slice(0, 4), 4) && ["s", "n", "p"].includes(c[4]));
  }
  return false;
}
