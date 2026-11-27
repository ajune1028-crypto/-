// 그리기 막대 조각 (the owner, 27 November): "그 바… 기능마다 있는거 따로 분리할 수 있게… 끝부분에꺼가 좀
// 튀어나오는데 그거 꾹 누르면… 각자거를 빼서 어디다가 눌 수도 있고 다시 조립할 수도… 분리된거는 아래에
// 조그마낫게 뭐가 튀어나오고… 90도마다… 가까이 두면 겹칠 수도". The drawing rail's parts (도구 · 색 · 크기 ·
// 빠른 굵기) are pieces in stacks: the first stack is the dock (the rail in its band at the left, upright;
// it may be left empty for pieces to come back to), the others float where they were put, each turned
// 0, 90, 180 or 270° clockwise. Like Clip Studio's palettes: pulled off, put anywhere, joined by
// bringing them near. Pure: the screen keeps it per kind of room on this device.

export const PIECES = ["tools", "color", "size", "widths"];
export const TURNS = [0, 90, 180, 270];

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5);

export function defaultLayout() {
  return { stacks: [{ pieces: [...PIECES], dock: true, x: 0, y: 0.5, turn: 0 }] };
}

const dockOf = (pieces) => ({ pieces, dock: true, x: 0, y: 0.5, turn: 0 });
const floatOf = (pieces, x, y, turn = 0) => ({ pieces, dock: false, x: clamp01(x), y: clamp01(y), turn: TURNS.includes(turn) ? turn : 0 });

/**
 * A kept layout made whole: each known piece exactly once (what was missing goes back into the dock),
 * the dock first, floats inside the screen (0..1 of it) turned by quarters, no empty float.
 */
export function wholeLayout(raw) {
  const list = Array.isArray(raw?.stacks) ? raw.stacks.filter((s) => s && typeof s === "object" && Array.isArray(s.pieces)) : null;
  if (!list) return defaultLayout();
  const seen = new Set();
  const take = (pieces) => pieces.filter((p) => PIECES.includes(p) && !seen.has(p) && seen.add(p));
  const dockRaw = list.find((s) => s.dock === true);
  const dock = dockOf(dockRaw ? take(dockRaw.pieces) : []);
  const floats = [];
  for (const s of list) {
    if (s === dockRaw) continue;
    const pieces = take(s.pieces);
    if (pieces.length) floats.push(floatOf(pieces, s.x, s.y, s.turn));
  }
  for (const p of PIECES) if (!seen.has(p)) dock.pieces.push(p);
  return { stacks: [dock, ...floats] };
}

const copy = (layout) => ({ stacks: layout.stacks.map((s) => ({ ...s, pieces: [...s.pieces] })) });

// After a change: no float left empty (the dock stays, even empty).
const tidy = (layout) => ({ stacks: layout.stacks.filter((s) => s.dock || s.pieces.length) });

/**
 * A piece taken out of its stack and put down: `to` { x, y } stands it on its own there (upright), or
 * { stack, end: "start" | "end" } joins it to that stack (by its index in `layout`) at that end.
 */
export function putPiece(layout, piece, to) {
  const l = copy(layout);
  const target = Number.isInteger(to?.stack) ? l.stacks[to.stack] : null;
  for (const s of l.stacks) s.pieces = s.pieces.filter((p) => p !== piece);
  if (target) {
    if (to.end === "start") target.pieces.unshift(piece);
    else target.pieces.push(piece);
  } else l.stacks.push(floatOf([piece], to?.x, to?.y));
  return tidy(l);
}

/**
 * A whole stack moved: `to` { x, y } puts it there (the dock's pieces leave it as one float, the dock
 * stays empty), or { stack, end } joins all its pieces to another stack at that end.
 */
export function putStack(layout, i, to) {
  const l = copy(layout);
  const from = l.stacks[i];
  if (!from) return layout;
  const target = Number.isInteger(to?.stack) && to.stack !== i ? l.stacks[to.stack] : null;
  if (target) {
    const moving = from.pieces;
    from.pieces = [];
    if (to.end === "start") target.pieces.unshift(...moving);
    else target.pieces.push(...moving);
  } else if (from.dock) {
    if (from.pieces.length) l.stacks.push(floatOf(from.pieces, to?.x, to?.y));
    from.pieces = [];
  } else {
    from.x = clamp01(to?.x);
    from.y = clamp01(to?.y);
  }
  return tidy(l);
}

/** A floating stack turned a quarter clockwise (the dock stays upright). */
export function turnStack(layout, i) {
  const l = copy(layout);
  const s = l.stacks[i];
  if (s && !s.dock) s.turn = (s.turn + 90) % 360;
  return l;
}
