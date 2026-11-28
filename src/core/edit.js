// Turns what the person did in the input box into ops, and back again for undo.

import { ROOT } from "./crdt.js";

/**
 * One splice that turns `prev` into `next`. `caret` is where the selection
 * ends after the edit; among repeated characters it decides which one changed.
 */
export function diffText(prev, next, caret) {
  const max = Math.min(prev.length, next.length);
  let index = 0;
  while (index < max && prev[index] === next[index]) index++;
  let tail = 0;
  while (tail < max - index && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const del = prev.length - index - tail;
  const insLen = next.length - index - tail;

  if (Number.isInteger(caret) && (del === 0 || insLen === 0)) {
    while (index > 0 && index + insLen > caret) {
      const leaving = insLen > 0 ? next[index + insLen - 1] : prev[index + del - 1];
      if (leaving !== prev[index - 1]) break;
      index--;
    }
  }
  return { index, del, ins: next.slice(index, index + insLen) };
}

/**
 * Ops for replacing `del` characters at `index` with `ins`.
 * `snapIds` are the ids of the characters the input box currently shows, which
 * may lag behind the sheet. Returns the ops, undo atoms and the new id list.
 */
export function spliceOps(sheet, clock, ctx, snapIds, index, del, ins, composing) {
  clock.atLeast(sheet.maxN);
  const ops = [];
  const atoms = [];

  // While composing (한글 jamo turning into a syllable) rewrite my own
  // characters in place instead of leaving a trail of deleted ones.
  let kept = composing ? Math.min(del, ins.length) : 0;
  for (let j = 0; j < kept; j++) {
    const node = sheet.get(snapIds[index + j]);
    if (!node || node.by !== ctx.by || !sheet.isVisible(node.id)) kept = 0;
  }
  for (let j = 0; j < kept; j++) {
    const node = sheet.get(snapIds[index + j]);
    if (node.v === ins[j]) continue;
    ops.push({ t: "set", id: clock.next(), ch: node.id, v: ins[j] });
    atoms.push({ k: "set", ch: node.id, prev: node.v, next: ins[j] });
  }

  const removed = [];
  for (let j = kept; j < del; j++) {
    const id = snapIds[index + j];
    if (!sheet.isVisible(id)) continue;
    ops.push({ t: "vis", id: clock.next(), ch: id, n: sheet.get(id).rm + 1 });
    removed.push(id);
  }
  if (removed.length) atoms.push({ k: "del", ids: removed });

  const added = [];
  let after = index + kept > 0 ? snapIds[index + kept - 1] : ROOT;
  for (let j = kept; j < ins.length; j++) {
    const id = clock.next();
    ops.push({ t: "ins", id, after, v: ins[j], by: ctx.by, at: ctx.now });
    added.push(id);
    after = id;
  }
  if (added.length) atoms.push({ k: "ins", ids: added });

  const ids = [...snapIds.slice(0, index + kept), ...added, ...snapIds.slice(index + del)];
  return { ops, atoms, ids };
}

/** Double tap: none → 스며들기 → 진짜 섞기 → none. */
export function mixOps(sheet, clock, anchorId) {
  clock.atLeast(sheet.maxN);
  const prev = sheet.mixLevel(anchorId);
  const next = (prev + 1) % 3;
  return {
    ops: [{ t: "mix", id: clock.next(), ch: anchorId, lv: next }],
    atoms: [{ k: "mix", ch: anchorId, prev, next }],
  };
}

/**
 * 섞기 for chosen words (the bar under them): every word whose first letter is in `anchors` goes to level
 * `lv` (0 its own colours, 1 the neighbours' seep in, 2 one mixed colour). Words already there are left
 * as they are; each atom keeps the word's own level, so undo puts every word back where it was.
 */
export function mixToOps(sheet, clock, anchors, lv) {
  clock.atLeast(sheet.maxN);
  const ops = [];
  const atoms = [];
  for (const ch of new Set(anchors)) {
    const prev = sheet.mixLevel(ch);
    if (prev === lv) continue;
    ops.push({ t: "mix", id: clock.next(), ch, lv });
    atoms.push({ k: "mix", ch, prev, next: lv });
  }
  return { ops, atoms };
}

/** Ops that undo or redo a recorded step, judged against the sheet as it is now. */
export function invertOps(sheet, clock, atoms, dir) {
  clock.atLeast(sheet.maxN);
  const ops = [];
  const counters = new Map();
  const counter = (id) => (counters.has(id) ? counters.get(id) : sheet.get(id)?.rm);
  const setShown = (ids, shown) => {
    for (const id of ids) {
      const rm = counter(id);
      if (rm === undefined || (rm % 2 === 0) === shown) continue;
      counters.set(id, rm + 1);
      ops.push({ t: "vis", id: clock.next(), ch: id, n: rm + 1 });
    }
  };
  // Photos, recordings, 표시 and 잠금 come and go by their own removes counters.
  const ranges = { att: [sheet.atts, "arm", "a"], mark: [sheet.markMap, "mrm", "m"], lock: [sheet.lockMap, "krm", "k"] };
  const showRange = (t, id, shown) => {
    const [map, type, key] = ranges[t] || [];
    const r = map?.get(id);
    if (!r) return;
    const rm = counters.has(id) ? counters.get(id) : r.rm;
    if ((rm % 2 === 0) === shown) return;
    counters.set(id, rm + 1);
    ops.push({ t: type, id: clock.next(), [key]: id, n: rm + 1 });
  };
  const undo = dir === "undo";
  for (const atom of undo ? atoms.slice().reverse() : atoms) {
    if (atom.k === "range") showRange(atom.t, atom.id, !undo);
    else if (atom.k === "unrange") showRange(atom.t, atom.id, undo);
    else if (atom.k === "ins") setShown(atom.ids, !undo);
    else if (atom.k === "del") setShown(atom.ids, undo);
    else if (atom.k === "set") ops.push({ t: "set", id: clock.next(), ch: atom.ch, v: undo ? atom.prev : atom.next });
    else if (atom.k === "mix") ops.push({ t: "mix", id: clock.next(), ch: atom.ch, lv: undo ? atom.prev : atom.next });
  }
  return ops;
}

/** Hides a photo in the words from ch to to (char ids); it sparkles there. */
export function attachOps(sheet, clock, { ch, to, data, w, h, by, at = Date.now() }) {
  clock.atLeast(sheet.maxN);
  const op = { t: "att", id: clock.next(), ch, to, kind: "photo", data, w, h, by, at };
  return { ops: [op], atoms: [{ k: "range", t: "att", id: op.id }], id: op.id };
}

/** Takes a hidden photo out of its words. */
export function detachOps(sheet, clock, attId) {
  const att = sheet.atts.get(attId);
  if (!att || att.rm % 2 === 1) return { ops: [] };
  clock.atLeast(sheet.maxN);
  return { ops: [{ t: "arm", id: clock.next(), a: attId, n: att.rm + 1 }] };
}

/** 표시 ("mark", with c) or 잠금 ("lock") on the words from ch to to. Undoable. */
export function rangeOps(sheet, clock, t, { ch, to, c, by, at = Date.now() }) {
  clock.atLeast(sheet.maxN);
  const op = { t, id: clock.next(), ch, to, by, at };
  if (t === "mark") op.c = c;
  return { ops: [op], atoms: [{ k: "range", t, id: op.id }], id: op.id };
}

/** 이 날 전체 잠그기: nobody writes, changes or removes anything on this day until it is freed. Undoable. */
export function dayLockOps(sheet, clock, { by, at = Date.now() }) {
  clock.atLeast(sheet.maxN);
  const op = { t: "lock", id: clock.next(), ch: ROOT, to: ROOT, all: true, by, at };
  return { ops: [op], atoms: [{ k: "range", t: "lock", id: op.id }], id: op.id };
}

/** Takes a 표시, a 잠금 or a hidden photo or recording ("att") off its words. Undoable. */
export function unrangeOps(sheet, clock, t, id) {
  const [map, type, key] = { att: [sheet.atts, "arm", "a"], mark: [sheet.markMap, "mrm", "m"], lock: [sheet.lockMap, "krm", "k"] }[t];
  const r = map.get(id);
  if (!r || r.rm % 2 === 1) return { ops: [], atoms: [] };
  clock.atLeast(sheet.maxN);
  return { ops: [{ t: type, id: clock.next(), [key]: id, n: r.rm + 1 }], atoms: [{ k: "unrange", t, id }] };
}

/** Hides a recording (a file of the room, dur ms long) in the words from ch to to. Undoable. */
export function attachSoundOps(sheet, clock, { ch, to, file, dur, by, at = Date.now() }) {
  clock.atLeast(sheet.maxN);
  const op = { t: "att", id: clock.next(), ch, to, kind: "sound", file, dur: Math.max(1, Math.round(dur)), by, at };
  return { ops: [op], atoms: [{ k: "range", t: "att", id: op.id }], id: op.id };
}

/**
 * 옮기기: the letters `ids` of `from` (in order) put after `after` in `to` — the same sheet or another
 * day's. Each new letter keeps who wrote it and when, so its colour stays; the 표시, photos and
 * recordings lying wholly on the moved letters, and their colour mixing, go with them. Put down
 * among the moved letters or where they already are, nothing moves. Returns
 * { from: { ops, atoms }, to: { ops, atoms }, ids } (ids: the letters at their new place); one undo
 * takes both back.
 */
export function moveTextOps(from, to, clock, { ids, after }) {
  const out = { from: { ops: [], atoms: [] }, to: { ops: [], atoms: [] }, ids: [] };
  const moving = (ids || []).filter((id) => from.isVisible(id));
  if (!moving.length || (after !== ROOT && !to.get(after))) return out;
  if (from === to && (moving.includes(after) || from.indexAfter(after) === from.indexAfter(moving[0]) - 1)) return out;
  clock.atLeast(from.maxN);
  clock.atLeast(to.maxN);
  const moved = new Map();
  let prev = after;
  for (const id of moving) {
    const node = from.get(id);
    const nid = clock.next();
    out.to.ops.push({ t: "ins", id: nid, after: prev, v: node.v, by: node.by, at: node.at });
    moved.set(id, nid);
    out.ids.push(nid);
    prev = nid;
  }
  out.to.atoms.push({ k: "ins", ids: out.ids.slice() });
  for (const id of moving) out.from.ops.push({ t: "vis", id: clock.next(), ch: id, n: from.get(id).rm + 1 });
  out.from.atoms.push({ k: "del", ids: moving.slice() });
  for (const id of moving) {
    const lv = from.mixLevel(id);
    if (lv) out.to.ops.push({ t: "mix", id: clock.next(), ch: moved.get(id), lv });
  }
  for (const [t, list, type, key] of [["mark", from.marks(), "mrm", "m"], ["att", from.attachments(), "arm", "a"]]) {
    for (const r of list) {
      if (!moved.has(r.ch) || !moved.has(r.to)) continue;
      out.from.ops.push({ t: type, id: clock.next(), [key]: r.id, n: r.rm + 1 });
      out.from.atoms.push({ k: "unrange", t, id: r.id });
      const op = { t, id: clock.next(), ch: moved.get(r.ch), to: moved.get(r.to), by: r.by, at: r.at };
      if (t === "mark") op.c = r.c;
      else if (r.kind === "photo") Object.assign(op, { kind: "photo", data: r.data, w: r.w, h: r.h });
      else Object.assign(op, { kind: "sound", file: r.file, dur: r.dur });
      out.to.ops.push(op);
      out.to.atoms.push({ k: "range", t, id: op.id });
    }
  }
  return out;
}

/**
 * Whether a change on screen touches locked words: removing any locked letter, or
 * typing between two letters of one lock. ids: the letters on screen in order;
 * index: where the change starts; del: how many letters it removes.
 */
export function lockedEdit(sheet, ids, index, del) {
  // A locked day takes no change at all, not even a letter at its end.
  if (sheet.dayLock()) return true;
  const locks = sheet.locks();
  if (!locks.length) return false;
  const at = new Map(ids.map((id, i) => [id, i]));
  for (const l of locks) {
    const a = at.get(l.ch);
    const b = at.get(l.to);
    if (a === undefined || b === undefined) continue;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    if (del > 0 ? index <= hi && index + del - 1 >= lo : index > lo && index <= hi) return true;
  }
  return false;
}
