import test from "node:test";
import assert from "node:assert/strict";
import { exampleTake, EXAMPLE_MELODY } from "../src/audio/example.js";
import { analyzeSamples } from "../src/audio/analyze.js";

test("the example take is read back as the melody it sings (도레미파솔미도), in time", async () => {
  const rate = 24000;
  const samples = exampleTake(rate);
  const result = await analyzeSamples(samples, rate);
  assert.deepEqual(result.notes.map((n) => n.p), EXAMPLE_MELODY.map(([m]) => m), "every note found, in order");
  for (const [i, n] of result.notes.entries()) assert.ok(Math.abs(n.d - EXAMPLE_MELODY[i][1]) < 0.08, `note ${i} lasts ${n.d.toFixed(3)} s`);
  assert.ok(result.duration > 4 && result.duration < 4.6, "about four seconds long: " + result.duration);
});
