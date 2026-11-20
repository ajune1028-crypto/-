// Writes dist/index.html: one self-contained file for the trial page.
// Modules are wrapped in dependency order inside one script; the stylesheet is inlined.
import { serverFrom } from "../src/sync/firebase.js";
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
// --share-base=URL: the address people open this build at, used for invitation links.
const shareBase = process.argv.slice(2).find((a) => a.startsWith("--share-base="))?.slice(13) || "";
if (shareBase) {
  if (!/^https:\/\/[\w.-]+\/[\w./-]*$/.test(shareBase)) throw new Error("--share-base must be a plain https address");
  swap("<title>", `<meta name="share-base" content="${shareBase}">\n<title>`);
}
// --server=URL (or HAMKKE_SERVER): the room server, a Firebase Realtime Database. With it the
// public page shares rooms between any browsers by link; without it rooms stay on each device.
const serverArg = process.argv.slice(2).find((a) => a.startsWith("--server="))?.slice(9) ?? process.env.HAMKKE_SERVER ?? "";
const server = serverArg.trim() ? serverFrom(serverArg) : null;
if (serverArg.trim() && (!server || !server.startsWith("https://"))) throw new Error("--server must be the https address of a Firebase Realtime Database, got: " + serverArg);
if (server) swap("<title>", `<meta name="hamkke-server" content="${server}">\n<title>`);
swap('<script type="module" src="./src/main.js"></script>', `<script>\n${script}\n</script>`);
// --out=PATH: write somewhere else than dist/index.html (the unit tests build into a file of their own).
const outArg = process.argv.slice(2).find((a) => a.startsWith("--out="))?.slice(6) || "";
const outFile = outArg || join(root, "dist/index.html");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html);
console.log(`${outArg || "dist/index.html"}: ${order.length} modules, ${Math.round(html.length / 1024)} KB${shareBase ? ", links point to " + shareBase : ""}${server ? ", rooms on " + server : ""}`);
