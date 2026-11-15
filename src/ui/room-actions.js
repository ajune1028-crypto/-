// What a room on home can do from a long press: be copied whole into a new room
// (복제), or be put onto a whiteboard (화이트보드에 넣기): a song room's clips as
// song cards, a text room's lines as text, a whiteboard's cards as they are.

import { RoomSession } from "../sync/session.js";
import { newRoomId, newMemberId, joinOps } from "../core/room.js";
import { myPeopleColor } from "./theme.js";
import { addItemOps, cardFromClip, setItemOps, songCardData, keepOf, keptFields } from "../core/board.js";
import { sourceOp, addClipOps } from "../core/song.js";
import { rememberRoom, roomEntry, getSettings } from "../identity.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openRoom(app, id) {
  const session = new RoomSession({ transport: await app.transportFor(id), roomId: id, store: app.store });
  if ((await session.open()) !== "ok") {
    session.close();
    throw new Error("the room did not open");
  }
  return session;
}

/**
 * The rooms of these kinds I can reach: the ones this device remembers, and the ones the server
 * lists that this device has not opened yet (made on my other devices; home shows them under
 * "다른 기기에서 만든 방"). Resolves with { mine, others }.
 */
export async function reachableRooms(app, kinds) {
  const mine = app.store.get("rooms", []).filter((r) => kinds.includes(r.kind)).sort((a, b) => b.at - a.at);
  let others = [];
  try {
    const transport = await app.ready;
    const list = await Promise.race([transport.listRooms(), sleep(4000).then(() => [])]);
    others = list.filter((r) => kinds.includes(r.kind) && !mine.some((m) => m.id === r.id));
  } catch {
    others = [];
  }
  return { mine, others };
}

/**
 * Who I am in a room this device has not opened yet: the one person there with my name (me, from
 * another device), else a new member with my name, my colour there and my code. From then on the
 * room is remembered here too. `me` is my member record in the room I am in.
 */
export function meIn(app, to, entry, me) {
  const known = roomEntry(app.store, entry.id)?.memberId;
  if (known) return known;
  const same = to.room.members().filter((m) => m.name === me?.name);
  let id = same.length === 1 ? same[0].id : null;
  if (!id) {
    id = newMemberId();
    to.commit("room", joinOps(to.clock, to.room, { memberId: id, name: me?.name || "나", pin: me?.pin ?? null, now: Date.now(), color: myPeopleColor(getSettings(app.store), to.room) }));
  }
  rememberRoom(app.store, { id: entry.id, kind: entry.kind || to.room.meta("kind"), name: entry.name || to.room.meta("name"), memberId: id });
  return id;
}

/** Waits (a little) until what was written has gone out. */
async function sent(session) {
  for (let i = 0; i < 100 && session.pending; i++) await sleep(100);
}

/** 복제: a new room with everything the room holds, named "… 복사본", in my list. Resolves with its id. */
export async function duplicateRoom(app, entry) {
  const from = await openRoom(app, entry.id);
  try {
    const docs = new Set(["room", ...(await from.channel.docs())]);
    const transport = entry.local ? app.local() : await app.transportFor(entry.id);
    const id = newRoomId();
    const name = `${entry.name} 복사본`.slice(0, 30);
    await transport.createRoom({ id, kind: entry.kind, name });
    const to = new RoomSession({ transport, roomId: id, store: app.store });
    if ((await to.open()) !== "ok") throw new Error("the copy did not open");
    try {
      for (const doc of docs) {
        const ops = await from.channel.load(doc);
        if (ops.length) to.commit(doc, ops);
      }
      to.commit("room", [{ t: "meta", id: to.clock.next(), k: "name", v: name }]);
      await sent(to);
    } finally {
      to.close();
    }
    rememberRoom(app.store, { id, kind: entry.kind, name, memberId: entry.memberId, local: !!entry.local });
    return id;
  } finally {
    from.close();
  }
}

