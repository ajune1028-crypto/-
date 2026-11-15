// Notes for a take in which more than one thing sounds at once: the tune (the leading line) and
// the harmony under or over it (화음). The owner: "다른 음이 있다면 화음으로 쌓는 구조고 화음을
// 버릴 수도 있고 변경 가능하며" - harmony notes carry `h: true`, so they can be left out or edited.
// Pure computation.

import { HOP_SECONDS } from "./pitch.js";
import { midiToHz, notePieces, pieceCentre, pieceNote, tuningOffset } from "./notes.js";
import { followLines, leadOf, worthKeeping } from "./lines.js";

const MIN_HARMONY_SECONDS = 0.14; // a harmony note shorter than this is not worth a key
const MAX_TOGETHER = 4; // the tune and at most three more at once
const SAME_NOTE_OVERLAP = 0.5;

/**
 * Notes from the frames of `trackPitches`: [{ t, d, p, v, h? }], by start time. `h` marks a note
 * of the harmony. Also `lines` and `harmony` (how much of the sung time has harmony under it),
 * for telling a solo take from a mix.
 */
export function chordNotes(frames) {
  const { lines, loud } = followLines(frames);
  const { lead, share } = leadOf(lines, frames.length);
  const kept = [];
  lines.forEach((line, i) => { if (worthKeeping(line, share[i])) kept.push({ line, i }); });
  // Each line cut into notes as a sung line is: where its pitch moves and stays, where it dips.
  const parts = [];
  for (const { line, i } of kept) {
    const pseudo = line.key.map((key, k) => ({ hz: midiToHz(key), conf: 1, rms: line.a[k], level: line.a[k] }));
    const { pieces } = notePieces(pseudo);
    for (const piece of pieces) {
      let leading = 0;
      for (let k = piece.first; k <= piece.last; k++) if (lead[line.first + k] === i) leading++;
      parts.push({ piece, pseudo, first: line.first, tune: leading / (piece.last - piece.first + 1) >= 0.5 });
    }
  }
  // One tuning for the whole take, read from the tune's notes (the harmony follows it).
  const tuneParts = parts.filter((p) => p.tune);
  const offset = tuningOffset((tuneParts.length >= 3 ? tuneParts : parts).map((p) => pieceCentre(p.piece)));
  let notes = parts.map((p) => {
    const note = pieceNote(p.piece, p.pseudo, { first: p.first, loud: loud || 1, tune: offset });
    if (!p.tune) note.h = true;
    return note;
  });
  // Harmony worth a key: long enough, and not the tune's own note again.
  notes = notes.filter((n) => {
    if (!n.h) return true;
    if (n.d < MIN_HARMONY_SECONDS) return false;
    return !notes.some((m) => !m.h && m.p === n.p && overlap(m, n) >= SAME_NOTE_OVERLAP * n.d);
  });
  notes.sort((a, b) => a.t - b.t || a.p - b.p);
  notes = capTogether(notes);
  let tuneTime = 0;
  let harmonyTime = 0;
  for (const n of notes) {
    if (n.h) harmonyTime += n.d;
    else tuneTime += n.d;
  }
  return { notes, lines, harmony: tuneTime > 0 ? harmonyTime / tuneTime : 0 };
}

const overlap = (a, b) => Math.max(0, Math.min(a.t + a.d, b.t + b.d) - Math.max(a.t, b.t));

/** No more than MAX_TOGETHER notes at once: the quietest harmony notes give way. */
function capTogether(notes) {
  const out = new Set();
  const harmony = notes.filter((n) => n.h).sort((a, b) => a.v - b.v);
  for (const n of harmony) {
    // How many sound with it at its busiest moment?
    let busiest = 0;
    for (let t = n.t; t < n.t + n.d; t += HOP_SECONDS * 2) {
      let c = 0;
      for (const m of notes) if (!out.has(m) && m.t <= t && t < m.t + m.d) c++;
      if (c > busiest) busiest = c;
    }
    if (busiest > MAX_TOGETHER) out.add(n);
  }
  return notes.filter((n) => !out.has(n));
}
