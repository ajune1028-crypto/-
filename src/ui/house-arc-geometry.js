// The small planet that rises when a room is held, with my houses built on it (the owner, 21
// November: "그 원형은 행성이야… 거기에 집이 지어진 거야", "큰 원의 3분의 1", "1번 집이 먼저 가운데에 있고
// 점점 늘어날수록 오른쪽으로", "플러스 버튼은 맨 옆에 1번 방 옆에", "행성을 스크롤하면 그 원이 돌아가면서",
// "5개 이상일 시 조금 더 작아져… 늘어남에 따라 약간 줄어듦", "큰 화면에서도 3분의 1 정도만"). Pure numbers,
// no screen.
//
// Slots go round the rim one step apart: slot 0 is +, slot k is house k. The planet's turn is an
// angle: at turn 0 house 1 stands at the top, + one step to its left, house 2 one step to its right.

const SQRT89 = Math.sqrt(8 / 9);

/** How big the houses stand: as they are up to four, a little smaller from five, again as they grow. */
export function houseScale(n) {
  if (n < 5) return 1;
  if (n < 12) return 0.8;
  if (n < 20) return 0.72;
  return 0.65;
}

/**
 * w, hgt: the screen; n: how many houses; house, gap: a house's width and the room between two
 * (px); low: room under a house's foot for its name. Returns { r, cap, cx, cy, scale, step, reach,
 * min, max, start }: the circle (a third of it shows), how far apart the slots stand, the largest
 * angle a house is seen at, and the turns that put + (min) or the last house (max) in the middle;
 * start puts house 1 there (+ when there is no house).
 */
export function planet(w, hgt, n, { house = 43, gap = 11, low = 42, margin = 8 } = {}) {
  // A phone: the rim meets the bottom corners. A big screen: no taller than about a third of the
  // screen, so the rooms stay in view and the planet is not stretched to the sides.
  const r = Math.min(w / (2 * SQRT89), 0.36 * hgt * 1.5);
  const cap = (2 * r) / 3;
  const cx = w / 2;
  const cy = hgt + r / 3;
  const scale = houseScale(n);
  const step = ((house + gap) * scale) / r;
  const byBottom = Math.acos(Math.min(1, Math.max(-1, (cy - (hgt - low)) / r)));
  // A house leans out with the ground under it: its far top corner must stay on the screen too.
  const size = house * scale;
  const reachOf = (a) => r * Math.sin(a) + size * Math.sin(a) + (size / 2) * Math.cos(a);
  let lo = 0;
  let hi = Math.PI / 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (reachOf(mid) <= w / 2 - margin) lo = mid;
    else hi = mid;
  }
  const reach = Math.min(byBottom, lo, (75 * Math.PI) / 180);
  const min = -step;
  const max = Math.max(min, (n - 1) * step);
  return { r, cap, cx, cy, scale, step, reach, min, max, start: n ? 0 : min };
}

/** Where slot `slot` stands on the rim at `turn` (0 = the top, positive to the right). */
export function slotAngle(g, slot, turn) {
  return (slot - 1) * g.step - turn;
}

/** The turn that leaves a house (or +) in the middle, nearest to `turn`, never past either end. */
export function snapTurn(g, turn) {
  const k = Math.round((turn - g.min) / g.step);
  return Math.min(g.max, Math.max(g.min, g.min + k * g.step));
}

/** The point of the rim at `angle`. */
export function spotAt(g, angle) {
  return { x: g.cx + g.r * Math.sin(angle), y: g.cy - g.r * Math.cos(angle) };
}

/** How many houses can be seen at once: the middle one and as many on each side as the rim holds. */
export function seen(g) {
  return 1 + 2 * Math.floor(g.reach / g.step + 1e-9);
}
