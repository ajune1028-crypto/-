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
//
// 이어 그리기 ("relay", for any number of people; the owner: "인원수가 많아 질 수록 2인용 게임 말고도…
// 갈틱폰의 느낌"; the old paper game of words and drawings passed round): everyone who says yes joins,
// and the asker begins it with them. Everyone writes a line, passes their book on, draws the line
// they got, passes on, writes what the drawing they got shows, and so on until each book has gone
// round; then the album shows every book from its first words to its last page.
//   begin  { id, g, by (the asker), at, players }    the players are fixed then
//   page   { id, g, by, r, text?, at }               a round's page from the one whose turn it is
//                                                  (the first counts; a drawing is in relayDoc)
//   turn   { id, g, by, n }                          the album shown up to page n, for everyone
//
// 그려서 맞히기 ("sketch", for any number of people; the reference study §4: Skribbl's turns as
// scribble.rs (BSD-3) and Skribblrs.io (MIT) run them, read for the flow and the scoring, with Korean
// 초성 for hints): everyone who says yes plays, and the asker begins it (begin, as 이어 그리기). Each
// in turn picks one of three words and draws it (live, in sketchDoc) while the others type guesses;
// the hint grows from blanks to 초성 to one syllable shown. A right guess scores more the sooner it
// comes, and the one drawing scores for each who got it; a turn ends when everyone has it or its time
// is up, the answer shows, and the next one draws. At the end, everyone's points.
//   word   { id, g, by, n (the turn), w, at }       the drawer's pick of the three (the first counts)
//   try    { id, g, by, n, text, at }               a guess
// Whatever order they arrive in, every screen derives the same game.

import { cmpId, validId } from "./crdt.js";
import { SKETCH_WORDS } from "./words.js";
import { initialOf } from "./search.js";

