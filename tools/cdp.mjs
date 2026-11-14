// Drives headless Chrome over the DevTools protocol. No dependencies.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = {
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
};

/** Where a Chromium-based browser may live. CHROME_BIN comes first, so anyone can point at their own. */
export function chromeCandidates({ platform = process.platform, env = process.env } = {}) {
  const list = [];
  if (env.CHROME_BIN) list.push(env.CHROME_BIN);
  const under = (base, rest) => (base ? [`${base}\\${rest}`] : []);
  if (platform === "win32") {
    list.push(
      ...under(env.ProgramFiles, "Google\\Chrome\\Application\\chrome.exe"),
      ...under(env["ProgramFiles(x86)"], "Google\\Chrome\\Application\\chrome.exe"),
      ...under(env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe"),
      ...under(env["ProgramFiles(x86)"], "Microsoft\\Edge\\Application\\msedge.exe"),
      ...under(env.ProgramFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
    );
  } else if (platform === "darwin") {
    list.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  }
  list.push("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge");
  return list;
}

/** A full path must exist as a file; a bare name is looked up on PATH. */
function isInstalled(candidate, { platform, env }) {
  if (/[\\/]/.test(candidate)) return existsSync(candidate);
  const suffixes = platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  return (env.PATH || env.Path || "").split(delimiter).filter(Boolean).some((dir) => suffixes.some((s) => existsSync(join(dir, candidate + s))));
}

/** The first browser that is really there; says how to point at one when none is. */
export function findChrome({ platform = process.platform, env = process.env, exists = (c) => isInstalled(c, { platform, env }) } = {}) {
  const found = chromeCandidates({ platform, env }).find((c) => exists(c));
  if (!found) throw new Error("Chrome (or Edge) was not found. Install it, or set CHROME_BIN to the program's full path.");
  return found;
}

export async function launch({ port = 9333, args = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hamkke-chrome-"));
  const proc = spawn(findChrome(), [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--disable-extensions",
    "--disable-background-networking", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", "--proxy-server=127.0.0.1:9", "--proxy-bypass-list=127.0.0.1", ...args, `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "about:blank",
  ], { stdio: "ignore" });
  let url;
  for (let i = 0; i < 150 && !url; i++) {
    try {
      url = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {
      await sleep(100);
    }
  }
  if (!url) throw new Error("Chrome did not start");
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0;
  const waiting = new Map();
  const listeners = new Set();
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const waiter = msg.id && waiting.get(msg.id);
    if (waiter) {
      waiting.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    } else for (const fn of listeners) fn(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });

  async function page(target, { width = 360, height = 760, dark = false, reducedMotion = false, init = null } = {}) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const s = (method, params) => send(method, params, sessionId);
    const errors = [];
    listeners.add((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    });
    await s("Page.enable");
    await s("Runtime.enable");
    await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
    const media = (isDark, reduce) => s("Emulation.setEmulatedMedia", { features: [
      { name: "prefers-color-scheme", value: isDark ? "dark" : "light" },
      { name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" },
    ] });
    await media(dark, reducedMotion);
    if (init) await s("Page.addScriptToEvaluateOnNewDocument", { source: init });

    const evaluate = async (expression) => {
      const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error("in page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + "\n  expr: " + expression.slice(0, 200));
      return r.result.value;
    };
    const waitFor = async (expression, ms = 5000) => {
      const t0 = Date.now();
      for (;;) {
        const v = await evaluate(expression).catch(() => false);
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error("waitFor timed out: " + expression.slice(0, 200));
        await sleep(25);
      }
    };
    const mouse = (type, x, y, clickCount) => s("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount, pointerType: "mouse" });
    const api = {
      errors,
      eval: evaluate,
      waitFor,
      goto: async (u) => { await s("Page.navigate", { url: u }); await waitFor("document.readyState === 'complete'"); },
      reload: async () => { await s("Page.reload", {}); await sleep(50); await waitFor("document.readyState === 'complete'"); },
      type: (text) => s("Input.insertText", { text }),
      ime: (text) => s("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length }),
      key: async (name) => {
        const k = KEYS[name];
        await s("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...k });
        await s("Input.dispatchKeyEvent", { type: "keyUp", ...k });
      },
      tap: async (x, y) => { await mouse("mousePressed", x, y, 1); await mouse("mouseReleased", x, y, 1); },
      // A press that is held and moved: the pieces of a drag. Chrome hands moves to a page only
      // on its animation frames, which a page in the background hardly gets: come to the front first.
      press: async (x, y) => { await s("Page.bringToFront"); await mouse("mousePressed", x, y, 1); },
      front: () => s("Page.bringToFront"),
      /** A mouse wheel turn at a point; modifiers like a held Shift or Alt. */
      wheel: async (x, y, deltaY, { shift = false, alt = false, ctrl = false } = {}) => {
        await s("Page.bringToFront");
        await s("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers: (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0), pointerType: "mouse" });
      },
      moveTo: (x, y) => s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1, pointerType: "mouse" }),
      release: (x, y) => mouse("mouseReleased", x, y, 1),
      /** Puts files into a file input, as if picked in the file chooser. */
      setFiles: async (selector, files) => {
        const { result } = await s("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` });
        if (!result.objectId) throw new Error("no element " + selector);
        await s("DOM.setFileInputFiles", { files, objectId: result.objectId });
      },
      dblTap: async (x, y) => {
        await mouse("mousePressed", x, y, 1); await mouse("mouseReleased", x, y, 1);
        await sleep(60);
        await mouse("mousePressed", x, y, 2); await mouse("mouseReleased", x, y, 2);
      },
      media,
      shot: async (file) => {
        const { data } = await s("Page.captureScreenshot", { format: "png" });
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, Buffer.from(data, "base64"));
      },
      close: () => send("Target.closeTarget", { targetId }).catch(() => {}),
    };
    await api.goto(target);
    return api;
  }

  return {
    page,
    close: async () => {
      try { socket.close(); } catch {}
      proc.kill("SIGKILL");
    },
  };
}
