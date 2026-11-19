// A line being drawn, sent to friends in small overlapping pieces as it grows (ui/live-ink.js), so
// their screens show it while it is drawn, as Excalidraw and Figma do. Presence keeps only each
// screen's latest message, so a piece can be skipped: each piece says how many points the line
// has (n) and carries its last points (t), and the friend's copy fills in from there. A skipped
// stretch becomes a straight jump on the friend's screen until the finished line arrives as an
// op and takes the live one's place.

export const LIVE_TAIL = 80;

/** The piece to send for a line with these points: { n, t }. */
export function liveTail(pts, max = LIVE_TAIL) {
  const n = Math.floor(pts.length / 3);
  return { n, t: pts.slice(Math.max(0, n - max) * 3, n * 3) };
}

/**
 * The friend's copy of a line after a piece came. state: { pts, skip } (skip: points of the
 * sender's line that never came, jumped over). Older or repeated pieces change nothing.
 */
export function mergeLive(state, piece) {
  const have = state?.pts || [];
  const skip = state?.skip || 0;
  const n = piece?.n | 0;
  const t = Array.isArray(piece?.t) ? piece.t : [];
  const k = Math.floor(t.length / 3);
  const known = have.length / 3 + skip;
  const start = n - k;
  if (n <= known) return state || { pts: have, skip };
  if (start <= known) {
    const at = Math.max(0, start - skip);
    const from = Math.max(0, skip - start);
    return { pts: [...have.slice(0, at * 3), ...t.slice(from * 3, k * 3)], skip };
  }
  return { pts: [...have, ...t.slice(0, k * 3)], skip: skip + (start - known) };
}
