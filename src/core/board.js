// The whiteboard: cards on a big surface, and 잇기 lines that say in which
// order the song cards play.
//
// Cards (items) are notes (text) or songs (a sound's notes and waveform,
// carried in the card, so a board plays on its own). Lines (links) join one
// card to the next; each card has at most one line out and one in, and lines
// never loop. Unjoined song cards play from the leftmost; a chain plays where
// its first card stands. Lines are numbered in playing order and coloured
// 빨주노초파남보검 in turn.
//
//   item  { id, kind, x, y, data, by, at }      note, song or photo; kept forever, hidden by irm
//   iset  { id, i, f: { x, y, w, text } }       per field, larger id wins
//   irm   { id, i, n }                          removes counter, odd = hidden
//   link  { id, a, b, by }                      a then b
//   lrm   { id, l, n }                          removes counter for a line
//   slot  { id, n, pairs, by }                  a saved order (잇기 순서 칸), latest wins
//   lasso { id, pts: [x, y, x, y…], by }        올가미: a loop; only the cards inside play
//   lamv  { id, la, x, y }                      where a loop stands (an offset), larger id wins
//   larm  { id, la, n }                         removes counter for a loop

import { cmpId, validId, Clock } from "./crdt.js";
import { SongDoc } from "./song.js";
import { fromBase64, toBase64 } from "./b64.js";
import { INK_COLORS } from "./ink.js";

/** 빨 주 노 초 파 남 보 검. */
export const ORDER_COLORS = ["#e5484d", "#f2802a", "#e8b422", "#2f9e5b", "#2f7bf0", "#3b45c4", "#9a4fd8", "#2b2b30"];
/** The same order in soft pastel. */
export const PASTEL_COLORS = ["#f4a3a6", "#f8c29a", "#f2d98a", "#9fd8b2", "#9cc4f7", "#a9b0ea", "#cfaaf0", "#9a9aa3"];
export const ITEM_KINDS = ["note", "song", "photo"];
/** A picture on the board is a small JPEG/PNG/WebP kept in the card (as a text room's hidden photo). */
export const MAX_PHOTO_CHARS = 60000;

/** The colour of order line n (1, 2, 3…): 무지개 (default), 파스텔, or one colour of the person's own. */
export function orderColor(n, style = "rainbow", mine = ORDER_COLORS[4]) {
  if (style === "mine") return mine;
  const list = style === "pastel" ? PASTEL_COLORS : ORDER_COLORS;
  return list[(n - 1) % list.length];
}
const MAX_UNKNOWN = 300;
const MAX_LOOP_POINTS = 300;
const MAX_MS = 600000;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isText = (v, max) => typeof v === "string" && v.length <= max;

const FIELD_OK = {
  x: (v) => isInt(v, -1000000, 1000000),
  y: (v) => isInt(v, -1000000, 1000000),
  w: (v) => isInt(v, 60, 2000),
  text: (v) => isText(v, 4000),
  muted: (v) => typeof v === "boolean",
  // Plain text on the board: its colour (the ink colours) and size (1 small, 2, 3 large).
  color: (v) => INK_COLORS.includes(v),
  size: (v) => v === 1 || v === 2 || v === 3,
  // Any card's colour of its own: a people colour (0-7); null: the colour of whoever placed it.
  tint: (v) => v === null || isInt(v, 0, 7),
  // A song card's notes after 음 편집 or the like; checked against the card's kind once it is known.
  data: (v) => !!v && typeof v === "object" && !Array.isArray(v),
};

/** A song card is as wide as its song is long: 60 px a second, 120 to 960. */
export function songWidth(dur) {
  return Math.min(960, Math.max(120, Math.round((dur / 1000) * 60)));
}

function validData(kind, d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return false;
  if (kind === "note") return isText(d.text, 4000);
  if (kind === "photo") {
    return typeof d.src === "string" && d.src.length <= MAX_PHOTO_CHARS && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d.src) &&
      isInt(d.w, 1, 4096) && isInt(d.h, 1, 4096);
  }
  return isInt(d.dur, 1, MAX_MS) && typeof d.peaks === "string" && d.peaks.length <= 40000 &&
    Array.isArray(d.notes) && d.notes.length <= 3000 &&
    d.notes.every((n) => Array.isArray(n) && n.length === 4 && isInt(n[0], 0, MAX_MS) && isInt(n[1], 1, MAX_MS) && isInt(n[2], 0, 127) && isInt(n[3], 0, 100)) &&
    (d.name === undefined || isText(d.name, 60)) && (d.blob === undefined || isText(d.blob, 80));
}

