// 채우기 (the paint bucket): the region a tap starts in, found on a layer's own pixels, kept as the
// rings of its edge (the outer edge and the edges of its holes) to be filled with the even-odd rule.
// As Klecks fills (MIT; read for the idea, written here): a colour is the same within a tolerance,
// and the region is grown a pixel or two so the soft edge of a line is filled under, with no pale
// fringe between the line and the colour. Kept as a shape, a fill is the same on every screen.
// Pure computation.

/**
 * The region of pixels joined to (x0, y0) that look like it: { RGBA data, w, h } → a mask (1 inside).
 * tolerance: how far (0..255) a channel may be from the tapped pixel's; on see-through paper only
 * the see-through counts. grow: pixels added all round afterwards (under the line's soft edge).
 */
export function fillMask(data, w, h, x0, y0, { tolerance = 48, grow = 1 } = {}) {
  const mask = new Uint8Array(w * h);
  x0 = Math.floor(x0);
  y0 = Math.floor(y0);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return mask;
  const s = (y0 * w + x0) * 4;
  const r0 = data[s], g0 = data[s + 1], b0 = data[s + 2], a0 = data[s + 3];
  const clear = a0 < 8;
  const same = (p) => {
    const i = p * 4;
    const a = data[i + 3];
    if (clear) return a <= tolerance;
    return Math.abs(a - a0) <= tolerance && Math.abs(data[i] - r0) <= tolerance && Math.abs(data[i + 1] - g0) <= tolerance && Math.abs(data[i + 2] - b0) <= tolerance;
  };
  // Scanline flood fill: each run is filled at once and the rows above and below are seeded.
  const stack = [y0 * w + x0];
  while (stack.length) {
    const p = stack.pop();
    if (mask[p]) continue;
    const y = Math.floor(p / w);
    let left = p - y * w;
    let right = left;
    while (left > 0 && !mask[y * w + left - 1] && same(y * w + left - 1)) left--;
    while (right < w - 1 && !mask[y * w + right + 1] && same(y * w + right + 1)) right++;
    for (let x = left; x <= right; x++) mask[y * w + x] = 1;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      let open = false;
      for (let x = left; x <= right; x++) {
        const q = ny * w + x;
        const ok = !mask[q] && same(q);
        if (ok && !open) stack.push(q);
        open = ok;
      }
    }
  }
  for (let k = 0; k < grow; k++) dilate(mask, w, h);
  return mask;
}

/** One pixel more all round (the 8 neighbours). */
function dilate(mask, w, h) {
  const was = mask.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (was[y * w + x]) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && was[yy * w + xx]) { near = true; break; }
        }
      }
      if (near) mask[y * w + x] = 1;
    }
  }
}

/**
 * The edges of a mask as closed rings of pixel corners ([x, y], with straight runs as two points).
 * Every edge between inside and outside is used once, so filled even-odd the rings are the mask.
 */
export function maskRings(mask, w, h) {
  const W = w + 1;
  const out = new Map(); // corner → corners its edges go to
  const add = (x1, y1, x2, y2) => {
    const k = y1 * W + x1;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(y2 * W + x2);
  };
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const rings = [];
  for (const start of out.keys()) {
    while (out.get(start)?.length) {
      const ring = [];
      let k = start;
      do {
        ring.push([k % W, Math.floor(k / W)]);
        const next = out.get(k);
        const n = next.pop();
        if (!next.length) out.delete(k);
        k = n;
      } while (k !== start && out.has(k));
      rings.push(straighten(ring));
    }
  }
  return rings.filter((r) => r.length >= 3);
}

/** Points in the middle of a straight run go. */
function straighten(ring) {
  const n = ring.length;
  const keep = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = ring[(i - 1 + n) % n];
    const [bx, by] = ring[i];
    const [cx, cy] = ring[(i + 1) % n];
    if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) !== 0) keep.push(ring[i]);
  }
  return keep;
}

/** Ramer–Douglas–Peucker on a closed ring: points that stray less than eps from the line go. */
export function simplifyRing(ring, eps = 0.75) {
  if (ring.length <= 4) return ring.slice();
  // Split at the point farthest from the first, simplify both halves.
  let far = 0, best = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const a = rdp(ring.slice(0, far + 1), eps);
  const b = rdp([...ring.slice(far), ring[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [x1, y1] = pts[0];
  const [x2, y2] = pts[pts.length - 1];
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  let far = 0, best = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((x2 - x1) * (y1 - pts[i][1]) - (x1 - pts[i][0]) * (y2 - y1)) / len;
    if (d > best) { best = d; far = i; }
  }
  if (best <= eps) return [pts[0], pts[pts.length - 1]];
  return [...rdp(pts.slice(0, far + 1), eps).slice(0, -1), ...rdp(pts.slice(far), eps)];
}

/** Rings into a stroke's points [x, y, p, …]: p 100 starts a ring, 0 goes on along it. */
export function ringsToPoints(rings, toUnits = (p) => p) {
  const pts = [];
  for (const ring of rings) {
    ring.forEach((p, i) => {
      const [x, y] = toUnits(p);
      pts.push(Math.round(x), Math.round(y), i === 0 ? 100 : 0);
    });
  }
  return pts;
}

/** A fill stroke's points back into rings. */
export function pointsToRings(pts) {
  const rings = [];
  for (let i = 0; i + 2 < pts.length; i += 3) {
    if (pts[i + 2] === 100 || !rings.length) rings.push([]);
    rings[rings.length - 1].push([pts[i], pts[i + 1]]);
  }
  return rings;
}
