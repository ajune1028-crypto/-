// 미니게임: short games with a friend inside a room (the owner: "미니게임 신청… 친구가 수락하면 전체가
// 조금 어두워지고 가운데 3, 2, 1… 카운트가 끝났을 때 미니게임이 뜨게"). One document per room
// ("game"), so a game is the same on every screen and its result stays in the room. From the reference
// study §4: one invitation, a shared countdown, short games, the result kept.
//
//   ask    { id, kind: "rps" | "omok", by, at }     an invitation
//   reply  { id, g: ask id, by, yes, at }           the first yes from someone else begins the game
//                                                  COUNTDOWN_MS after it (the 3·2·1)
//   pick   { id, g, by, v }                         가위바위보: rock · paper · scissors (the first counts)
//   stone  { id, g, by, x, y, n }                   오목: the n-th stone; black (the asker) first; of
//                                                  stones claiming the same turn, the lowest id that is
//                                                  allowed counts
//   quit   { id, g, by }                            leaving: the one who stays wins
// Whatever order they arrive in, every screen derives the same game.

import { cmpId, validId } from "./crdt.js";

export const KINDS = ["rps", "omok"];
export const RPS = ["rock", "paper", "scissors"];
export const OMOK_SIZE = 15;
export const COUNTDOWN_MS = 3600;
const MAX_UNKNOWN = 300;

const counterOf = (id) => Number(id.slice(0, id.indexOf("@")));
const who = (v) => typeof v === "string" && v.length > 0 && v.length <= 40;

/** 가위바위보: 0 if a wins, 1 if b wins, -1 for a draw. */
export function rpsWinner(a, b) {
  if (a === b) return -1;
  const beats = { rock: "scissors", scissors: "paper", paper: "rock" };
  return beats[a] === b ? 0 : 1;
}

export class GameDoc {
  constructor() {
    this.version = 0;
    this.games = new Map();
    this.waiting = new Map();
    this.seen = new Set();
    this.unknown = [];
    this.maxN = 0;
  }

  apply(op) {
    if (!op || typeof op !== "object" || !validId(op.id)) return this.setAside(op);
    if (this.seen.has(op.id)) return "dup";
    if (op.t === "ask") {
      if (!KINDS.includes(op.kind) || !who(op.by) || !Number.isFinite(op.at)) return this.setAside(op);
      this.games.set(op.id, { id: op.id, kind: op.kind, by: op.by, at: op.at, replies: [], picks: [], stones: [], quits: [] });
      this.done(op);
      for (const later of this.waiting.get(op.id) || []) this.apply(later);
      this.waiting.delete(op.id);
      return "applied";
    }
    if (!validId(op.g) || !who(op.by)) return this.setAside(op);
    let list;
    if (op.t === "reply") {
      if (typeof op.yes !== "boolean" || !Number.isFinite(op.at)) return this.setAside(op);
      list = "replies";
    } else if (op.t === "pick") {
      if (!RPS.includes(op.v)) return this.setAside(op);
      list = "picks";
    } else if (op.t === "stone") {
      const inBoard = (v) => Number.isInteger(v) && v >= 0 && v < OMOK_SIZE;
      if (!inBoard(op.x) || !inBoard(op.y) || !Number.isInteger(op.n) || op.n < 0 || op.n >= OMOK_SIZE * OMOK_SIZE) return this.setAside(op);
      list = "stones";
    } else if (op.t === "quit") {
      list = "quits";
    } else return this.setAside(op);
    const game = this.games.get(op.g);
    if (!game) {
      if (!this.waiting.has(op.g)) this.waiting.set(op.g, []);
      this.waiting.get(op.g).push(op);
      return "pending";
    }
    game[list].push(op);
    return this.done(op);
  }

  applyAll(ops) {
    const before = this.version;
    for (const op of ops) this.apply(op);
    return this.version !== before;
  }

  done(op) {
    this.seen.add(op.id);
    this.version++;
    const n = counterOf(op.id);
    if (n > this.maxN) this.maxN = n;
    return "applied";
  }

  setAside(op) {
    if (this.unknown.length < MAX_UNKNOWN) this.unknown.push(op);
    return "unknown";
  }

