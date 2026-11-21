// Checks on the screens' source that a scenario would only catch on the one screen it opens.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ui = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui");

/** The arguments of a call as written, split at their own commas (not those inside brackets or strings). */
function argsOf(s, from) {
  let depth = 1, j = from, q = null;
  while (j < s.length && depth) {
    const c = s[j];
    if (q) { if (c === "\\") j++; else if (c === q) q = null; }
    else if (c === '"' || c === "'" || c === "`") q = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    j++;
  }
  const body = s.slice(from, j - 1);
  const out = [];
  let cur = "", d = 0;
  q = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { cur += c; if (c === "\\") { cur += body[++i]; } else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; cur += c; continue; }
    if ("([{".includes(c)) d++;
    if (")]}".includes(c)) d--;
    if (c === "," && d === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** The text of an argument outside its brackets and strings. */
function outside(arg) {
  let flat = "", d = 0, q = null;
  for (const c of arg) {
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if ("([{".includes(c)) d++;
    if (d === 0) flat += c;
    if (")]}".includes(c)) d--;
  }
  return flat;
}

test("no screen hands replaceChildren a value that can be false or null (the browser writes it out as the word)", () => {
  const found = [];
  for (const file of readdirSync(ui).filter((f) => f.endsWith(".js"))) {
    const s = readFileSync(join(ui, file), "utf8");
    for (const m of s.matchAll(/\.replaceChildren\(/g)) {
      for (const a of argsOf(s, m.index + m[0].length)) {
        const arg = a.trim();
        if (arg.startsWith("...")) continue;
        const flat = outside(arg);
        if (flat.includes("&&") || (flat.includes("?") && /:\s*null\s*$/.test(arg))) found.push(`${file}:${s.slice(0, m.index).split("\n").length}: ${arg.slice(0, 60)}`);
      }
    }
  }
  assert.deepEqual(found, [], "use mount(), which leaves out empty values");
});
