import test from "node:test";
import assert from "node:assert/strict";
import { luminance, inkFor, gradientLine } from "../src/ui/contrast.js";

test("ink by what is behind: white on dark, black on light, a deeper black on the brightest", () => {
  assert.equal(inkFor(luminance(11, 13, 26)), "dark", "밤하늘's bottom");
  assert.equal(inkFor(luminance(255, 154, 139)), "light", "노을's middle (the owner's peach screen)");
  assert.equal(inkFor(luminance(255, 241, 230)), "bright", "복숭아's top");
  assert.ok(Math.abs(luminance(255, 255, 255) - 1) < 1e-9 && luminance(0, 0, 0) === 0);
});

test("a CSS gradient's line over a box, as canvas wants it (165deg runs down and a little right)", () => {
  const [x0, y0, x1, y1] = gradientLine(100, 200, 180);
  assert.deepEqual([x0, y0, x1, y1].map((v) => Math.round(v)), [50, 0, 50, 200], "180deg: top to bottom");
  const [a0, b0, a1, b1] = gradientLine(100, 200, 165);
  assert.ok(a1 > a0 && b1 > b0, "down and to the right");
});