/** A song card's data from a sound (notes in seconds, as the analysis and the clipboard keep them). */
export function songCardData({ duration, notes, peaks, name, blob }) {
  const ms = (s) => Math.max(0, Math.round(s * 1000));
  const data = {
    dur: Math.max(1, ms(duration)), peaks: peaks || "",
    notes: notes.slice(0, 3000).map((n) => [ms(n.t), Math.max(1, ms(n.d)), Math.round(n.p), Math.round(Math.min(1, Math.max(0, n.v)) * 100)]),
  };
  if (name) data.name = String(name).slice(0, 60);
  if (blob) data.blob = blob;
  return data;
}

/**
 * A song card's data for the part of a sound a clip plays: the clipboard's
 * { source (notes in seconds), offset, length (ms) }. The recording travels
 * only when the card is the whole of it; a part plays as piano.
 */
export function cardFromClip({ source, offset, length }) {
  const lo = offset / 1000;
  const hi = (offset + length) / 1000;
  const notes = source.notes
    .map((n) => ({ ...n, s: Math.max(n.t, lo), e: Math.min(n.t + n.d, hi) }))
    .filter((n) => n.e - n.s >= 0.02)
    .map((n) => ({ t: n.s - lo, d: n.e - n.s, p: n.p, v: n.v }));
  const bytes = fromBase64(source.peaks || "");
  const peaks = toBase64(bytes.subarray(Math.floor(offset / 40), Math.ceil((offset + length) / 40)));
  const whole = offset === 0 && Math.abs(length - source.duration * 1000) < 50;
  return songCardData({ duration: length / 1000, notes, peaks, name: source.name, blob: whole ? source.blob : undefined });
}

export class BoardDoc {
  constructor() {
    this.version = 0;
    this.byId = new Map();
    this.linksById = new Map();
    this.slotsByN = new Map(); // order slot number → { id, pairs }: the latest save wins
    this.lassosById = new Map(); // 올가미 loops
    this.waiting = new Map();
    this.seen = new Set();
    this.unknown = [];
    this.maxN = 0;
    this.cache = null;
  }

  apply(op) {
    const result = this.step(op);
    if (result === "applied") this.wake(op.id);
    return result;
  }

  applyAll(ops) {
    const before = this.version;
    for (const op of ops) this.apply(op);
    return this.version !== before;
  }

