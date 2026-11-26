// Minimal static file server for the end-to-end runs.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const MOCKS = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "mocks");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };

export function serve(root, port) {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    // /__mock/* serves the test doubles, whichever folder is being served.
    const file = path.startsWith("/__mock/") ? join(MOCKS, path.slice(8)) : join(root, path === "/" || path === "\\" ? "index.html" : path);
    try {
      const body = await readFile(file);
      const headers = { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store", "access-control-allow-origin": "*" };
      // ?sandbox=1 serves the page the way the trial host frames it: scripts only, no forms, no own origin.
      if (new URL(req.url, "http://x").searchParams.has("sandbox")) headers["content-security-policy"] = "sandbox allow-scripts";
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
