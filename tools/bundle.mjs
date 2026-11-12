// Writes dist/index.html: one self-contained file for the trial page.
// Modules are wrapped in dependency order inside one script; the stylesheet is inlined.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, posix } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = new Map();
const order = [];

function load(path, from) {
  if (built.has(path)) {
    if (built.get(path) === null) throw new Error(`circular import: ${from} → ${path}`);
    return;
  }
  built.set(path, null);
  let src = readFileSync(join(root, path), "utf8");
  const deps = [];
  src = src.replace(/^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?[ \t]*$/gm, (_, names, spec) => {
    const dep = posix.normalize(posix.join(posix.dirname(path), spec));
    deps.push(dep);
    const list = names.split(",").map((n) => n.trim()).filter(Boolean)
      .map((n) => { const m = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(n); return m ? `${m[1]}: ${m[2]}` : n; });
    return `const { ${list.join(", ")} } = __m[${JSON.stringify(dep)}];`;
  });
  if (/^\s*import[\s{*"']/m.test(src)) throw new Error("unsupported import form in " + path);
  const names = [];
  src = src.replace(/^export\s+(async\s+function\*?|function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, name) => {
    names.push(name);
    return `${kind} ${name}`;
  });
  if (/^\s*export\s/m.test(src)) throw new Error("unsupported export form in " + path);
  for (const dep of deps) load(dep, path);
  order.push(path);
  built.set(path, `__m[${JSON.stringify(path)}] = (() => {\n${src}\nreturn { ${names.join(", ")} };\n})();`);
}

load("src/main.js", "(entry)");
const script = `"use strict";\n(() => {\nconst __m = {};\n${order.map((p) => built.get(p)).join("\n")}\n})();`;
if (/<\/script/i.test(script)) throw new Error("the bundle contains a closing script tag");
const css = readFileSync(join(root, "src/ui/theme.css"), "utf8");
if (/<\/style/i.test(css)) throw new Error("the stylesheet contains a closing style tag");

let html = readFileSync(join(root, "index.html"), "utf8");
const swap = (needle, replacement) => {
  if (!html.includes(needle)) throw new Error("index.html no longer contains: " + needle);
  html = html.replace(needle, () => replacement);
};
swap('<link rel="stylesheet" href="./src/ui/theme.css">', `<style>\n${css}</style>`);
swap('<script type="module" src="./src/main.js"></script>', `<script>\n${script}\n</script>`);
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist/index.html"), html);
console.log(`dist/index.html: ${order.length} modules, ${Math.round(html.length / 1024)} KB`);