  step(op) {
    if (!op || typeof op !== "object" || !validId(op.id)) return this.setAside(op);
    if (this.seen.has(op.id)) return "dup";
    switch (op.t) {
      case "item": {
        if (!ITEM_KINDS.includes(op.kind) || !FIELD_OK.x(op.x) || !FIELD_OK.y(op.y) || !validData(op.kind, op.data) || !isText(op.by, 40) || !Number.isFinite(op.at)) return this.setAside(op);
        const fields = new Map([["x", { v: op.x, at: op.id }], ["y", { v: op.y, at: op.id }], ["w", { v: op.kind === "song" ? songWidth(op.data.dur) : 200, at: op.id }], ["muted", { v: false, at: op.id }]]);
        if (op.kind === "note") fields.set("text", { v: op.data.text, at: op.id });
        this.byId.set(op.id, { id: op.id, kind: op.kind, data: op.data, by: op.by, at: op.at, fields, rm: 0 });
        return this.done(op);
      }
      case "iset": {
        const f = op.f;
        const ok = validId(op.i) && f && typeof f === "object" && Object.keys(f).length > 0 && Object.entries(f).every(([k, v]) => FIELD_OK[k] && FIELD_OK[k](v));
        if (!ok) return this.setAside(op);
        const item = this.byId.get(op.i);
        if (!item) return this.wait(op.i, op);
        if ("data" in f && (item.kind !== "song" || !validData("song", f.data))) return this.setAside(op);
        for (const [k, v] of Object.entries(f)) {
          const cur = item.fields.get(k);
          if (!cur || cmpId(op.id, cur.at) > 0) item.fields.set(k, { v, at: op.id });
        }
        return this.done(op);
      }
      case "irm":
      case "lrm":
      case "larm": {
        const target = op.t === "irm" ? op.i : op.t === "lrm" ? op.l : op.la;
        if (!validId(target) || !isInt(op.n, 1, 1e9)) return this.setAside(op);
        const thing = (op.t === "irm" ? this.byId : op.t === "lrm" ? this.linksById : this.lassosById).get(target);
        if (!thing) return this.wait(target, op);
        if (op.n > thing.rm) thing.rm = op.n;
        return this.done(op);
      }
      case "slot": {
        const ok = isInt(op.n, 1, 9) && Array.isArray(op.pairs) && op.pairs.length <= 300 && isText(op.by, 40) &&
          op.pairs.every((pair) => Array.isArray(pair) && pair.length === 2 && validId(pair[0]) && validId(pair[1]));
        if (!ok) return this.setAside(op);
        const cur = this.slotsByN.get(op.n);
        if (!cur || cmpId(op.id, cur.id) > 0) this.slotsByN.set(op.n, { id: op.id, pairs: op.pairs.map((pair) => [pair[0], pair[1]]) });
        return this.done(op);
      }
      case "lasso": {
        const ok = Array.isArray(op.pts) && op.pts.length >= 6 && op.pts.length <= MAX_LOOP_POINTS * 2 && op.pts.length % 2 === 0 &&
          op.pts.every((v) => isInt(v, -1000000, 1000000)) && isText(op.by, 40);
        if (!ok) return this.setAside(op);
        this.lassosById.set(op.id, { id: op.id, pts: op.pts.slice(), by: op.by, x: 0, y: 0, at: op.id, rm: 0 });
        return this.done(op);
      }
      case "lacl": {
        if (!validId(op.la) || !FIELD_OK.tint(op.tint)) return this.setAside(op);
        const loop = this.lassosById.get(op.la);
        if (!loop) return this.wait(op.la, op);
        if (!loop.tat || cmpId(op.id, loop.tat) > 0) Object.assign(loop, { tint: op.tint, tat: op.id });
        return this.done(op);
      }
      case "lamv": {
        if (!validId(op.la) || !FIELD_OK.x(op.x) || !FIELD_OK.y(op.y)) return this.setAside(op);
        const loop = this.lassosById.get(op.la);
        if (!loop) return this.wait(op.la, op);
        if (cmpId(op.id, loop.at) > 0) Object.assign(loop, { x: op.x, y: op.y, at: op.id });
        return this.done(op);
      }
      case "link": {
        if (!validId(op.a) || !validId(op.b) || op.a === op.b || !isText(op.by, 40)) return this.setAside(op);
        if (!this.byId.has(op.a)) return this.wait(op.a, op);
        if (!this.byId.has(op.b)) return this.wait(op.b, op);
        this.linksById.set(op.id, { id: op.id, a: op.a, b: op.b, rm: 0 });
        return this.done(op);
      }
      default:
        return this.setAside(op);
    }
  }

  done(op) {
    this.seen.add(op.id);
    this.version++;
    const n = Number(op.id.slice(0, op.id.indexOf("@")));
    if (n > this.maxN) this.maxN = n;
    return "applied";
  }

  wait(missing, op) {
    if (!this.waiting.has(missing)) this.waiting.set(missing, []);
    this.waiting.get(missing).push(op);
    return "pending";
  }

  wake(id) {
    const queue = [id];
    while (queue.length) {
      const key = queue.pop();
      const list = this.waiting.get(key);
      if (!list) continue;
      this.waiting.delete(key);
      for (const op of list) if (this.step(op) === "applied") queue.push(op.id);
    }
  }

  setAside(op) {
    if (this.unknown.length < MAX_UNKNOWN) this.unknown.push(op);
    return "unknown";
  }

  item(id) {
    const it = this.byId.get(id);
    if (!it) return null;
    const out = { id: it.id, kind: it.kind, data: it.data, by: it.by, rm: it.rm, removed: it.rm % 2 === 1 };
    for (const [k, { v }] of it.fields) out[k] = v;
    return out;
  }

