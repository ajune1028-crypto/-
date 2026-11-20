// 미니게임 in any room (the owner: "방 안에서 친구랑 잠깐… 미니게임 신청… 친구가 수락하면 전체가 조금
// 불투명하게 바뀌고 가운데 3, 2, 1… 카운트가 끝났을 때 미니게임이 뜨게", "홈에서 끄는 기능도").
// From the reference study §4 (Discord's activities, iMessage games, Kahoot's countdown): one
// invitation from the room's top bar; the friend gets a small card at the top (수락 · 다음에) that
// covers nothing; on 수락 both screens dim a little and count 3·2·1 together, then the game. Games
// are short: 가위바위보 (picked during the count, shown together at "보!") and 오목 (turns, the five
// in a row lit like neon). The result stays in the room (the tally between two people). 설정's
// 미니게임 off hides the button and lets no invitation in.

import { h, icon, toast } from "./dom.js";
import { buzz, chime } from "./chime.js";
import { getSettings } from "../identity.js";
import { askOps, replyOps, pickOps, stoneOps, quitOps, OMOK_SIZE, RPS } from "../core/game.js";
import { memberColor } from "../core/paint.js";
import { currentTheme } from "./theme.js";

const GAMES = [["rps", "가위바위보", "✊✋✌️"], ["omok", "오목", "⚫⚪"]];
const RPS_FACE = { rock: "✊", paper: "✋", scissors: "✌️" };
const RPS_NAME = { rock: "바위", paper: "보", scissors: "가위" };
const STALE_MS = 2 * 60 * 1000; // an invitation older than this is not shown

export const gamesOn = (store) => getSettings(store).games !== false;

/**
 * Mounts the games for a room. Returns { button, close }: the button goes in the room's top bar
 * (null when games are off in 설정).
 */