  /**
   * A game as it stands: { id, kind, by, at, state: "asked" | "declined" | "cancelled" | "playing" |
   * "done", players, start, picks, stones, winner, draw, line }.
   */
  game(id) {
    const g = this.games.get(id);
    if (!g) return null;
    const byId = (a, b) => cmpId(a.id, b.id);
    const out = { id: g.id, kind: g.kind, by: g.by, at: g.at, state: "asked", players: [g.by], start: null, picks: {}, stones: [], winner: null, draw: false, line: [] };
    const replies = g.replies.filter((r) => r.by !== g.by).sort(byId);
    const yes = replies.find((r) => r.yes);
    const quits = g.quits.slice().sort(byId);
    if (!yes) {
      if (quits.some((q) => q.by === g.by)) out.state = "cancelled";
      else if (replies.length) out.state = "declined";
      return out;
    }
    out.state = "playing";
    out.players = [g.by, yes.by];
    out.start = yes.at + COUNTDOWN_MS;
    if (g.kind === "rps") this.rps(g, out);
    else this.omok(g, out);
    if (out.state === "playing") {
      const left = quits.find((q) => out.players.includes(q.by));
      if (left) {
        out.state = "done";
        out.winner = out.players.find((p) => p !== left.by);
        out.left = left.by;
      }
    }
    return out;
  }

  rps(g, out) {
    for (const p of g.picks.slice().sort((a, b) => cmpId(a.id, b.id))) {
      if (out.players.includes(p.by) && !out.picks[p.by]) out.picks[p.by] = p.v;
    }
    const [a, b] = out.players;
    if (!out.picks[a] || !out.picks[b]) return;
    out.state = "done";
    const w = rpsWinner(out.picks[a], out.picks[b]);
    if (w < 0) out.draw = true;
    else out.winner = out.players[w];
  }

  omok(g, out) {
    const byTurn = new Map();
    for (const s of g.stones) {
      if (!byTurn.has(s.n)) byTurn.set(s.n, []);
      byTurn.get(s.n).push(s);
    }
    const board = new Map();
    for (let n = 0; ; n++) {
      const tries = (byTurn.get(n) || []).sort((a, b) => cmpId(a.id, b.id));
      const turn = out.players[n % 2];
      const s = tries.find((t) => t.by === turn && !board.has(t.x + "," + t.y));
      if (!s) break;
      board.set(s.x + "," + s.y, s.by);
      out.stones.push({ x: s.x, y: s.y, by: s.by, n });
      const line = fiveThrough(board, s.x, s.y, s.by);
      if (line) {
        out.state = "done";
        out.winner = s.by;
        out.line = line;
        return;
      }
      if (out.stones.length === OMOK_SIZE * OMOK_SIZE) {
        out.state = "done";
        out.draw = true;
        return;
      }
    }
  }

  /** The games there are, oldest first. */
  list() {
    return [...this.games.keys()].map((id) => this.game(id)).sort((a, b) => cmpId(a.id, b.id));
  }

  /** Who won how often, between two people: { [a]: wins, [b]: wins, draws }. */
  tally(a, b) {
    const out = { [a]: 0, [b]: 0, draws: 0 };
    for (const g of this.list()) {
      if (g.state !== "done" || !g.players.includes(a) || !g.players.includes(b)) continue;
      if (g.draw) out.draws++;
      else if (g.winner) out[g.winner]++;
    }
    return out;
  }
}

/** Five or more of one colour in a row through (x, y): the points along it, in order, or null. */
function fiveThrough(board, x, y, by) {
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const run = [[x, y]];
    for (const sign of [1, -1]) {
      let cx = x + dx * sign;
      let cy = y + dy * sign;
      while (board.get(cx + "," + cy) === by) {
        if (sign > 0) run.push([cx, cy]);
        else run.unshift([cx, cy]);
        cx += dx * sign;
        cy += dy * sign;
      }
    }
    if (run.length >= 5) return run;
  }
  return null;
}

export function askOps(clock, doc, { kind, by, at = Date.now() }) {
  clock.atLeast(doc.maxN);
  const op = { t: "ask", id: clock.next(), kind, by, at };
  return { ops: [op], id: op.id };
}

export function replyOps(clock, doc, g, { by, yes, at = Date.now() }) {
  clock.atLeast(doc.maxN);
  return { ops: [{ t: "reply", id: clock.next(), g, by, yes: !!yes, at }] };
}

export function pickOps(clock, doc, g, { by, v }) {
  clock.atLeast(doc.maxN);
  return { ops: [{ t: "pick", id: clock.next(), g, by, v }] };
}

/** The next stone: its turn number is how many stones the game has now. */
export function stoneOps(clock, doc, g, { by, x, y }) {
  const now = doc.game(g);
  if (!now) return { ops: [] };
  clock.atLeast(doc.maxN);
  return { ops: [{ t: "stone", id: clock.next(), g, by, x, y, n: now.stones.length }] };
}

export function quitOps(clock, doc, g, { by }) {
  clock.atLeast(doc.maxN);
  return { ops: [{ t: "quit", id: clock.next(), g, by }] };
}
