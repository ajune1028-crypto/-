// Start-up: choose how ops travel, then show home or a room.

import { openStore, getSettings } from "./identity.js";
import { Emitter } from "./sync/transport.js";
import { LocalTransport } from "./sync/local.js";
import { ClaudeTransport } from "./sync/claude.js";
import { applyTheme, fitScale } from "./ui/theme.js";
import { showHome } from "./ui/home.js";
import { showRoom } from "./ui/room-shell.js";

export const APP_VERSION = "0.1.0";
const ROOM_HASH = /^#r-([a-z2-7]{12})$/;

function refusingStorage() {
  const refuse = () => {
    throw new Error("storage refused");
  };
  return { getItem: refuse, setItem: refuse, removeItem: refuse };
}

/** Inside the trial page the runtime may appear a moment after the script starts. */
async function findRuntime() {
  const framed = window.parent !== window;
  for (let i = 0; i < (framed ? 30 : 1); i++) {
    if (window.claude && typeof window.claude.use === "function") return window.claude;
    if (framed) await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

async function chooseTransport(ns) {
  const runtime = await findRuntime();
  if (!runtime) return { transport: new LocalTransport({ ns }), limited: false };
  const transport = await ClaudeTransport.connect(runtime);
  return transport ? { transport, limited: false } : { transport: new LocalTransport({ ns }), limited: true };
}

export function boot(root) {
  const params = new URLSearchParams(location.search);
  const dev = params.get("dev");
  const ns = params.get("ns") || "main";
  // `dev` and `ns` exist for tests: one browser can play several devices, each run in its own space.
  const store = openStore(dev === "broken" ? refusingStorage() : undefined, dev && dev !== "broken" ? `dev-${dev}:${ns}:` : "hamkke:");
  const app = {
    version: APP_VERSION, root, store, events: new Emitter(),
    transport: null, limited: false, connecting: true, session: null, handoff: null, booted: false,
    go(hash) {
      if (location.hash.replace(/^#/, "") === hash) render();
      else location.hash = hash;
    },
  };
  window.__app = app;
  fitScale();
  applyTheme(getSettings(store).theme);
  app.ready = chooseTransport(ns).then(({ transport, limited }) => {
    app.transport = transport;
    app.limited = limited;
    app.connecting = false;
    return transport;
  });

  let leave = null;
  function render() {
    leave?.();
    const room = ROOM_HASH.exec(location.hash);
    leave = room ? showRoom(app, room[1]) : showHome(app);
  }
  window.addEventListener("hashchange", render);
  window.addEventListener("pagehide", () => leave?.());
  render();
  app.booted = true;
}

boot(document.getElementById("app"));