  /** Saved orders, by slot number: [{ n, pairs: [[from, to], …] }]. */
  slots() {
    return [...this.slotsByN.entries()].sort((p, q) => p[0] - q[0]).map(([n, { pairs }]) => ({ n, pairs: pairs.map((pair) => [...pair]) }));
  }

  /** 올가미 loops as they stand now, oldest first: { id, pts: [x, y, x, y…], by, x, y }. */
  lassos() {
    return [...this.lassosById.values()].filter((l) => l.rm % 2 === 0).sort((p, q) => cmpId(p.id, q.id))
      .map((l) => ({ id: l.id, by: l.by, x: l.x, y: l.y, tint: l.tint ?? null, pts: l.pts.map((v, i) => v + (i % 2 ? l.y : l.x)) }));
  }

  /** Visible cards, oldest first (the order they are drawn in). */
  items() {
    return this.view().items;
  }

  /** Visible lines in playing order: { id, a, b, n (1, 2, 3…), color }. */
  links() {
    return this.view().links;
  }

  view() {
    if (this.cache && this.cache.version === this.version) return this.cache;
    const items = [...this.byId.keys()].map((id) => this.item(id)).filter((i) => !i.removed).sort((p, q) => cmpId(p.id, q.id));
    const shown = new Set(items.map((i) => i.id));
    // Lines in id order. A card may lead to several (branches) but follows one card only; a line
    // that would give a card a second card before it, or close a circle, is left out. So every
    // card has one place in the order and plays once there.
    const next = new Map(); // card → its lines out, in the order they were drawn
    const prev = new Map(); // card → the line into it
    for (const l of [...this.linksById.values()].filter((l) => l.rm % 2 === 0).sort((p, q) => cmpId(p.id, q.id))) {
      if (!shown.has(l.a) || !shown.has(l.b) || l.a === l.b || prev.has(l.b)) continue;
      let walk = l.a;
      let circle = false;
      while (prev.has(walk)) {
        walk = prev.get(walk).a;
        if (walk === l.b) { circle = true; break; }
      }
      if (circle) continue;
      if (!next.has(l.a)) next.set(l.a, []);
      next.get(l.a).push(l);
      prev.set(l.b, l);
    }
    // From each first card (left to right), each line followed to its end before the next line
    // out of the same card; lines numbered as they will play.
    const byId = new Map(items.map((i) => [i.id, i]));
    const heads = items.filter((i) => !prev.has(i.id)).sort((p, q) => p.x - q.x || cmpId(p.id, q.id));
    const order = [];
    const links = [];
    const visit = (card) => {
      order.push(card);
      for (const l of next.get(card.id) || []) {
        links.push({ id: l.id, a: l.a, b: l.b, n: links.length + 1, color: ORDER_COLORS[links.length % ORDER_COLORS.length] });
        visit(byId.get(l.b));
      }
    };
    for (const head of heads) visit(head);
    this.cache = { version: this.version, items, links, order };
    return this.cache;
  }
}

/** Song cards in the order they play. */
export function playOrder(board) {
  return board.view().order.filter((i) => i.kind === "song");
}

/** The song cards in order as one song, one after another, for the player. */
export function boardSong(board) {
  return cardsSong(playOrder(board));
}

/** Any song cards (one alone, to hear just it) as one song, back to back. */
export function cardsSong(cards) {
  const song = new SongDoc();
  const clock = new Clock("board");
  let at = 0;
  for (const card of cards) {
    const d = card.data;
    const src = { t: "src", id: clock.next(), dur: d.dur, notes: d.notes, peaks: d.peaks, by: card.by, at: 0 };
    if (d.blob) src.blob = d.blob;
    song.apply(src);
    const clip = { t: "clip", id: clock.next(), src: src.id, row: 0, start: at, offset: 0, length: d.dur, by: card.by, at: 0 };
    song.apply(clip);
    if (card.muted) song.apply({ t: "cset", id: clock.next(), c: clip.id, f: { muted: true } });
    at += d.dur;
  }
  return song;
}

