import test from "node:test";
import assert from "node:assert/strict";
import { fitPolynomial, VelocityTracker, edgeHit, throwOf, gripThrow, VELOCITY_THRESHOLD, CLOSE_THRESHOLD } from "../src/core/fling.js";

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test("a least-squares polynomial through exact points finds them, fully confident", () => {
  const xs = [-40, -30, -20, -10, 0];
  const ys = xs.map((x) => 3 + 0.5 * x + 0.01 * x * x);
  const fit = fitPolynomial(xs, ys, xs.map(() => 1), 2);
  near(fit.coef[0], 3, 1e-9, "constant");
  near(fit.coef[1], 0.5, 1e-9, "slope");
  near(fit.coef[2], 0.01, 1e-9, "curve");
  near(fit.confidence, 1, 1e-9, "confidence");
  assert.equal(fitPolynomial([0, 1], [1, 2], [1, 1], 3), null, "too few points for the degree");
});

test("the speed at release: steady motion, a curve's end, a finger held still, an old run cut off", () => {
  const steady = new VelocityTracker();
  for (let i = 0; i <= 8; i++) steady.add(i * 8, 100 + i * 8 * 1.5, 50 - i * 8 * 0.5);
  const v = steady.velocity(64);
  near(v.vx, 1.5, 1e-6, "steady x");
  near(v.vy, -0.5, 1e-6, "steady y");

  // Speeding up: the speed now, not the average.
  const faster = new VelocityTracker();
  for (let i = 0; i <= 10; i++) { const t = i * 8; faster.add(t, 0.004 * t * t, 0); }
  near(faster.velocity(80).vx, 0.64, 1e-6, "the speed at the last moment");

  const held = new VelocityTracker();
  for (let i = 0; i <= 6; i++) held.add(i * 8, i * 10, 0);
  assert.deepEqual([held.velocity(48 + 60).vx, held.velocity(48 + 60).vy], [0, 0], "still for 60 ms: no speed");

  // A pause of more than 40 ms between samples ends the run, though it is within the last 100 ms:
  // only the motion after it counts.
  const paused = new VelocityTracker();
  for (let i = 0; i <= 2; i++) paused.add(i * 8, -i * 20, 0);
  for (let i = 0; i <= 4; i++) paused.add(60 + i * 8, 500 + i * 8 * 2, 0);
  near(paused.velocity(92).vx, 2, 1e-6, "after the pause");
});

test("a ball thrown straight on reaches the edge it really meets, even near a corner", () => {
  const W = 390;
  const H = 844;
  assert.deepEqual(pick(edgeHit(195, 422, 1, 0, W, H)), ["right", 0.5]);
  assert.deepEqual(pick(edgeHit(195, 422, 0, -1, W, H)), ["top", 0.5]);
  // From the top right corner, steeply down and to the left: it still meets the left side first...
  const steep = edgeHit(365, 90, -1, 2, W, H);
  assert.equal(steep.edge, "left");
  near(steep.at, 820 / H, 1e-9, "where on the left side");
  // ...and a little steeper, the bottom, near its left end (not the left side).
  const steeper = edgeHit(365, 90, -1, 2.2, W, H);
  assert.equal(steeper.edge, "bottom");
  near(steeper.at, (365 - (H - 90) / 2.2) / W, 1e-9, "where on the bottom");
  near(steeper.dist, Math.hypot(365 - steeper.x, H - 90), 1e-6, "how far it flew");
  // From outside the screen (a finger past the edge), it starts at the edge.
  assert.equal(edgeHit(400, 100, 1, 0, W, H).edge, "right");
  assert.equal(edgeHit(195, 422, 0, 0, W, H), null, "no direction, no edge");
});

test("a throw aims along the finger's whole path from where it went down; a short one is a tap", () => {
  const W = 390;
  const H = 844;
  assert.equal(throwOf({ x0: 360, y0: 90, x1: 352, y1: 96, vx: 0, vy: 0, w: W, h: H }), null, "a tap");
  // The path went down and to the left, then hooked to the right as the finger let go: it still
  // goes where the path pointed (the same as the light shown while aiming).
  const t = throwOf({ x0: 360, y0: 90, x1: 260, y1: 300, vx: 1.5, vy: 0.1, w: W, h: H });
  const aimed = edgeHit(360, 90, -100, 210, W, H);
  assert.equal(t.edge, aimed.edge);
  near(t.at, aimed.at, 1e-9, "the aimed spot");
  // Harder throws reach further, within bounds.
  const soft = throwOf({ x0: 360, y0: 90, x1: 330, y1: 90, vx: -0.2, vy: 0, w: W, h: H });
  const hard = throwOf({ x0: 360, y0: 90, x1: 200, y1: 90, vx: -3, vy: 0, w: W, h: H });
  assert.ok(soft.strength >= 0.12 && hard.strength <= 1 && hard.strength > soft.strength, JSON.stringify([soft.strength, hard.strength]));
});

