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
  const undo = dir === "undo";
  for (const atom of undo ? atoms.slice().reverse() : atoms) {
    if (atom.k === "ins") setShown(atom.ids, !undo);
    else if (atom.k === "del") setShown(atom.ids, undo);
    else if (atom.k === "set") ops.push({ t: "set", id: clock.next(), ch: atom.ch, v: undo ? atom.prev : atom.next });
    else if (atom.k === "mix") ops.push({ t: "mix", id: clock.next(), ch: atom.ch, lv: undo ? atom.prev : atom.next });
  }
  return ops;
}
