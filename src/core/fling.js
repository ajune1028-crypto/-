// Throwing things toward the screen's edges: home's ⋮ (thrown, the panel comes out where it lands)
// and that panel's grip (thrown, the panel goes to another edge or away).
//
// The owner (20 November): "대각선에 보냈을 때 인식이 매우 애매하고… 나는 끝자락에 보냈는데 옆으로 간다".
// So a throw is judged the way a ball flies: along the finger's whole path from where it went down
// (a hook as the finger lets go does not turn it), straight on to the edge it really meets first,
// corners included. The same ray lights the edge while aiming, so what lands is what was shown.
//
// fitPolynomial and VelocityTracker follow Flutter's LeastSquaresSolver and VelocityTracker
// (BSD-3-Clause, Copyright 2014 The Flutter Authors; see THIRD_PARTY.md): the speed at release is
// the slope, now, of a least-squares quadratic through the last 100 ms of positions (at most 20);
// a gap of more than 40 ms between them ends the run, and a finger still for 40 ms has no speed.

const HISTORY = 20;
const HORIZON = 100;
const STOPPED = 40;
const MIN_SAMPLES = 3;
const TOLERANCE = 1e-10;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Weighted least squares: the polynomial of `degree` through (x, y), its coefficients lowest first. */
export function fitPolynomial(x, y, w, degree) {
  const m = x.length;
  const n = degree + 1;
  if (degree > m) return null;
  const dot = (u, v) => {
    let s = 0;
    for (let k = 0; k < m; k++) s += u[k] * v[k];
    return s;
  };
  // The x values grown into rows of powers, weighted.
  const a = Array.from({ length: n }, () => new Float64Array(m));
  for (let k = 0; k < m; k++) {
    a[0][k] = w[k];
    for (let i = 1; i < n; i++) a[i][k] = a[i - 1][k] * x[k];
  }
  // Gram-Schmidt: a = q r, q orthonormal (by rows here), r upper triangular.
  const q = Array.from({ length: n }, () => new Float64Array(m));
  const r = Array.from({ length: n }, () => new Float64Array(n));
  for (let j = 0; j < n; j++) {
    q[j].set(a[j]);
    for (let i = 0; i < j; i++) {
      const d = dot(q[j], q[i]);
      for (let k = 0; k < m; k++) q[j][k] -= d * q[i][k];
    }
    const norm = Math.sqrt(dot(q[j], q[j]));
    if (norm < TOLERANCE) return null; // dependent or zero: no answer
    for (let k = 0; k < m; k++) q[j][k] /= norm;
    for (let i = 0; i < n; i++) r[j][i] = i < j ? 0 : dot(q[j], a[i]);
  }
  // r b = qᵀ w y, from the bottom up.
  const wy = new Float64Array(m);
  for (let k = 0; k < m; k++) wy[k] = y[k] * w[k];
  const coef = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    coef[i] = dot(q[i], wy);
    for (let j = n - 1; j > i; j--) coef[i] -= r[i][j] * coef[j];
    coef[i] /= r[i][i];
  }
  // How well it fits: 1 − (squared error / squared spread), weighted.
  let mean = 0;
  for (let k = 0; k < m; k++) mean += y[k];
  mean /= m;
  let error = 0;
  let total = 0;
  for (let k = 0; k < m; k++) {
    let term = 1;
    let err = y[k] - coef[0];
    for (let i = 1; i < n; i++) {
      term *= x[k];
      err -= term * coef[i];
    }
    error += w[k] * w[k] * err * err;
    const v = y[k] - mean;
    total += w[k] * w[k] * v * v;
  }
  return { coef, confidence: total <= TOLERANCE ? 1 : 1 - error / total };
}

/** Where a finger has been, to tell how fast it was going when it let go (px per ms). */
export class VelocityTracker {
  constructor() {
    this.samples = [];
  }

  add(t, x, y) {
    this.samples.push({ t, x, y });
    if (this.samples.length > HISTORY) this.samples.shift();
  }

  velocity(now = this.samples.at(-1)?.t) {
    const newest = this.samples.at(-1);
    const none = { vx: 0, vy: 0, confidence: 1 };
    if (!newest || now - newest.t > STOPPED) return none;
    const ts = [];
    const xs = [];
    const ys = [];
    let previous = newest;
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const s = this.samples[i];
      const age = newest.t - s.t;
      const gap = Math.abs(s.t - previous.t);
      previous = s;
      if (age > HORIZON || gap > STOPPED) break;
      ts.push(-age);
      xs.push(s.x);
      ys.push(s.y);
    }
    if (ts.length < MIN_SAMPLES) return none;
    const ones = ts.map(() => 1);
    const fx = fitPolynomial(ts, xs, ones, 2);
    const fy = fx && fitPolynomial(ts, ys, ones, 2);
    if (!fx || !fy) return none;
    return { vx: fx.coef[1], vy: fy.coef[1], confidence: fx.confidence * fy.confidence };
  }
}

/**
 * Where a ball from (x, y) flying (dx, dy) first meets the edge of a w × h screen: the edge, how
 * far along it (0..1, left to right or top to bottom), the point, and how far it flew.
 */