// ---- ops -----------------------------------------------------------------------

export function addItemOps(clock, board, { kind, x, y, data, by, at = Date.now() }) {
  clock.atLeast(board.maxN);
  const op = { t: "item", id: clock.next(), kind, x: Math.round(x), y: Math.round(y), data, by, at };
  return { ops: [op], atoms: [{ k: "add", item: op.id }], id: op.id };
}

export function setItemOps(clock, board, itemId, fields) {
  const item = board.item(itemId);
  if (!item) return { ops: [], atoms: [] };
  clock.atLeast(board.maxN);
  const next = {};
  const prev = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!FIELD_OK[k]) continue;
    next[k] = k === "text" ? String(v).slice(0, 4000) : k === "muted" ? !!v : k === "data" || k === "color" ? v : k === "tint" ? (v === null ? null : Math.round(v)) : Math.round(v);
    prev[k] = k === "tint" ? item.tint ?? null : item[k];
  }
  return { ops: [{ t: "iset", id: clock.next(), i: itemId, f: next }], atoms: [{ k: "set", item: itemId, prev, next }] };
}

export function removeItemOps(clock, board, itemId) {
  const item = board.item(itemId);
  if (!item || item.removed) return { ops: [], atoms: [] };
  clock.atLeast(board.maxN);
  return { ops: [{ t: "irm", id: clock.next(), i: itemId, n: item.rm + 1 }], atoms: [{ k: "del", item: itemId }] };
}

/** A line from card a to card b; nothing when a already leads somewhere, b is already led to, or it would loop. */
/**
 * A line from card a to card b: b plays after a. A card may lead to several (the later line plays
 * after the earlier one's whole line); nothing when b already follows a card, or it would close a circle.
 */
export function linkOps(clock, board, a, b, by) {
  const { links } = board.view();
  if (a === b || !board.item(a) || !board.item(b) || links.some((l) => l.b === b)) return { ops: [], atoms: [] };
  const before = new Map(links.map((l) => [l.b, l.a]));
  let walk = a;
  while (before.has(walk)) {
    walk = before.get(walk);
    if (walk === b) return { ops: [], atoms: [] };
  }
  clock.atLeast(board.maxN);
  const op = { t: "link", id: clock.next(), a, b, by };
  return { ops: [op], atoms: [{ k: "ladd", link: op.id }], id: op.id };
}

export function unlinkOps(clock, board, linkId) {
  const link = board.linksById.get(linkId);
  if (!link || link.rm % 2 === 1) return { ops: [], atoms: [] };
  clock.atLeast(board.maxN);
  return { ops: [{ t: "lrm", id: clock.next(), l: linkId, n: link.rm + 1 }], atoms: [{ k: "ldel", link: linkId }] };
}

export function invertBoardOps(board, clock, atoms, dir) {
  clock.atLeast(board.maxN);
  const undo = dir === "undo";
  const ops = [];
  const counters = new Map();
  const show = (map, t, key, id, shown) => {
    const thing = map.get(id);
    if (!thing) return;
    const rm = counters.has(id) ? counters.get(id) : thing.rm;
    if ((rm % 2 === 0) === shown) return;
    counters.set(id, rm + 1);
    ops.push({ t, id: clock.next(), [key]: id, n: rm + 1 });
  };
  for (const atom of undo ? atoms.slice().reverse() : atoms) {
    if (atom.k === "add") show(board.byId, "irm", "i", atom.item, !undo);
    else if (atom.k === "del") show(board.byId, "irm", "i", atom.item, undo);
    else if (atom.k === "ladd") show(board.linksById, "lrm", "l", atom.link, !undo);
    else if (atom.k === "ldel") show(board.linksById, "lrm", "l", atom.link, undo);
    else if (atom.k === "set") ops.push({ t: "iset", id: clock.next(), i: atom.item, f: { ...(undo ? atom.prev : atom.next) } });
    else if (atom.k === "lasso-add") show(board.lassosById, "larm", "la", atom.lasso, !undo);
    else if (atom.k === "lasso-del") show(board.lassosById, "larm", "la", atom.lasso, undo);
    else if (atom.k === "lasso-tint") ops.push({ t: "lacl", id: clock.next(), la: atom.lasso, tint: undo ? atom.prev : atom.next });
    else if (atom.k === "lasso-move") {
      const [x, y] = undo ? atom.prev : atom.next;
      ops.push({ t: "lamv", id: clock.next(), la: atom.lasso, x, y });
    }
  }
  return ops;
}