export const KINDS = ["rps", "omok", "relay", "sketch"];
/** The games for everyone in the room (gathered, then begun by the asker). */
export const MANY = ["relay", "sketch"];
export const RPS = ["rock", "paper", "scissors"];
export const OMOK_SIZE = 15;
export const COUNTDOWN_MS = 3600;
const MAX_UNKNOWN = 300;
// 이어 그리기's times (ms): a line to write, a drawing, a guess; the pause as the books pass on; how
// late a page may come (a slow network, a clock a little behind); words kept short.
export const RELAY = { write: 45000, draw: 90000, guess: 40000, gap: 1600, grace: 3000, maxText: 60, maxPlayers: 10, maxRounds: 8 };
// 그려서 맞히기's times (ms) and points: picking a word, drawing it, the answer shown; how late a
// guess may come; a guess's points (from most, at once, to least, at the end); the drawer's for each
// who got it.
export const SKETCH = { choose: 12000, draw: 80000, reveal: 4000, grace: 3000, maxTry: 30, maxTurns: 20, most: 200, least: 40, drawerPoints: 50 };

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
      this.games.set(op.id, { id: op.id, kind: op.kind, by: op.by, at: op.at, replies: [], picks: [], stones: [], quits: [], begins: [], pages: [], turns: [], words: [], tries: [] });
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
    } else if (op.t === "begin") {
      const ok = Number.isFinite(op.at) && Array.isArray(op.players) && op.players.length >= 2 && op.players.length <= RELAY.maxPlayers && op.players.every(who) && new Set(op.players).size === op.players.length;
      if (!ok) return this.setAside(op);
      list = "begins";
    } else if (op.t === "page") {
      const ok = Number.isInteger(op.r) && op.r >= 0 && op.r < RELAY.maxRounds && Number.isFinite(op.at) && (op.text === undefined || (typeof op.text === "string" && op.text.length <= 400));
      if (!ok) return this.setAside(op);
      list = "pages";
    } else if (op.t === "turn") {
      if (!Number.isInteger(op.n) || op.n < 0 || op.n > RELAY.maxPlayers * RELAY.maxRounds) return this.setAside(op);
      list = "turns";
    } else if (op.t === "word") {
      if (!Number.isInteger(op.n) || op.n < 0 || op.n >= SKETCH.maxTurns || typeof op.w !== "string" || op.w.length > 20 || !Number.isFinite(op.at)) return this.setAside(op);
      list = "words";
    } else if (op.t === "try") {
      if (!Number.isInteger(op.n) || op.n < 0 || op.n >= SKETCH.maxTurns || typeof op.text !== "string" || op.text.length > 60 || !Number.isFinite(op.at)) return this.setAside(op);
      list = "tries";
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
    if (g.kind === "relay") return this.relay(g);
    if (g.kind === "sketch") return this.sketch(g);
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

  /**
   * 이어 그리기 as it stands: { id, kind, by, at, state: "gathering" | "cancelled" | "playing" | "done",
   * players, start (when the first round begins), rounds, schedule: [{ r, kind: "write" | "draw" |
   * "guess", start, end, done (pages in) }], albumAt, pages: { "book:round": { by, at, text? } },
   * turn (the album shown up to this page; −1 none) }. Book b is player b's; in round r it is with
   * player (b + r). A round ends when every page is in (at the last one's moment) or at its time.
   */
  /**
   * A game for everyone (이어 그리기, 그려서 맞히기) before it begins: who has joined (each person's last
   * answer counts; they stand in the order they first said yes), or cancelled by the asker. Returns the
   * asker's begin once there is one.
   */
  gather(g, out) {
    const byId = (a, b) => cmpId(a.id, b.id);
    const begin = g.begins.filter((b) => b.by === g.by && b.players[0] === g.by).sort(byId)[0];
    if (begin) return begin;
    const replies = g.replies.filter((r) => r.by !== g.by).sort(byId);
    const last = new Map();
    for (const r of replies) last.set(r.by, r.yes);
    for (const r of replies) if (last.get(r.by) && !out.players.includes(r.by)) out.players.push(r.by);
    if (g.quits.some((q) => q.by === g.by)) out.state = "cancelled";
    return null;
  }

  relay(g) {
    const byId = (a, b) => cmpId(a.id, b.id);
    const out = { id: g.id, kind: "relay", by: g.by, at: g.at, state: "gathering", players: [g.by], start: null, rounds: 0, schedule: [], albumAt: null, pages: {}, turn: -1 };
    const begin = this.gather(g, out);
    if (!begin) return out;
    const players = begin.players.slice();
    const P = players.length;
    const R = Math.max(3, Math.min(RELAY.maxRounds, P));
    Object.assign(out, { state: "playing", players, start: begin.at + COUNTDOWN_MS, rounds: R });
    const pages = g.pages.slice().sort(byId);
    let at = out.start;
    for (let r = 0; r < R; r++) {
      const kind = r === 0 ? "write" : r % 2 ? "draw" : "guess";
      const deadline = at + RELAY[kind];
      const got = new Map();
      for (const p of pages) {
        if (p.r !== r || p.at > deadline + RELAY.grace) continue;
        const i = players.indexOf(p.by);
        if (i < 0) continue;
        const book = (((i - r) % P) + P) % P;
        if (!got.has(book)) got.set(book, p);
      }
      let end = deadline;
      if (got.size === P) end = Math.min(deadline, Math.max(at, ...[...got.values()].map((p) => p.at)));
      out.schedule.push({ r, kind, start: at, end, done: got.size });
      for (const [book, p] of got) out.pages[book + ":" + r] = kind === "draw" ? { by: p.by, at: p.at } : { by: p.by, at: p.at, text: cleanText(p.text) };
      at = end + RELAY.gap;
    }
    out.albumAt = at;
    for (const t of g.turns) if (players.includes(t.by) && t.n > out.turn) out.turn = Math.min(t.n, P * R);
    if (out.turn >= P * R) out.state = "done";
    return out;
  }

  /**
   * 그려서 맞히기 as it stands: { id, kind, by, at, state: "gathering" | "cancelled" | "playing", players,
   * start, turns, schedule: [{ n, drawer, options, word, chosen, start, chosenAt, deadline, end,
   * correct: [{ by, at, points }], said: [{ by, at, text? , got? }] }], scores: { member: points }, endAt }.
   * Everyone draws in turn (twice round for two or three people). A turn's word is the drawer's pick, or
   * the first of the three when the picking time runs out; it ends when every guesser has it (at the
   * last one's moment) or at its time, and the next begins after the answer has shown.
   */
  sketch(g) {
    const byId = (a, b) => cmpId(a.id, b.id);
    const out = { id: g.id, kind: "sketch", by: g.by, at: g.at, state: "gathering", players: [g.by], start: null, turns: 0, schedule: [], scores: {}, endAt: null };
    const begin = this.gather(g, out);
    if (!begin) return out;
    const players = begin.players.slice();
    const P = players.length;
    const T = Math.min(SKETCH.maxTurns, P <= 3 ? P * 2 : P);
    Object.assign(out, { state: "playing", players, start: begin.at + COUNTDOWN_MS, turns: T });
    for (const p of players) out.scores[p] = 0;
    const words = g.words.slice().sort(byId);
    const tries = g.tries.slice().sort((a, b) => a.at - b.at || cmpId(a.id, b.id));
    let at = out.start;
    for (let n = 0; n < T; n++) {
      const drawer = players[n % P];
      const options = wordsFor(g.id, n);
      const pick = words.find((w) => w.n === n && w.by === drawer && options.includes(w.w) && w.at <= at + SKETCH.choose + SKETCH.grace);
      const chosenAt = pick ? Math.min(Math.max(pick.at, at), at + SKETCH.choose) : at + SKETCH.choose;
      const word = pick ? pick.w : options[0];
      const deadline = chosenAt + SKETCH.draw;
      const correct = [];
      const said = [];
      const got = new Set();
      for (const t of tries) {
        if (t.n !== n || t.by === drawer || !players.includes(t.by) || got.has(t.by)) continue;
        if (t.at < at - SKETCH.grace || t.at > deadline + SKETCH.grace) continue;
        if (sameWord(word, t.text)) {
          const when = Math.min(deadline, Math.max(chosenAt, t.at));
          const points = Math.round(SKETCH.least + (SKETCH.most - SKETCH.least) * ((deadline - when) / SKETCH.draw));
          got.add(t.by);
          correct.push({ by: t.by, at: when, points });
          said.push({ by: t.by, at: t.at, got: true });
          out.scores[t.by] += points;
          out.scores[drawer] += SKETCH.drawerPoints;
        } else said.push({ by: t.by, at: t.at, text: cleanTry(t.text) });
      }
      const end = P > 1 && got.size === P - 1 ? Math.min(deadline, Math.max(chosenAt, ...correct.map((x) => x.at))) : deadline;
      out.schedule.push({ n, drawer, options, word, chosen: !!pick, start: at, chosenAt, deadline, end, correct, said: said.filter((x) => x.at <= end + SKETCH.grace) });
      at = end + SKETCH.reveal;
    }
    out.endAt = at;
    return out;
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

const cleanText = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, RELAY.maxText);

/** Where an 이어 그리기 is at a moment: countdown, a round (with the time left), between rounds, the album, done. */
export function relayAt(g, now) {
  if (!g || g.kind !== "relay") return { phase: "none" };
  if (g.state === "gathering" || g.state === "cancelled" || g.state === "done") return { phase: g.state };
  if (now < g.start) return { phase: "countdown", left: g.start - now };
  for (const s of g.schedule) {
    if (now < s.start) return { phase: "between", round: s.r, kind: s.kind, until: s.start };
    if (now < s.end) return { phase: "round", round: s.r, kind: s.kind, left: s.end - now, end: s.end };
  }
  if (now < g.albumAt) return { phase: "between", round: g.rounds, kind: "album", until: g.albumAt };
  return { phase: "album", turn: g.turn };
}

/** What m does in round r: { book, round, kind, from (the page it follows, or null) }, or null. */
export function relayTask(g, m, r) {
  const i = g.players.indexOf(m);
  if (i < 0 || !(r >= 0 && r < g.rounds)) return null;
  const P = g.players.length;
  const book = (((i - r) % P) + P) % P;
  return { book, round: r, kind: g.schedule[r].kind, from: r === 0 ? null : { book, round: r - 1 } };
}

/** The drawing of book b in round r (an ink document; no dots, so a database path takes it). */
export function relayDoc(id, b, r) {
  return `k:Q${id}~${b}~${r}`;
}

/** Every book from its first words to its last page: [{ book, round, by, kind, text, given, doc }]. */
export function relayAlbum(g) {
  const out = [];
  const P = g.players.length;
  for (let b = 0; b < P; b++) {
    for (let r = 0; r < g.rounds; r++) {
      const kind = g.schedule[r].kind;
      const page = g.pages[b + ":" + r];
      out.push({ book: b, round: r, by: g.players[(b + r) % P], kind, text: page?.text ?? null, given: !!page, doc: kind === "draw" ? relayDoc(g.id, b, r) : null });
    }
  }
  return out;
}

/** The asker begins 이어 그리기 or 그려서 맞히기 with those who have joined. */
export function beginOps(clock, doc, g, { by, at = Date.now() }) {
  const now = doc.game(g);
  if (!now || !MANY.includes(now.kind)) return { ops: [] };
  clock.atLeast(doc.maxN);
  return { ops: [{ t: "begin", id: clock.next(), g, by, at, players: now.players.slice(0, RELAY.maxPlayers) }] };
}

/** My page for a round: words (a line, a guess) or, for a drawing, nothing (the drawing is in relayDoc). */
export function pageOps(clock, doc, g, { by, round, text, at = Date.now() }) {
  clock.atLeast(doc.maxN);
  const op = { t: "page", id: clock.next(), g, by, r: round, at };
  if (typeof text === "string") op.text = text.slice(0, 400);
  return { ops: [op] };
}

/** The album shown up to page n. */
export function turnOps(clock, doc, g, { by, n }) {
  clock.atLeast(doc.maxN);
  return { ops: [{ t: "turn", id: clock.next(), g, by, n }] };
}

export function quitOps(clock, doc, g, { by }) {
  clock.atLeast(doc.maxN);
  return { ops: [{ t: "quit", id: clock.next(), g, by }] };
}

// ---- 그려서 맞히기 ------------------------------------------------------------------------------------

const cleanTry = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, SKETCH.maxTry);
/** A word as it is compared: no spaces, no marks, one case. */
const plain = (text) => String(text ?? "").normalize("NFC").toLowerCase().replace(/[\s.,!?~'"`·…\-_]/g, "");

/** A guess that is the word (spaces, marks and case aside). */
export function sameWord(word, text) {
  const w = plain(word);
  return w.length > 0 && w === plain(text);
}

/** A guess one syllable off (one wrong, missing or extra): "거의 맞았어요", told only to the one guessing. */
export function nearWord(word, text) {
  const a = [...plain(word)];
  const b = [...plain(text)];
  if (a.length < 2 || !b.length || a.join("") === b.join("")) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  // Levenshtein distance, rows kept.
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length] === 1;
}

// The words of a game: the list shuffled by the game's id (the same on every screen), three a turn.
const decks = new Map();
function seedOf(text) {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
function deckOf(id) {
  let deck = decks.get(id);
  if (deck) return deck;
  let a = seedOf(id);
  const random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  deck = SKETCH_WORDS.slice();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  decks.set(id, deck);
  return deck;
}

/** The three words offered in turn n (none met before in the same game). */
export function wordsFor(id, n) {
  const deck = deckOf(id);
  const k = (n * 3) % (deck.length - 2);
  return deck.slice(k, k + 3);
}

/** The drawing of turn n (an ink document; no dots, so a database path takes it). */
export function sketchDoc(id, n) {
  return `k:G${id}~${n}`;
}

/**
 * The hint as the drawing goes on (f: how far into the drawing time, 0..1): a ○ for each syllable,
 * then each syllable's first sound (초성), then one syllable shown — never the whole of a one-syllable word.
 */
export function sketchHint(word, f) {
  const syl = [...word];
  if (f < 1 / 3) return syl.map((ch) => (/\s/.test(ch) ? "" : "○")).join(" ");
  const cho = syl.map((ch) => initialOf(ch));
  if (f < 2 / 3 || syl.length < 2) return cho.join(" ");
  const k = syl.reduce((sum, ch) => sum + ch.codePointAt(0), 0) % syl.length;
  return cho.map((c, i) => (i === k ? syl[i] : c)).join(" ");
}

/** Where a 그려서 맞히기 is at a moment: countdown, a word being picked, drawing (how far in), the answer, the scores. */
export function sketchAt(g, now) {
  if (!g || g.kind !== "sketch") return { phase: "none" };
  if (g.state !== "playing") return { phase: g.state };
  if (now < g.start) return { phase: "countdown", left: g.start - now };
  for (const s of g.schedule) {
    if (now < s.chosenAt) return { phase: "choose", n: s.n, s, left: s.chosenAt - now, until: s.chosenAt };
    if (now < s.end) return { phase: "draw", n: s.n, s, left: s.end - now, until: s.end, f: (now - s.chosenAt) / SKETCH.draw };
    if (now < s.end + SKETCH.reveal) return { phase: "reveal", n: s.n, s, until: s.end + SKETCH.reveal };
  }
  return { phase: "scores" };
}

/** The drawer's pick of the three words for turn n. */
export function wordOps(clock, doc, g, { by, n, w, at = Date.now() }) {
  clock.atLeast(doc.maxN);
  return { ops: [{ t: "word", id: clock.next(), g, by, n, w: String(w).slice(0, 20), at }] };
}

/** A guess in turn n. */
export function tryOps(clock, doc, g, { by, n, text, at = Date.now() }) {
  clock.atLeast(doc.maxN);
  return { ops: [{ t: "try", id: clock.next(), g, by, n, text: String(text ?? "").slice(0, 60), at }] };
}

