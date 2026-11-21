// Where the houses stand on the arc that rises when a room is held (the owner, 21 November: "큰 원의
// 3분의 1… 그 사용자 전자기기 화면 크기에 맞춰져서 윗부분이 우선 나오는데 거기에 내가 생성한 집이 있고,
// 가운데에 플러스… 방이 많아질수록 옆으로 공평하게"). Pure numbers, no screen: a big circle whose top
// third shows above the screen's bottom edge, its rim meeting the bottom corners (on a wide screen it
// stays no taller than about two fifths of the screen); + stands at its top, the houses beside it,
// one to the right, one to the left, and so on, the same step on both sides. When they no longer fit
// they come closer and smaller, then a second ring inside takes the rest.

const SHRINK = [1, 0.9, 0.8, 0.7, 0.62, 0.55];

/**
 * w, hgt: the screen; n: how many houses. Returns { r, cap, cx, cy, scale, spots }, spots[0] being
 * the + at the top: each { angle (0 = the top, positive to the right), ring (0 outer, 1 inner), rr
 * (its ring's radius), x, y (where its foot stands) }.
 */
export function arcGeometry(w, hgt, n, { tile = 76, gap = 10, margin = 10, low = 40 } = {}) {
  const r = Math.min(w / (2 * Math.sqrt(8 / 9)), 0.42 * hgt * 1.5);
  const cap = (2 * r) / 3;
  const cx = w / 2;
  const cy = hgt + r / 3;
  // How far round a ring a house may stand: not below `low` above the bottom, not past the sides.
  const room = (rad, s) => {
    if (rad <= 0) return 0;
    const bottom = (cy - (hgt - low)) / rad;
    const byBottom = bottom >= 1 ? 0 : Math.acos(Math.max(-1, bottom));
    const side = (w / 2 - margin - (tile * s) / 2) / rad;
    const bySide = side <= 0 ? 0 : side >= 1 ? Math.PI / 2 : Math.asin(side);
    return Math.min(byBottom, bySide);
  };
  const stepOf = (rad, s) => ((tile + gap) * s) / rad;
  let plan = null;
  for (const s of SHRINK) {
    const outer = Math.floor(room(r, s) / stepOf(r, s) + 1e-9) * 2;
    const ri = r - (tile * s + 12);
    const inner = ri > 0 ? Math.floor(room(ri, s) / stepOf(ri, s) + 1e-9) * 2 + 1 : 0;
    plan = { s, outer, ri, inner };
    if (n <= outer + inner) break;
  }
  const s = plan.s;
  const sideOf = (i) => (i % 2 === 0 ? 1 : -1) * (Math.floor(i / 2) + 1);
  const spots = [{ angle: 0, ring: 0, rr: r }];
  const onOuter = Math.min(n, plan.outer);
  const step0 = stepOf(r, s);
  for (let i = 0; i < onOuter; i++) spots.push({ angle: sideOf(i) * step0, ring: 0, rr: r });
  const rest = n - onOuter;
  if (rest > 0) {
    // The inner ring: its middle first, then both sides, squeezed if there are still more.
    const per = Math.ceil((rest - 1) / 2);
    const most = room(plan.ri, s);
    let step1 = stepOf(plan.ri, s);
    if (per > 0 && per * step1 > most) step1 = most / per;
    spots.push({ angle: 0, ring: 1, rr: plan.ri });
    for (let i = 0; i < rest - 1; i++) spots.push({ angle: sideOf(i) * step1, ring: 1, rr: plan.ri });
  }
  for (const p of spots) {
    p.x = cx + p.rr * Math.sin(p.angle);
    p.y = cy - p.rr * Math.cos(p.angle);
  }
  return { r, cap, cx, cy, scale: s, spots };
}
