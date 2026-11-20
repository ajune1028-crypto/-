import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cdp from "../tools/cdp.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("CHROME_BIN is tried before any built-in guess", () => {
  const list = cdp.chromeCandidates({ platform: "linux", env: { CHROME_BIN: "/opt/mine/chrome" } });
  assert.equal(list[0], "/opt/mine/chrome");
});

test("on Windows the candidates are built from the Program Files and AppData folders", () => {
  const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
  const list = cdp.chromeCandidates({ platform: "win32", env });
  assert.ok(list.includes("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"));
  assert.ok(list.includes("C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"));
  assert.ok(list.includes("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"));
});

test("on a Mac the candidates point inside the .app bundle", () => {
  const list = cdp.chromeCandidates({ platform: "darwin", env: {} });
  assert.ok(list.includes("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
});

test("findChrome returns the first candidate that exists", () => {
  const asked = [];
  const found = cdp.findChrome({ platform: "linux", env: { CHROME_BIN: "/nope" }, exists: (c) => (asked.push(c), c === "chromium") });
  assert.equal(found, "chromium");
  assert.equal(asked[0], "/nope");
});

test("findChrome tells the person how to point at Chrome when none is found", () => {
  assert.throws(() => cdp.findChrome({ platform: "linux", env: {}, exists: () => false }), /CHROME_BIN/);
});

test("the dev server serves index.html on the port it prints", async () => {
  const child = spawn(process.execPath, [join(root, "tools", "dev.mjs"), "0"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the dev server did not print an address")), 5000);
      child.stdout.on("data", (chunk) => {
        const hit = /http:\/\/127\.0\.0\.1:\d+\/index\.html/.exec(String(chunk));
        if (hit) { clearTimeout(timer); resolve(hit[0]); }
      });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error("the dev server exited with " + code)); });
    });
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /id="app"/);
  } finally {
    child.kill();
  }
});

test("the build names its room server when told (--server= or HAMKKE_SERVER), and refuses an address that is not a database", async () => {
  // Built into a file of its own (--out=): the build under test in dist/ is never changed by the
  // unit tests (a screen run against dist/ once tested a file that changed under it).
  const { mkdtempSync, statSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const outFile = join(mkdtempSync(join(tmpdir(), "hamkke-build-")), "index.html");
  const distFile = join(root, "dist/index.html");
  const distBefore = existsSync(distFile) ? statSync(distFile).mtimeMs : null;
  const run = (args, env = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, "tools/bundle.mjs"), "--out=" + outFile, ...args], { env: { ...process.env, HAMKKE_SERVER: "", ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
  const { readFileSync } = await import("node:fs");
  const built = () => readFileSync(outFile, "utf8");
  const url = "https://hamkke-test-default-rtdb.asia-southeast1.firebasedatabase.app";
  assert.equal((await run(["--server=" + url])).code, 0);
  assert.ok(built().includes(`<meta name="hamkke-server" content="${url}">`));
  assert.equal((await run([], { HAMKKE_SERVER: url + "/" })).code, 0);
  assert.ok(built().includes(`<meta name="hamkke-server" content="${url}">`), "the address from the environment, without the trailing slash");
  const bad = await run(["--server=https://evil.example"]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /server/);
  assert.equal((await run([])).code, 0);
  assert.ok(!built().includes(`<meta name="hamkke-server"`), "no server named, none written");
  assert.equal(existsSync(distFile) ? statSync(distFile).mtimeMs : null, distBefore, "dist/index.html was left alone");
});
