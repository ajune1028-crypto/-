// 타임랩스 (그린 과정 보기; the reference study: Procreate's time-lapse replay, and ours shows who drew
// each line, since every stroke already knows its person and moment): the strokes of a drawing, from
// every layer, in the order they were drawn, each drawn again along its own path, one after another
// with the waits between them left out. Pure computation; ui/timelapse.js draws it.

/**
 * layers: [{ layer, strokes }] → { items: [{ stroke, layer, start, end }], total } in ms of replay.
 * A line takes time by its length (msPerUnit), between minMs and maxMs.
 */
export function replayPlan(layers, { msPerUnit = 0.45, minMs = 140, maxMs = 1400 } = {}) {
  const all = [];
  for (const { layer, strokes } of layers || []) for (const stroke of strokes) all.push({ stroke, layer });
  all.sort((a, b) => a.stroke.at - b.stroke.at || cmp(a.stroke.id, b.stroke.id));
  let t = 0;
  const items = all.map(({ stroke, layer }) => {
    const ms = Math.max(minMs, Math.min(maxMs, lengthOf(stroke.pts) * msPerUnit));
    const item = { stroke, layer, start: t, end: t + ms };
    t += ms;
    return item;
  });
  return { items, total: t };
}

// Ids are "counter@device": by counter, then device.
function cmp(a, b) {
  const [na, da] = [Number(a.slice(0, a.indexOf("@"))), a.slice(a.indexOf("@") + 1)];
  const [nb, db] = [Number(b.slice(0, b.indexOf("@"))), b.slice(b.indexOf("@") + 1)];
  return na - nb || (da < db ? -1 : da > db ? 1 : 0);
}

function lengthOf(pts) {
  let len = 0;
  for (let i = 3; i + 2 < pts.length; i += 3) len += Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2]);
  return len;
}

/**
 * The first fraction f (0..1) of a stroke's points [x, y, p, …] by length along it, the last point
 * placed between two (pressure too). whole: the stroke comes all at once (a fill, a shape made exact).
 */
export function strokePart(pts, f, { whole = false } = {}) {
  if (whole || f >= 1) return pts;
  const total = lengthOf(pts);
  const want = Math.max(0, f) * total;
  const out = [pts[0], pts[1], pts[2]];
  let run = 0;
  for (let i = 3; i + 2 < pts.length; i += 3) {
    const d = Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2]);
    if (run + d >= want) {
      if (want <= run) break;
      const k = (want - run) / d;
      out.push(Math.round(pts[i - 3] + (pts[i] - pts[i - 3]) * k), Math.round(pts[i - 2] + (pts[i + 1] - pts[i - 2]) * k), Math.round(pts[i - 1] + (pts[i + 2] - pts[i - 1]) * k));
      break;
    }
    run += d;
    out.push(pts[i], pts[i + 1], pts[i + 2]);
  }
  return out;
}
