// Two-screen scenarios in headless Chrome.
//   node tools/e2e.mjs            run against the source files
//   node tools/e2e.mjs --dist     run against the bundled single file
//   node tools/e2e.mjs name...    run only scenarios whose name contains a word
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { serve } from "./serve.mjs";
import { launch } from "./cdp.mjs";
import { scenarios } from "./scenarios.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dist = args.includes("--dist");
const only = args.filter((a) => !a.startsWith("--"));
const PORT = 8123;

const server = await serve(dist ? join(root, "dist") : root, PORT);
const browser = await launch();
let seq = 0;
let failed = 0;
const started = Date.now();

for (const { name, run } of scenarios) {
  if (only.length && !only.some((word) => name.includes(word))) continue;
  const ns = "e2e" + Date.now().toString(36) + ++seq;
  const pages = [];
  const open = async ({ dev = "a", hash = "", sandbox = false, query = "", ...view } = {}) => {
    const page = await browser.page(`http://127.0.0.1:${PORT}/index.html?ns=${ns}&dev=${dev}${sandbox ? "&sandbox=1" : ""}${query ? "&" + query : ""}${hash ? "#" + hash : ""}`, view);
    pages.push(page);
    await page.waitFor("window.__app && window.__app.booted");
    return page;
  };
  const t0 = Date.now();
  try {
    await run({ open, out: (file) => join(root, "out", file) });
    const errors = pages.flatMap((p) => p.errors);
    if (errors.length) throw new Error("page errors: " + errors.slice(0, 3).join(" | "));
    console.log(`ok   ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(err.message).split("\n").join("\n     ")}`);
  }
  await Promise.all(pages.map((p) => p.close()));
}

await browser.close();
server.close();
console.log(`${failed ? "FAILED" : "PASSED"}: ${failed} failed (${Math.round((Date.now() - started) / 100) / 10} s)`);
process.exit(failed ? 1 : 0);