/** The room's things as whiteboard cards: { kind, data, color?, size? }. */
async function cardsOf(from, kind) {
  if (kind === "creative-song") {
    const song = await from.load("song");
    return song.layout().map((clip) => {
      const src = song.source(clip.src);
      const source = { duration: src.dur / 1000, notes: song.notesOf(src.id).map((n) => ({ t: n.t / 1000, d: n.d / 1000, p: n.p, v: n.v })), peaks: src.peaks, blob: src.blob, name: src.name };
      return { kind: "song", data: cardFromClip({ source, offset: clip.offset, length: clip.length }), speed: clip.speed, tint: clip.tint, muted: clip.muted };
    });
  }
  if (kind === "creative-board") {
    const board = await from.load("board");
    return board.items().map((i) => ({ kind: i.kind, data: i.kind === "note" ? { text: i.text || "" } : i.data, ...keepOf(i) }));
  }
  // A text room: the lines of its last three days, oldest first.
  const cards = [];
  for (const day of from.days().slice(-3)) {
    const sheet = await from.loadSheet(day);
    for (const line of sheet.text().split("\n")) if (line.trim()) cards.push({ kind: "note", data: { text: line.trim().slice(0, 4000) } });
  }
  return cards;
}

/** 화이트보드에 넣기: the room's things as cards to the right of what the board holds. Resolves with how many. */
export async function putIntoBoard(app, entry, boardEntry) {
  const from = await openRoom(app, entry.id);
  try {
    const cards = (await cardsOf(from, entry.kind)).slice(0, 60);
    if (!cards.length) return 0;
    const to = await openRoom(app, boardEntry.id);
    try {
      const board = await to.load("board");
      const by = roomEntry(app.store, boardEntry.id)?.memberId || entry.memberId;
      const items = board.items();
      const x0 = items.length ? Math.max(...items.map((i) => i.x + i.w)) + 80 : 40;
      let x = x0;
      let y = 40;
      cards.forEach((card, n) => {
        const made = addItemOps(to.clock, board, { kind: card.kind, x, y, data: card.data, by });
        to.commit("board", made.ops);
        const keep = keptFields(card.kind, card, card.data);
        if (Object.keys(keep).length) to.commit("board", setItemOps(to.clock, board, made.id, keep).ops);
        const item = board.item(made.id);
        y += (card.kind === "song" ? 110 : card.kind === "photo" ? Math.round((item.w * card.data.h) / card.data.w) + 30 : 56);
        if ((n + 1) % 8 === 0) {
          x += 360;
          y = 40;
        }
      });
      await sent(to);
      return cards.length;
    } finally {
      to.close();
    }
  } finally {
    from.close();
  }
}

/**
 * 보내기: a recording kept on this device into a room of mine: a song room takes it as a clip
 * after everything it holds (on the first row with room there), a whiteboard as a song card to
 * the right of its cards. Resolves when it has gone out.
 */
export async function putSoundInto(app, entry, sound, me = null) {
  const to = await openRoom(app, entry.id);
  try {
    const by = roomEntry(app.store, entry.id)?.memberId || entry.memberId || meIn(app, to, entry, me || { name: app.store.get("last", null)?.name });
    if (entry.kind === "creative-song") {
      const song = await to.load("song");
      if (!song.canAddClip()) throw new Error("the song is full");
      const length = Math.max(1, Math.round(sound.dur * 1000));
      const start = song.end();
      const row = song.freeRow(start, length, 0) ?? 0;
      const src = sourceOp(to.clock, song, { duration: sound.dur, notes: sound.notes, peaks: sound.peaks, by, at: Date.now(), blob: sound.blob, name: sound.name });
      const clip = addClipOps(to.clock, song, { src: src.id, row, start, length, by, at: Date.now() });
      to.commit("song", [src, ...clip.ops]);
    } else if (entry.kind === "creative-board") {
      const board = await to.load("board");
      const items = board.items();
      const x = items.length ? Math.max(...items.map((i) => i.x + i.w)) + 60 : 40;
      const y = items.length ? Math.min(...items.map((i) => i.y)) : 40;
      const data = songCardData({ duration: sound.dur, notes: sound.notes, peaks: sound.peaks, name: sound.name, blob: sound.blob });
      to.commit("board", addItemOps(to.clock, board, { kind: "song", x, y, data, by }).ops);
    } else throw new Error("not a room for sounds");
    await sent(to);
  } finally {
    to.close();
  }
}
