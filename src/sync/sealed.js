// A locked room's channel (core/lock.js): ops and presence go out sealed with the room's key and come
// in opened. What this key cannot open (written before the room was locked, another room's, a forged
// op) is left out, so nothing unsealed ever mixes into a locked room. Everything else about the
// transport stays as it is: the app talks to the same promise (transport.js).

import { sealValue, openValue, isSealed } from "../core/lock.js";

export function sealedChannel(channel, key) {
  const open = async (ops) => (await Promise.all((ops || []).map((op) => (isSealed(op) ? openValue(key, op.s) : null)))).filter((op) => op && typeof op === "object");
  let presenceOut = 0;
  let presenceIn = 0;
  return {
    docs: () => channel.docs(),
    load: async (docId) => open(await channel.load(docId)),
    append: async (docId, ops) => channel.append(docId, await Promise.all(ops.map(async (op) => ({ s: await sealValue(key, op) })))),
    subscribe: (fn) => channel.subscribe((docId, ops) => {
      open(ops).then((plain) => {
        if (plain.length) fn(docId, plain);
      });
    }),
    setPresence: (state) => {
      const n = ++presenceOut;
      sealValue(key, state).then((s) => {
        if (n === presenceOut) channel.setPresence({ s });
      });
    },
    onPresence: (fn) => channel.onPresence((peers) => {
      const n = ++presenceIn;
      Promise.all(peers.map(async (p) => ({ ...p, state: (p.state && typeof p.state.s === "string" ? await openValue(key, p.state.s) : null) || {} })))
        .then((opened) => {
          if (n === presenceIn) fn(opened);
        });
    }),
    onStatus: (fn) => channel.onStatus(fn),
    close: () => channel.close(),
  };
}

/** The same transport, but the locked room opens through its sealed channel. */
export function sealedTransport(transport, roomId, key) {
  const wrapped = Object.create(transport);
  wrapped.openRoom = async (id) => {
    const channel = await transport.openRoom(id);
    return channel && id === roomId ? sealedChannel(channel, key) : channel;
  };
  return wrapped;
}

/** Whether a room is locked, from its first ops as stored (a locked room's ops are all sealed). */
export async function isLockedRoom(transport, roomId) {
  const channel = await transport.openRoom(roomId);
  if (!channel) return null;
  try {
    const ops = await channel.load("room");
    return ops.length > 0 && ops.every(isSealed);
  } finally {
    channel.close();
  }
}

/** Whether a key opens a locked room (its first sealed op opens with it). */
export async function keyOpens(transport, roomId, key) {
  const channel = await transport.openRoom(roomId);
  if (!channel) return false;
  try {
    const first = (await channel.load("room")).find(isSealed);
    return !!first && (await openValue(key, first.s)) !== null;
  } finally {
    channel.close();
  }
}
