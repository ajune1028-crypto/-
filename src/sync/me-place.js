// 나의 고유 코드's place: where my rooms, houses, stars and settings meet from every device that has
// the code (the owner, 21 November: "이걸 안다면 당신의 모든 것들을 어디에서나"). The place is a room
// whose id is a hash of the code (placeOf), and all it holds is one sealed bundle per device
// (sealFor), so only the code finds it or reads it. Each device writes its registers (core/me.js);
// opening the place puts the newest of everything on this device.
//
// Where nothing is shared (the public address before its server), there is no place: everything stays
// on this device and 설정 says so.

import { placeOf, sealFor, openFor, mergeBundles, itemsNow, ledgerOf, viewOf } from "../core/me.js";
import { myCodeOf } from "../identity.js";

const DOC = "bundles";
/** Settings that are mine wherever I am. Where a bar or panel stands, and a device's own delay fix, stay on the device. */
export const SHARED_SETTINGS = ["theme", "accent", "textScale", "tintAmount", "colors", "mixing", "songMode", "pianoTone", "showWave", "songSpeed",
  "metronome", "snap", "grid", "countIn", "inkBrush", "inkEraser", "inkSteady", "inkShapes", "reference", "panelCycle", "games", "recentSearchMax",
  "soundEffects", "haptics", "lineColors", "animOnion", "boardText"];

function deviceOf(store) {
  let id = store.get("meDevice", null);
  if (typeof id !== "string" || !id) {
    id = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    store.set("meDevice", id);
  }
  return id;
}

/** This device's things as register values ("이 기기만" rooms stay here: no other device could open them). */
export function thingsOf(store) {
  const things = new Map();
  for (const r of store.get("rooms", [])) {
    if (r && typeof r.id === "string" && !r.local) things.set("room:" + r.id, { kind: r.kind || null, name: r.name || "", memberId: r.memberId || null, at: r.at || 0 });
  }
  for (const h of store.get("houses", [])) {
    if (h && typeof h.id === "string") things.set("house:" + h.id, { name: h.name, color: h.color, icon: h.icon, rooms: Array.isArray(h.rooms) ? h.rooms.slice() : [], at: h.at || 0 });
  }
  for (const id of store.get("homeStars", [])) if (typeof id === "string") things.set("star:" + id, true);
  const raw = store.get("settings", {}) || {};
  for (const k of SHARED_SETTINGS) if (raw[k] !== undefined) things.set("set:" + k, raw[k]);
  return things;
}

/**
 * The universe put on this device. What only this device knows of a room (its preview, its people,
 * the rooms kept only here) stays. With `keep`, rooms, houses and stars this device has and the
 * universe does not are kept too (the first meeting). Returns the names of the settings that changed.
 */
export function putOn(store, view, { keep = false } = {}) {
  const had = store.get("rooms", []);
  const byId = new Map(had.map((r) => [r.id, r]));
  const there = new Set(view.rooms.map((r) => r.id));
  const rooms = [];
  for (const r of had) {
    const v = there.has(r.id) ? view.rooms.find((x) => x.id === r.id) : null;
    if (v) rooms.push({ ...r, kind: v.kind ?? r.kind, name: v.name ?? r.name, memberId: v.memberId ?? r.memberId, at: Math.max(r.at || 0, v.at || 0) });
    else if (r.local || keep) rooms.push(r);
  }
  for (const v of view.rooms) if (!byId.has(v.id)) rooms.push({ id: v.id, kind: v.kind, name: v.name, memberId: v.memberId, at: v.at || Date.now() });
  store.set("rooms", rooms);

  const houses = new Map((keep ? store.get("houses", []) : []).map((h) => [h.id, h]));
  for (const v of view.houses) houses.set(v.id, { id: v.id, name: v.name, color: v.color, icon: v.icon, rooms: v.rooms || [], at: v.at || 0 });
  store.set("houses", [...houses.values()]);

  const stars = new Set([...(keep ? store.get("homeStars", []) : []), ...view.stars]);
  store.set("homeStars", [...stars]);

  const raw = { ...(store.get("settings", {}) || {}) };
  const changed = [];
  for (const [k, v] of Object.entries(view.settings)) {
    if (!SHARED_SETTINGS.includes(k) || JSON.stringify(raw[k]) === JSON.stringify(v)) continue;
    raw[k] = v;
    changed.push(k);
  }
  if (changed.length) store.set("settings", raw);
  return changed;
}

