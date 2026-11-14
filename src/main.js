// Start-up: choose how ops travel, then show home or a room.

import { openStore, getSettings, roomEntry } from "./identity.js";
import { Emitter } from "./sync/transport.js";
import { LocalTransport } from "./sync/local.js";
import { ClaudeTransport } from "./sync/claude.js";
import { FirebaseTransport, serverFrom } from "./sync/firebase.js";
import { applyTheme, applyAccent, applyTextScale, fitScale } from "./ui/theme.js";
import { showHome } from "./ui/home.js";
import { showRoom } from "./ui/room-shell.js";
import { roomLink } from "./core/room.js";
import { BlobStore } from "./sync/blobs.js";

export const APP_VERSION = "0.1.0";
const ROOM_ROUTE = /^r-([a-z2-7]{12})$/;

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

/**
 * The room server this build names (a meta tag that tools/bundle.mjs --server= writes).
 * Tests name a server on this machine with ?server=; no link can name any other.
 */
function roomServer(params, testing) {
  const asked = params.get("server");
  if (asked) return /^http:\/\/(127\.0\.0\.1|localhost):/.test(asked) ? serverFrom(asked) : null;
  if (testing) return null;
  return serverFrom(document.querySelector('meta[name="hamkke-server"]')?.content || "");
}

async function chooseTransport(app, patience, testing, params) {
  const runtime = await findRuntime();
  app.trace(`page ${window.parent !== window ? "framed" : "top"}, runtime ${runtime ? "found" : "absent"}`);
  if (!runtime) {
    // The public address: rooms on the server, joined by link from any browser.
    const server = roomServer(params, testing);
    if (server) {
      app.trace("server " + server.replace(/^https?:\/\//, ""));
      return { transport: new FirebaseTransport(server, { callTimeoutMs: patience, log: app.trace }), limited: false };
    }
    // With no server named, rooms live on this device only, and the screens say so.
    // Test devices (?dev=…) share one browser, so for them the local rooms are shared.
    return { transport: app.local(), limited: !testing };
  }
  const transport = await ClaudeTransport.connect(runtime, { callTimeoutMs: patience, log: app.trace });
  return transport ? { transport, limited: false } : { transport: app.local(), limited: true };
}

export function boot(root) {
  const params = new URLSearchParams(location.search);
  const dev = params.get("dev");
  const ns = params.get("ns") || "main";
  // How long one call to the shared store may take before the app stops waiting. Tests shorten it.
  const patience = Number(params.get("patience")) || 8000;
  const started = Date.now();
  const trace = [];
  let route = location.hash.replace(/^#/, "");
  let localTransport = null;
  // `dev` and `ns` exist for tests: one browser can play several devices, each run in its own space.
  const store = openStore(dev === "broken" ? refusingStorage() : undefined, dev && dev !== "broken" ? `dev-${dev}:${ns}:` : "hamkke:");
  const app = {
    version: APP_VERSION, root, store, events: new Emitter(),
    // Recordings kept on this device. Test devices get their own.
    blobs: new BlobStore(dev ? `hamkke-files-${dev}-${ns}` : "hamkke-files"),
    transport: null, limited: false, connecting: true, session: null, handoff: null, fresh: null, booted: false,
    /** The published page's own address, when the build names one (the trial page). */
    shareBase: () => document.querySelector('meta[name="share-base"]')?.content || null,
    linkFor: (roomId) => roomLink(app.shareBase() || location.href, roomId),
    /** Shows a screen. The address follows where the page is allowed to change it; the screen never waits for it. */
    go(hash) {
      route = hash;
      try {
        if (location.hash.replace(/^#/, "") !== hash) location.hash = hash;
      } catch {
        // Some frames keep the address out of reach.
      }
      render();
    },
    /** A short record of how this view connected, for the diagnostics sheet. */
    trace(text) {
      trace.push(((Date.now() - started) / 1000).toFixed(1) + "s " + text);
      if (trace.length > 16) trace.shift();
    },
    traceText: () => trace.join("\n"),
    /** Rooms kept on this device only: used when no shared store answers. */
    local: () => (localTransport ||= new LocalTransport({ ns })),
    transportFor: async (roomId) => {
      const shared = await app.ready;
      return roomEntry(store, roomId)?.local ? app.local() : shared;
    },
  };
  window.__app = app;
  fitScale();
  applyTheme(getSettings(store).theme);
  applyAccent(getSettings(store).accent);
  applyTextScale(getSettings(store).textScale);
  app.ready = chooseTransport(app, patience, !!dev, params).then(({ transport, limited }) => {
    app.transport = transport;
    app.limited = limited;
    app.connecting = false;
    return transport;
  });

  let leave = null;
  function render() {
    leave?.();
    const room = ROOM_ROUTE.exec(route);
    leave = room ? showRoom(app, room[1]) : showHome(app);
  }
  window.addEventListener("hashchange", () => {
    const now = location.hash.replace(/^#/, "");
    if (now === route) return;
    route = now;
    render();
  });
  window.addEventListener("pagehide", () => leave?.());
  render();
  app.booted = true;
}

boot(document.getElementById("app"));