export function edgeHit(x, y, dx, dy, w, h) {
  const len = Math.hypot(dx, dy);
  if (!len) return null;
  const ux = dx / len;
  const uy = dy / len;
  const sx = clamp(x, 0, w);
  const sy = clamp(y, 0, h);
  let best = null;
  const meet = (edge, t) => { if (t >= 0 && (!best || t < best.t)) best = { edge, t }; };
  if (ux > 1e-9) meet("right", (w - sx) / ux);
  if (ux < -1e-9) meet("left", -sx / ux);
  if (uy > 1e-9) meet("bottom", (h - sy) / uy);
  if (uy < -1e-9) meet("top", -sy / uy);
  if (!best) return null;
  const px = sx + ux * best.t;
  const py = sy + uy * best.t;
  const along = best.edge === "left" || best.edge === "right" ? py / h : px / w;
  return { edge: best.edge, at: clamp(along, 0, 1), x: px, y: py, dist: best.t };
}

const strengthOf = (speed, d) => clamp(speed / 2.4 + d / 900, 0.12, 1);

/**
 * A throw from where the finger went down (x0, y0) to where it let go (x1, y1), going (vx, vy) px
 * per ms then: where it lands and how hard ({ edge, at, x, y, dist, speed, strength }), or null
 * for a tap.
 */
export function throwOf({ x0, y0, x1, y1, vx = 0, vy = 0, w, h, tap = 14 }) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  if (d < tap) return null;
  // The way it was thrown decides the edge (the owner, 21 November: "발사한 곳에는 우선적으로 그쪽으로"):
  // its larger part, left or right, up or down. From a corner its line can meet another edge first
  // (a throw to the left that rises a little, from the top right, met the top); where along the
  // edge is where that line crosses the edge's own line, kept on the edge.
  const edge = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "top" : "bottom";
  const sx = clamp(x0, 0, w);
  const sy = clamp(y0, 0, h);
  const t = edge === "left" ? -sx / dx : edge === "right" ? (w - sx) / dx : edge === "top" ? -sy / dy : (h - sy) / dy;
  const x = edge === "left" ? 0 : edge === "right" ? w : clamp(sx + dx * t, 0, w);
  const y = edge === "top" ? 0 : edge === "bottom" ? h : clamp(sy + dy * t, 0, h);
  const at = edge === "left" || edge === "right" ? y / h : x / w;
  const speed = Math.hypot(vx, vy);
  return { edge, at: clamp(at, 0, 1), x, y, dist: Math.hypot(x - sx, y - sy), speed, strength: strengthOf(speed, d) };
}

const OUTWARD = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
const AWAY = Math.cos((40 * Math.PI) / 180);
/** From vaul (Emil Kowalski, MIT License; THIRD_PARTY.md): a flick faster than this (px per ms) counts… */
export const VELOCITY_THRESHOLD = 0.4;
/** …and so does a drag of a quarter of the panel's size, however slow. */
export const CLOSE_THRESHOLD = 0.25;

/**
 * The grip of a panel that came out of edge `home`, let go. As vaul decides a drawer's swipe, the
 * throw counts when it was quick (VELOCITY_THRESHOLD) or went a quarter of the panel's `size`
 * (CLOSE_THRESHOLD); otherwise the panel goes back where it was: { act: "stay" }. Back toward its
 * own edge (within 40° of straight at it): { act: "close" }. Toward another edge: { act: "move",
 * edge, at, strength }, to the edge the ray meets, never its own (thrown aside, a ray that still
 * meets its own edge goes to the other edge the throw points at most).
 */
export function gripThrow({ x0, y0, x1, y1, vx = 0, vy = 0, w, h, home, size = 300 }) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  const speed = Math.hypot(vx, vy);
  if (d < 10 || (speed <= VELOCITY_THRESHOLD && d < size * CLOSE_THRESHOLD)) return { act: "stay" };
  const [hx, hy] = OUTWARD[home] || OUTWARD.bottom;
  if ((dx * hx + dy * hy) / d >= AWAY) return { act: "close" };
  const strength = strengthOf(speed, d);
  const hit = edgeHit(x0, y0, dx, dy, w, h);
  if (hit && hit.edge !== home) return { act: "move", edge: hit.edge, at: hit.at, strength };
  let edge = null;
  let most = -Infinity;
  for (const [name, [ex, ey]] of Object.entries(OUTWARD)) {
    if (name === home) continue;
    const s = (dx * ex + dy * ey) / d;
    if (s > most) { most = s; edge = name; }
  }
  // Where the ray would cross that edge's line, kept on the edge.
  const across = edge === "left" || edge === "right";
  const t = across ? ((edge === "right" ? w : 0) - x0) / (dx || 1e-9) : ((edge === "bottom" ? h : 0) - y0) / (dy || 1e-9);
  const at = across ? (y0 + dy * Math.max(0, t)) / h : (x0 + dx * Math.max(0, t)) / w;
  return { act: "move", edge, at: clamp(at, 0, 1), strength };
}