// ---- 노래 모드: cutting cards, saved orders -------------------------------------------

const MIN_PART_MS = 100;

/** The part of a song card's data between from and to (ms), notes measured from from. */
function partOf(d, from, to) {
  const notes = d.notes
    .map(([t, len, p, v]) => [Math.max(t, from), Math.min(t + len, to), p, v])
    .filter(([s, e]) => e - s >= 20)
    .map(([s, e, p, v]) => [s - from, e - s, p, v]);
  const bytes = fromBase64(d.peaks || "");
  const out = { dur: to - from, peaks: toBase64(bytes.subarray(Math.floor(from / 40), Math.ceil(to / 40))), notes };
  if (d.name) out.name = d.name;
  return out;
}

/**
 * Cuts a song card at `at` ms into two cards side by side. Lines into and out of
 * it move to the halves, and the halves are joined, so the order plays on as
 * before. The recording stays with neither half (a part plays as piano).
 */
export function splitCardOps(clock, board, itemId, at, by) {
  const item = board.item(itemId);
  if (!item || item.removed || item.kind !== "song") return { ops: [], atoms: [] };
  const cut = Math.round(at);
  if (cut < MIN_PART_MS || cut > item.data.dur - MIN_PART_MS) return { ops: [], atoms: [] };
  clock.atLeast(board.maxN);
  const gone = { t: "irm", id: clock.next(), i: itemId, n: item.rm + 1 };
  const leftData = partOf(item.data, 0, cut);
  const left = { t: "item", id: clock.next(), kind: "song", x: item.x, y: item.y, data: leftData, by, at: Date.now() };
  const right = { t: "item", id: clock.next(), kind: "song", x: item.x + songWidth(leftData.dur) + 24, y: item.y, data: partOf(item.data, cut, item.data.dur), by, at: Date.now() };
  const ops = [gone, left, right];
  const atoms = [{ k: "del", item: itemId }, { k: "add", item: left.id }, { k: "add", item: right.id }];
  const lines = board.links();
  const into = lines.find((l) => l.b === itemId);
  const out = lines.find((l) => l.a === itemId);
  for (const l of [into, out]) {
    if (!l) continue;
    ops.push({ t: "lrm", id: clock.next(), l: l.id, n: board.linksById.get(l.id).rm + 1 });
    atoms.push({ k: "ldel", link: l.id });
  }
  const join = (a, b) => {
    const op = { t: "link", id: clock.next(), a, b, by };
    ops.push(op);
    atoms.push({ k: "ladd", link: op.id });
  };
  if (into) join(into.a, left.id);
  if (into || out) join(left.id, right.id);
  if (out) join(right.id, out.b);
  return { ops, atoms, ids: [left.id, right.id] };
}

/** Keeps the lines as they are now in order slot n (1 to 9). */
export function saveSlotOps(clock, board, n, by) {
  if (!isInt(n, 1, 9)) return { ops: [], atoms: [] };
  clock.atLeast(board.maxN);
  return { ops: [{ t: "slot", id: clock.next(), n, pairs: board.links().map((l) => [l.a, l.b]), by }], atoms: [] };
}

/** Brings slot n back: today's lines go, the saved ones (between cards still here) come. Undoable. */
export function useSlotOps(clock, board, n, by) {
  const saved = board.slots().find((s) => s.n === n);
  if (!saved) return { ops: [], atoms: [] };
  clock.atLeast(board.maxN);
  const ops = [];
  const atoms = [];
  for (const l of board.links()) {
    ops.push({ t: "lrm", id: clock.next(), l: l.id, n: board.linksById.get(l.id).rm + 1 });
    atoms.push({ k: "ldel", link: l.id });
  }
  for (const [a, b] of saved.pairs) {
    if (!board.item(a) || board.item(a).removed || !board.item(b) || board.item(b).removed) continue;
    const op = { t: "link", id: clock.next(), a, b, by };
    ops.push(op);
    atoms.push({ k: "ladd", link: op.id });
  }
  return { ops, atoms };
}

