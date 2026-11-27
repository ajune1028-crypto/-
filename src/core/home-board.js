// 홈 '보드' 보기 (the owner, 27 November: "방을 내가 원하는 그거로 해 놓고 내가 원하는 위치에 넣을 수 있게… 크기를
// 많이 줄이면 제목은 아래에 나오고 아이콘"): where each room stands on a half's board and how big it is, in
// cells of a grid `cols` wide. A room stays where it was put, gaps and all (no pulling everything up as
// a phone's home screen does); one put on others takes its place and they go down below it. The rule
// of pushing what is in the way down comes from react-grid-layout (MIT), written anew for this app.

/** A card's size when a room has no spot yet. */
export const CARD = { w: 3, h: 2 };
/** The tallest a room may be, in rows. */
export const MAX_ROWS = 4;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Whether two spots share a cell. */
export function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** A spot brought inside a board `cols` wide (at least one cell, at most the columns and MAX_ROWS). */
function inside({ x, y, w, h }, cols) {
  const ww = clamp(Math.round(w) || 1, 1, cols);
  const hh = clamp(Math.round(h) || 1, 1, MAX_ROWS);
  return { x: clamp(Math.round(x) || 0, 0, cols - ww), y: Math.max(0, Math.round(y) || 0), w: ww, h: hh };
}

/**
 * The spots, the `first` one where it is and every other in reading order going down until it lies on
 * nothing placed before it: what was in the way moves just as far as it must.
 */
function settle(list, first = null) {
  const order = list.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const at = first ? order.findIndex((s) => s.id === first) : -1;
  if (at > 0) order.unshift(...order.splice(at, 1));
  const placed = [];
  for (const s of order) {
    const spot = { ...s };
    while (placed.some((p) => overlaps(spot, p))) spot.y++;
    placed.push(spot);
  }
  return new Map(placed.map((s) => [s.id, { x: s.x, y: s.y, w: s.w, h: s.h }]));
}

/** The first free place for a spot of w × h, row by row, left to right. */
function freePlace(taken, w, h, cols) {
  for (let y = 0; ; y++) {
    for (let x = 0; x + w <= cols; x++) {
      const spot = { x, y, w, h };
      if (!taken.some((t) => overlaps(spot, t))) return spot;
    }
  }
}

/**
 * The board for these rooms (`ids` in the order they come on the half): kept spots (`saved`, id →
 * [x, y, w, h]) where they were put, brought inside the board and off one another; the others into
 * the first free places in turn, a card's size each. Returns a Map id → { x, y, w, h }.
 */
export function boardLayout(ids, saved, cols, card = CARD) {
  const keep = [];
  for (const id of ids) {
    const s = saved?.[id];
    if (Array.isArray(s) && s.length === 4 && s.every(Number.isFinite)) keep.push({ id, ...inside({ x: s[0], y: s[1], w: s[2], h: s[3] }, cols) });
  }
  const layout = settle(keep);
  const taken = [...layout.values()];
  for (const id of ids) {
    if (layout.has(id)) continue;
    const spot = freePlace(taken, Math.min(card.w, cols), card.h, cols);
    layout.set(id, spot);
    taken.push(spot);
  }
  return layout;
}

/** The room `id` moved to (x, y): it takes the spot, and what it lands on goes down below it. */
export function moveSpot(layout, id, x, y, cols) {
  const s = layout.get(id);
  if (!s) return layout;
  const list = [...layout].map(([k, v]) => ({ id: k, ...v }));
  const me = list.find((v) => v.id === id);
  Object.assign(me, inside({ ...s, x, y }, cols));
  return settle(list, id);
}

/** The room `id` made w × h from its top left corner (one cell to the columns left, four rows at most). */
export function sizeSpot(layout, id, w, h, cols) {
  const s = layout.get(id);
  if (!s) return layout;
  const list = [...layout].map(([k, v]) => ({ id: k, ...v }));
  const me = list.find((v) => v.id === id);
  Object.assign(me, { w: clamp(Math.round(w) || 1, 1, cols - s.x), h: clamp(Math.round(h) || 1, 1, MAX_ROWS) });
  return settle(list, id);
}

/** What a room of this size looks like: "icon" (one column: its logo, the name below), "line" (one row), else "card". */
export function tileLook({ w, h }) {
  if (w <= 1) return "icon";
  if (h <= 1) return "line";
  return "card";
}

/** The spots as they are kept: id → [x, y, w, h]. */
export function keptSpots(layout) {
  return Object.fromEntries([...layout].map(([id, s]) => [id, [s.x, s.y, s.w, s.h]]));
}
