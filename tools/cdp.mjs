// Drives headless Chrome over the DevTools protocol. No dependencies.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

export async function launch({ port = 9333 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hamkke-chrome-"));
  const proc = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--disable-extensions",
    "--disable-background-networking", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", "--proxy-server=127.0.0.1:9", "--proxy-bypass-list=127.0.0.1", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "about:blank",
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