// ---- 올가미: a loop drawn round cards; only what is inside plays ------------------------

/** How high a song card stands on the board, for what is inside a loop (its middle counts). */
export const SONG_CARD_H = 100;

const area2 = (pts) => {
  let a = 0;
  for (let i = 0, n = pts.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1];
  }
  return a / 2;
};

/** Whether (x, y) is inside the loop: any winding counts, so a loop drawn twice round still holds. */
export function insideLoop(pts, x, y) {
  let wn = 0;
  for (let i = 0, n = pts.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    const [x1, y1, x2, y2] = [pts[2 * i], pts[2 * i + 1], pts[2 * j], pts[2 * j + 1]];
    const side = (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1);
    if (y1 <= y) { if (y2 > y && side > 0) wn++; }
    else if (y2 <= y && side < 0) wn--;
  }
  return wn !== 0;
}

/** Where segment p1-p2 crosses p3-p4 (strictly inside both), or null. */
function crossing(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (d === 0) return null;
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  return t > 0 && t < 1 && u > 0 && u < 1 ? [x1 + t * (x2 - x1), y1 + t * (y2 - y1)] : null;
}

/**
 * A stroke made into a loop the shortest way. The end need not reach the start:
 * where the stroke crosses itself, the biggest loop it makes is kept and the
 * tails go; where the end comes back close to an earlier part of the stroke, the
 * loop closes there and the lead-in goes; otherwise the end joins the start.
 * pts: [x, y, x, y…]; returns the same.
 */
export function closeLoop(pts) {
  const n = pts.length / 2;
  const P = (i) => [pts[2 * i], pts[2 * i + 1]];
  let best = null;
  for (let j = 2; j < n - 1; j++) {
    for (let i = 0; i < j - 1; i++) {
      const x = crossing(...P(i), ...P(i + 1), ...P(j), ...P(j + 1));
      if (!x) continue;
      const loop = [...x, ...pts.slice(2 * (i + 1), 2 * (j + 1))];
      const a = Math.abs(area2(loop));
      if (!best || a > best.a) best = { a, loop };
    }
  }
  if (best) return best.loop;
  // No crossing: does the end come back near an earlier part (a "6"), nearer than to the start?
  const along = [0];
  for (let i = 1; i < n; i++) along.push(along[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]));
  const total = along[n - 1];
  const xs = pts.filter((_, i) => i % 2 === 0);
  const ys = pts.filter((_, i) => i % 2 === 1);
  const near = Math.max(24, 0.12 * Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
  const [ex, ey] = P(n - 1);
  const toStart = Math.hypot(ex - pts[0], ey - pts[1]);
  let at = 0;
  let closest = toStart;
  for (let i = 1; i < n - 1; i++) {
    if (total - along[i] < 0.3 * total) break;
    const d = Math.hypot(ex - pts[2 * i], ey - pts[2 * i + 1]);
    if (d < closest) { closest = d; at = i; }
  }
  return at > 0 && closest <= near ? pts.slice(2 * at) : pts.slice();
}

/** At most MAX_LOOP_POINTS points, the start and the end kept. */
function thinLoop(pts) {
  const n = pts.length / 2;
  if (n <= MAX_LOOP_POINTS) return pts;
  const out = [];
  for (let k = 0; k < MAX_LOOP_POINTS; k++) {
    const i = Math.round((k * (n - 1)) / (MAX_LOOP_POINTS - 1));
    out.push(pts[2 * i], pts[2 * i + 1]);
  }
  return out;
}

/** A loop from a stroke (board coordinates), closed the shortest way; nothing when it is too small. */
export function lassoOps(clock, board, stroke, by) {
  if (!Array.isArray(stroke) || stroke.length < 6 || stroke.length % 2 || !stroke.every(Number.isFinite)) return { ops: [], atoms: [] };
  const pts = closeLoop(thinLoop(stroke.map((v) => Math.round(v)))).map((v) => Math.round(v));
  if (pts.length < 6 || Math.abs(area2(pts)) < 600) return { ops: [], atoms: [] };
  clock.atLeast(board.maxN);
  const op = { t: "lasso", id: clock.next(), pts, by };
  return { ops: [op], atoms: [{ k: "lasso-add", lasso: op.id }], id: op.id };
}