/**
 * Keeps this device and the code's place together while the app runs. `events` hears "me-changed"
 * ({ settings }) whenever the universe changed something here. Returns { status(), restart(), stop() }.
 */
export function startMyPlace({ store, ready, events, isLimited = () => false, pollMs = 2500 }) {
  let run = 0;
  let state = { kind: "starting", at: 0 };
  let channel = null;
  let unsubscribe = null;
  let poll = null;
  let soon = null;
  let busy = null;
  let lastThings = "";

  const say = (kind) => {
    state = { kind, at: Date.now() };
    events?.emit("me-status", state);
  };

  async function begin() {
    const mine = ++run;
    stopChannel();
    const transport = await ready;
    if (mine !== run) return;
    if (!transport || isLimited()) return say("device");
    const code = myCodeOf(store).code;
    const place = await placeOf(code);
    try {
      channel = await transport.openRoom(place);
      if (!channel) {
        await transport.createRoom({ id: place, kind: "me", name: "" });
        channel = await transport.openRoom(place);
      }
    } catch (err) {
      console.warn(err);
      return say("error");
    }
    if (mine !== run || !channel) return say(channel ? "starting" : "error");
    unsubscribe = channel.subscribe((docId) => {
      if (docId === DOC) later(150);
    });
    poll = setInterval(() => {
      const now = JSON.stringify([...thingsOf(store)]);
      if (now !== lastThings) later(600);
    }, pollMs);
    await sync(code);
  }

  function later(ms) {
    clearTimeout(soon);
    soon = setTimeout(() => sync(myCodeOf(store).code), ms);
  }

  async function sync(code) {
    if (!channel) return;
    if (busy) return busy.then(() => later(50));
    const mine = run;
    busy = (async () => {
      say("syncing");
      const ops = await channel.load(DOC);
      const newest = new Map();
      for (const op of ops) {
        if (!op || op.t !== "b" || typeof op.dev !== "string") continue;
        const was = newest.get(op.dev);
        if (!was || op.at > was.at || (op.at === was.at && op.sealed > was.sealed)) newest.set(op.dev, op);
      }
      const me = deviceOf(store);
      const theirs = (await Promise.all([...newest.values()].filter((op) => op.dev !== me).map((op) => openFor(code, op.sealed)))).filter(Boolean);
      if (mine !== run) return;
      let ledger = store.get("meLedger", null);
      const changed = new Set();
      const seen = () => JSON.stringify([store.get("rooms", []), store.get("houses", []), store.get("homeStars", [])]);
      const before = seen();
      if (!ledger) {
        // The first meeting with this universe: what it already holds wins over what this device has
        // (a new device's plain settings must not undo the ones chosen elsewhere); what only this
        // device has joins it.
        const there = mergeBundles(theirs);
        for (const k of putOn(store, viewOf(there.items), { keep: true })) changed.add(k);
        ledger = ledgerOf(there.items);
      }
      const now = itemsNow(thingsOf(store), ledger, Date.now());
      const all = mergeBundles([...theirs, { items: now.items }]);
      for (const k of putOn(store, viewOf(all.items))) changed.add(k);
      const settled = itemsNow(thingsOf(store), ledgerOf(all.items), Date.now());
      store.set("meLedger", settled.ledger);
      lastThings = JSON.stringify([...thingsOf(store)]);
      const bundle = { items: settled.items };
      const said = JSON.stringify(bundle);
      if (store.get("mePushed", null) !== said) {
        await channel.append(DOC, [{ t: "b", dev: me, at: Date.now(), sealed: await sealFor(code, bundle) }]);
        store.set("mePushed", said);
      }
      say("ok");
      if (changed.size || seen() !== before) events?.emit("me-changed", { settings: [...changed] });
    })().catch((err) => {
      console.warn(err);
      say("error");
      if (mine === run) later(8000);
    }).finally(() => {
      busy = null;
    });
    return busy;
  }

  function stopChannel() {
    clearInterval(poll);
    clearTimeout(soon);
    unsubscribe?.();
    unsubscribe = null;
    try {
      channel?.close();
    } catch {
      // already closed
    }
    channel = null;
  }

  begin();
  return {
    status: () => state,
    restart: () => begin(),
    syncNow: () => sync(myCodeOf(store).code),
    stop: () => {
      run++;
      stopChannel();
    },
  };
}