export function mountGames(app, session) {
  const me = () => session.memberId;
  let doc = null;
  let shown = null; // the game on screen: { id, el, timer }
  let invite = null; // the invitation card: { id, el }
  let closeMenu = null;
  const seenAsks = new Set(); // asks that were already there when the room opened
  const button = gamesOn(app.store)
    ? h("button", { class: "icon-btn game-btn", id: "room-game", type: "button", "aria-label": "미니게임 (친구와 잠깐)", onclick: () => openMenu() }, icon("game"))
    : null;

  const nameOf = (m) => session.room.member(m)?.name || "친구";
  const colorOf = (m) => {
    const member = session.room.member(m);
    return member ? memberColor(member.color, currentTheme()) : "#8c919c";
  };
  const friendsHere = () => (session.peers || []).filter((p) => !p.isMe && p.state?.m && p.state.m !== me()).map((p) => p.state.m);

  function commit(made) {
    if (!made?.ops?.length || session.transport.readOnly) return false;
    session.commit("game", made.ops);
    return true;
  }

  // ---- the menu: which game ---------------------------------------------------------------------

  function openMenu() {
    if (!doc) return;
    closeMenu?.();
    const friend = friendsHere()[0];
    const menu = h("div", { class: "game-menu", id: "game-menu", role: "menu" },
      h("p", { class: "game-menu-title", text: friend ? `${nameOf(friend)}님과 잠깐` : "친구가 들어오면 같이 해요" }),
      ...GAMES.map(([kind, name, faces]) => h("button", { class: "game-pick", type: "button", data: { game: kind }, disabled: !friend, onclick: () => { close(); ask(kind); } },
        h("span", { class: "game-faces", text: faces }), h("span", { text: name }))),
      friend && tallyLine(friend));
    document.body.append(menu);
    const r = button.getBoundingClientRect();
    menu.style.top = r.bottom + 8 + "px";
    menu.style.right = Math.max(8, innerWidth - r.right) + "px";
    const away = (e) => { if (!menu.contains(e.target) && !button.contains(e.target)) close(); };
    setTimeout(() => window.addEventListener("pointerdown", away, true), 0);
    function close() {
      window.removeEventListener("pointerdown", away, true);
      menu.remove();
      if (closeMenu === close) closeMenu = null;
    }
    closeMenu = close;
  }

  function tallyLine(friend) {
    const t = doc.tally(me(), friend);
    const total = t[me()] + t[friend] + t.draws;
    if (!total) return null;
    return h("p", { class: "game-tally", id: "game-tally", text: `기록: 나 ${t[me()]} · ${nameOf(friend)} ${t[friend]}${t.draws ? ` · 비김 ${t.draws}` : ""}` });
  }

  function ask(kind) {
    const made = askOps(session.clock, doc, { kind, by: me() });
    if (commit(made)) toast(app.root, `${GAMES.find(([k]) => k === kind)[1]}를 신청했어요. 친구가 받으면 시작해요`);
  }

  // ---- an invitation from a friend: a small card at the top ---------------------------------------

  function showInvite(g) {
    if (invite?.id === g.id) return;
    invite?.el.remove();
    const name = GAMES.find(([k]) => k === g.kind)?.[1] || "게임";
    const el = h("div", { class: "game-invite", id: "game-invite", role: "alertdialog", "aria-label": "미니게임 신청" },
      h("span", { class: "game-invite-dot", style: { background: colorOf(g.by) } }),
      h("span", { class: "game-invite-text", text: `${nameOf(g.by)}님이 ${name}를 신청했어요` }),
      h("button", { class: "chip primary", id: "game-accept", type: "button", text: "수락", onclick: () => answer(g.id, true) }),
      h("button", { class: "chip", id: "game-decline", type: "button", text: "다음에", onclick: () => answer(g.id, false) }));
    document.body.append(el);
    invite = { id: g.id, el };
    buzz(app, 12);
  }

  function answer(id, yes) {
    invite?.el.remove();
    invite = null;
    commit(replyOps(session.clock, doc, id, { by: me(), yes }));
  }

  // ---- the game on screen ------------------------------------------------------------------------

  function open(g) {
    if (shown?.id === g.id) return void draw(g);
    shown?.el.remove();
    const el = h("div", { class: "game-layer", id: "game-layer", role: "dialog", "aria-label": "미니게임" });
    document.body.append(el);
    shown = { id: g.id, el, counted: false, timer: 0 };
    draw(g);
  }

  function shut() {
    if (!shown) return;
    clearTimeout(shown.timer);
    shown.el.remove();
    shown = null;
  }

  /** The 3·2·1 until the shared start, then the game itself. */
  function draw(g) {
    if (!shown) return;
    const el = shown.el;
    const left = g.start - Date.now();
    if (g.state === "playing" && left > 0) {
      const n = Math.ceil(left / 1000);
      // While counting, 가위바위보 can already be chosen (a hand made ready before "보!").
      el.replaceChildren(h("div", { class: "game-count", id: "game-count", text: n > 3 ? "3" : String(n) }), g.kind === "rps" ? rpsBoard(g, true) : null);
      shown.card = null;
      el.classList.add("counting");
      if (shown.lastCount !== n) {
        shown.lastCount = n;
        buzz(app, 10);
      }
      clearTimeout(shown.timer);
      shown.timer = setTimeout(() => draw(doc.game(g.id) || g), Math.min(250, left));
      return;
    }
    el.classList.remove("counting");
    if (!shown.counted && g.state === "playing") {
      shown.counted = true;
      chime(app);
    }
    const head = h("div", { class: "game-head" },
      h("span", { class: "game-title", text: GAMES.find(([k]) => k === g.kind)?.[1] || "" }),
      g.players.map((p) => h("span", { class: "game-who", style: { "--c": colorOf(p) }, text: nameOf(p) })));
    const foot = h("div", { class: "game-foot" },
      g.state === "done"
        ? [h("p", { class: "game-result", id: "game-result", text: resultText(g) }),
          h("button", { class: "chip primary", id: "game-again", type: "button", text: "한 판 더", onclick: () => { shut(); ask(g.kind); } }),
          h("button", { class: "chip", id: "game-close", type: "button", text: "닫기", onclick: () => shut() })]
        : h("button", { class: "chip", id: "game-quit", type: "button", text: "그만하기", onclick: () => commit(quitOps(session.clock, doc, g.id, { by: me() })) }));
    // The card stays while the game goes on (only what changed inside it is made again).
    if (!shown.card || !shown.card.isConnected) {
      shown.card = h("div", { class: "game-card" });
      el.replaceChildren(shown.card);
    }
    shown.card.replaceChildren(head, g.kind === "rps" ? rpsBoard(g, false) : omokBoard(g), foot);
  }

  function resultText(g) {
    if (g.left) return `${nameOf(g.left)}님이 나갔어요. ${nameOf(g.winner)} 승`;
    if (g.draw) return "비겼어요";
    return `${g.winner === me() ? "이겼어요!" : nameOf(g.winner) + "님 승"}`;
  }

  // 가위바위보: three hands; the friend's stays hidden until both have chosen.
  function rpsBoard(g, counting) {
    const mine = g.picks[me()];
    const other = g.players.find((p) => p !== me());
    const both = g.state === "done";
    return h("div", { class: "rps" },
      h("div", { class: "rps-faces" },
        h("span", { class: "rps-face", id: "rps-mine", text: mine ? RPS_FACE[mine] : "❔" }),
        h("span", { class: "rps-vs", text: "vs" }),
        h("span", { class: "rps-face", id: "rps-theirs", text: both ? RPS_FACE[g.picks[other]] : g.picks[other] ? "✔︎" : "…" })),
      !mine && g.players.includes(me()) && h("div", { class: "rps-hands" }, RPS.map((v) => h("button", { class: "rps-hand", type: "button", data: { hand: v }, "aria-label": RPS_NAME[v],
        onclick: () => { commit(pickOps(session.clock, doc, g.id, { by: me(), v })); buzz(app, 8); } }, h("span", { text: RPS_FACE[v] }), h("small", { text: RPS_NAME[v] })))),
      counting && h("p", { class: "game-hint", text: "'보!' 하면 같이 펼쳐요" }));
  }

  // 오목: a 15 × 15 board; the asker's stones dark, the other's light, each ringed in the person's
  // colour. Made once per game and changed in place: a finger may be on a point as a stone arrives.
  function omokBoard(g) {
    const size = OMOK_SIZE;
    if (!shown.board) {
      const grid = h("div", { class: "omok", id: "omok", style: { "--n": size } });
      const cells = [];
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const cell = h("button", { class: "omok-cell", type: "button", data: { x: String(x), y: String(y) }, "aria-label": `${x + 1}, ${y + 1}`,
          onclick: () => { const now = doc.game(shown?.id); if (now) { commit(stoneOps(session.clock, doc, now.id, { by: me(), x, y })); buzz(app, 6); } } });
        cells.push(cell);
        grid.append(cell);
      }
      const turnLine = h("p", { class: "game-turn", id: "game-turn" });
      shown.board = { el: h("div", { class: "omok-wrap" }, turnLine, grid), cells, turnLine };
    }
    const { el, cells, turnLine } = shown.board;
    const turn = g.players[g.stones.length % 2];
    const mineTurn = g.state === "playing" && turn === me();
    const lit = new Set(g.line.map(([x, y]) => x + "," + y));
    const last = g.stones.at(-1);
    const at = new Map(g.stones.map((s) => [s.x + "," + s.y, s]));
    cells.forEach((cell, i) => {
      const x = i % size;
      const y = Math.floor(i / size);
      const s = at.get(x + "," + y);
      cell.disabled = !mineTurn || !!s;
      const cls = s ? "omok-stone" + (s.by === g.players[0] ? " dark" : " light") + (lit.has(x + "," + y) ? " lit" : "") + (last && last.x === x && last.y === y ? " last" : "") : "";
      const stone = cell.firstChild;
      if (!s) { if (stone) stone.remove(); return; }
      if (!stone) cell.append(h("span", { class: cls, style: { "--c": colorOf(s.by) } }));
      else if (stone.className !== cls) stone.className = cls;
    });
    turnLine.textContent = g.state === "playing" ? (mineTurn ? "내 차례" : `${nameOf(turn)}님 차례`) : "";
    return el;
  }

  // ---- following the room's games ----------------------------------------------------------------

  function look() {
    if (!doc) return;
    const now = Date.now();
    let mine = null;
    let asked = null;
    for (const g of doc.list()) {
      if (g.state === "playing" && g.players.includes(me())) mine = g;
      else if (g.state === "done" && shown?.id === g.id) mine = g;
      else if (g.state === "asked" && g.by !== me() && !seenAsks.has(g.id) && now - g.at < STALE_MS) asked = g;
    }
    if (asked && gamesOn(app.store) && !mine) showInvite(asked);
    else if (invite && (!asked || asked.id !== invite.id)) {
      invite.el.remove();
      invite = null;
    }
    if (mine) open(mine);
  }

  const offs = [];
  session.load("game").then(() => {
    doc = session.doc("game");
    for (const g of doc.list()) seenAsks.add(g.state === "asked" ? g.id : "");
    offs.push(session.on("change", ({ doc: name }) => { if (name === "game") look(); }));
    look();
  });

  return {
    button,
    close() {
      for (const off of offs) off();
      closeMenu?.();
      invite?.el.remove();
      shut();
    },
  };
}