test("the panel's grip: back toward its own edge puts it away; toward another edge sends it there; a nudge stays", () => {
  const W = 390;
  const H = 844;
  const grip = { x0: 195, y0: 140, w: W, h: H };
  // A panel out of the bottom.
  assert.equal(gripThrow({ ...grip, home: "bottom", x1: 195, y1: 300, vx: 0, vy: 1.2 }).act, "close", "down: away");
  assert.equal(gripThrow({ ...grip, home: "bottom", x1: 120, y1: 290, vx: -0.5, vy: 1 }).act, "close", "down and a little aside: still away (the ray would meet the left side)");
  assert.deepEqual(pick2(gripThrow({ ...grip, home: "bottom", x1: 60, y1: 150, vx: -1.4, vy: 0.1 })), ["move", "left"]);
  assert.deepEqual(pick2(gripThrow({ ...grip, home: "bottom", x1: 330, y1: 120, vx: 1.6, vy: -0.2 })), ["move", "right"]);
  assert.deepEqual(pick2(gripThrow({ ...grip, home: "bottom", x1: 195, y1: 40, vx: 0, vy: -1.3 })), ["move", "top"]);
  // 55° off straight down is no longer "away": it goes to the side it points at.
  const aside = (55 * Math.PI) / 180;
  assert.deepEqual(pick2(gripThrow({ ...grip, home: "bottom", x1: 195 - Math.sin(aside) * 150, y1: 140 + Math.cos(aside) * 150, vx: -1, vy: 0.7 })), ["move", "left"]);
  assert.equal(gripThrow({ ...grip, home: "bottom", x1: 200, y1: 146, vx: 0.05, vy: 0.05 }).act, "stay", "a nudge");
  assert.equal(gripThrow({ ...grip, home: "bottom", x1: 160, y1: 120, vx: 0, vy: 0 }).act, "stay", "slow and short: back where it was");
  // vaul's rules: quick enough, or a quarter of the panel's size however slowly.
  assert.deepEqual([VELOCITY_THRESHOLD, CLOSE_THRESHOLD], [0.4, 0.25]);
  const slow = (d) => gripThrow({ ...grip, home: "bottom", x1: 195, y1: 140 + d, vx: 0, vy: 0.05, size: 600 }).act;
  assert.equal(slow(140), "stay", "slow, under a quarter of 600");
  assert.equal(slow(160), "close", "slow, past a quarter of 600");
  assert.equal(gripThrow({ ...grip, home: "bottom", x1: 195, y1: 180, vx: 0, vy: 0.45, size: 600 }).act, "close", "short but quick");
  // A panel out of the right side: right puts it away, left sends it left.
  const side = { x0: 300, y0: 30, w: W, h: H, home: "right" };
  assert.equal(gripThrow({ ...side, x1: 380, y1: 34, vx: 1.4, vy: 0 }).act, "close");
  assert.deepEqual(pick2(gripThrow({ ...side, x1: 160, y1: 40, vx: -1.5, vy: 0.1 })), ["move", "left"]);
  assert.deepEqual(pick2(gripThrow({ ...side, x1: 290, y1: 260, vx: -0.1, vy: 1.6 })), ["move", "bottom"]);
  // Out of its own sector, a ray that meets its own edge goes to the nearer other edge instead.
  const odd = gripThrow({ x0: 380, y0: 700, w: W, h: H, home: "right", x1: 388, y1: 600, vx: 0.2, vy: -1.6 });
  assert.equal(odd.act, "move");
  assert.notEqual(odd.edge, "right");
});

function pick(hit) {
  return [hit.edge, Math.round(hit.at * 1000) / 1000];
}

function pick2(r) {
  return [r.act, r.edge];
}

// The owner (21 November): "스와이프하고서 그거 발사한 곳에는 우선적으로 그쪽으로 가게". From 햇살 at the
// top right, a throw to the left that rises a little met the top edge first along its line; it
// goes the way it was thrown: its larger part, left or right, up or down.
test("a throw goes the way it was thrown, even when its line meets another edge first", () => {
  const W = 390;
  const H = 844;
  const left = throwOf({ x0: 360, y0: 40, x1: 260, y1: 20, vx: -1.2, vy: -0.2, w: W, h: H });
  assert.equal(left.edge, "left");
  assert.ok(left.at >= 0 && left.at <= 0.2, "near the top of the left edge: " + left.at);
  assert.equal(throwOf({ x0: 360, y0: 40, x1: 330, y1: 140, vx: -0.3, vy: 1.1, w: W, h: H }).edge, "bottom");
  assert.equal(throwOf({ x0: 200, y0: 800, x1: 330, y1: 760, vx: 1.1, vy: -0.3, w: W, h: H }).edge, "right");
  assert.equal(throwOf({ x0: 30, y0: 400, x1: 60, y1: 300, vx: 0.2, vy: -1, w: W, h: H }).edge, "top");
});