export function moveLassoOps(clock, board, lassoId, dx, dy) {
  const loop = board.lassosById.get(lassoId);
  if (!loop || loop.rm % 2 === 1) return { ops: [], atoms: [] };
  const next = [loop.x + Math.round(dx), loop.y + Math.round(dy)];
  if (next[0] === loop.x && next[1] === loop.y) return { ops: [], atoms: [] };
  clock.atLeast(board.maxN);
  return { ops: [{ t: "lamv", id: clock.next(), la: lassoId, x: next[0], y: next[1] }], atoms: [{ k: "lasso-move", lasso: lassoId, prev: [loop.x, loop.y], next }] };
}

/** A loop's colour (a people colour 0-7, or null for the plain one). */
export function tintLassoOps(clock, board, lassoId, tint) {
  const loop = board.lassosById.get(lassoId);
  if (!loop || loop.rm % 2 === 1 || !FIELD_OK.tint(tint)) return { ops: [], atoms: [] };
  clock.atLeast(board.maxN);
  return { ops: [{ t: "lacl", id: clock.next(), la: lassoId, tint }], atoms: [{ k: "lasso-tint", lasso: lassoId, prev: loop.tint ?? null, next: tint }] };
}

/**
 * 정리: boxes { id, x, y, w, h } laid in one row from the left (by where they stood), every top
 * at the highest one's, an even gap between. Returns where each goes: [{ id, x, y }].
 */
export function rowLayout(boxes, gap = 24) {
  const sorted = boxes.slice().sort((p, q) => p.x - q.x || p.y - q.y);
  if (!sorted.length) return [];
  const top = Math.min(...sorted.map((b) => b.y));
  let x = sorted[0].x;
  return sorted.map((b) => {
    const at = { id: b.id, x: Math.round(x), y: Math.round(top) };
    x += b.w + gap;
    return at;
  });
}

/** A loop's points round a box, its corners rounded by r (whole numbers, as a drawn loop's). */
export function boxLoop(x0, y0, x1, y1, r = 24) {
  const pts = [];
  const corner = (cx, cy, from) => {
    for (let i = 0; i <= 3; i++) {
      const a = ((from + i * 30) * Math.PI) / 180;
      pts.push(Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a)));
    }
  };
  corner(x1 - r, y0 + r, 270); // top right
  corner(x1 - r, y1 - r, 0); // bottom right
  corner(x0 + r, y1 - r, 90); // bottom left
  corner(x0 + r, y0 + r, 180); // top left
  return pts;
}

export function removeLassoOps(clock, board, lassoId) {
  const loop = board.lassosById.get(lassoId);
  if (!loop || loop.rm % 2 === 1) return { ops: [], atoms: [] };
  clock.atLeast(board.maxN);
  return { ops: [{ t: "larm", id: clock.next(), la: lassoId, n: loop.rm + 1 }], atoms: [{ k: "lasso-del", lasso: lassoId }] };
}

/** How tall a card stands, for what is inside a loop: songs by SONG_CARD_H, text by its size, photos by their shape. */
function cardHeight(item) {
  if (item.kind === "song") return SONG_CARD_H;
  if (item.kind === "photo") return Math.round((item.w * item.data.h) / item.data.w) + 10;
  return 28 + 10 * (item.size || 2);
}

/** Every card inside a loop (by its middle), of any kind, oldest first. */
export function itemsInLoop(board, lassoId) {
  const loop = board.lassos().find((l) => l.id === lassoId);
  if (!loop) return [];
  return board.items().filter((item) => insideLoop(loop.pts, item.x + item.w / 2, item.y + cardHeight(item) / 2));
}

/** The song cards inside a loop (their middles), in the order they play: lines first, then from the left. */
export function lassoOrder(board, lassoId) {
  const loop = board.lassos().find((l) => l.id === lassoId);
  if (!loop) return [];
  return playOrder(board).filter((card) => insideLoop(loop.pts, card.x + card.w / 2, card.y + SONG_CARD_H / 2));
}
