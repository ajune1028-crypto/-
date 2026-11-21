// 이어 그리기 on screen (core/game.js "relay"; the owner: "인원수가 많아 질 수록 2인용 게임 말고도…
// 갈틱폰의 느낌"). Everyone who joins writes a line, the books pass on, the line is drawn, the books pass
// on, the drawing is put into words, and so on; at the end the album is turned page by page, the same
// page on every screen, so everyone laughs at the same moment. The pages stay in the room's games.
//
// The screens: gathering (who has joined; the asker begins), the 3·2·1, a round (what to do, the time
// running out as a bar, 다 했어요), the books passing on, the album (다음 for everyone), done.
// A drawing is drawn with the room's own brushes into its own ink document (relayDoc), so a reload in
// the middle keeps it; nobody is shown it until the next player gets the book.

import { h } from "./dom.js";
import { buzz, chime } from "./chime.js";
import { InkLayer, drawInkTools } from "./ink.js";
import { strokeOps, eraseOps } from "../core/ink.js";
import { getSettings } from "../identity.js";
import { beginOps, pageOps, turnOps, quitOps, replyOps, relayAt, relayTask, relayDoc, relayAlbum, RELAY } from "../core/game.js";

const WHAT = { write: "한 줄 쓰기", draw: "그리기", guess: "맞히기" };
const SAY = {
  write: "아무거나 한 줄로 써요. 다음 사람이 그려요.",
  draw: "이 말을 그려요. 글자는 쓰지 않기!",
  guess: "이 그림은 뭘까요? 한 줄로 써요.",
};
const EXAMPLES = ["구름 위에서 낮잠 자는 고양이", "우산을 쓴 펭귄", "피아노 치는 문어", "달에서 라면 먹기", "자전거 타는 곰", "춤추는 브로콜리"];
const PAGE_W = 2800; // the drawing page in stroke units (hundredths of a rem): 28 × 21 rem, 4:3
const PAGE_H = 2100;

/**
 * ctx: { app, session, doc: () => GameDoc, me: () => member, nameOf, colorOf, commit(made), again()
 * (asks a new one), shut() (puts the game away) }. Returns { draw(g, el), close() }.
 */
export function relayScreen(ctx) {
  const { app, session, nameOf, colorOf, commit } = ctx;
  const me = () => ctx.me();
  let built = null; // { key, el, … }: what is on screen now, kept while the same thing goes on
  let timer = 0;
  const views = new Map(); // ink documents shown (read-only), by name: { ink }
  const pen = { tool: "pen", brush: getSettings(app.store).inkBrush || "pen", color: "black", width: 2 };
  // A drawing may come in after the page that says it is done (two documents): drawn again then.
  const off = session.on("change", ({ doc: name }) => { if (name?.startsWith("k:Q")) views.get(name)?.ink.render(); });

  function clear() {
    clearTimeout(timer);
    built?.stop?.();
    for (const v of views.values()) v.ink.destroy();
    views.clear();
    built = null;
  }

  function soon(g, ms) {
    clearTimeout(timer);
    timer = setTimeout(() => draw(ctx.doc().game(g.id) || g, built?.el), Math.max(16, ms));
  }

  function people(g, done = null) {
    return h("div", { class: "relay-people" }, g.players.map((p) => h("span", { class: "relay-person" + (done && done.has(p) ? " done" : ""), style: { "--c": colorOf(p) } },
      h("span", { class: "relay-dot" }), h("span", { text: p === me() ? "나" : nameOf(p) }))));
  }

  /** A drawing shown as it was drawn (the album, the one to guess). */
  function drawing(name) {
    const page = h("div", { class: "relay-page shown", "aria-label": "그림" });
    const wrap = h("div", { class: "relay-page-wrap" }, page);
    let entry = views.get(name);
    if (entry) entry.ink.destroy();
    const ink = new InkLayer({ host: page, ink: () => session.doc(name), onStroke: () => null, onErase: () => {}, grow: false, maxPixels: 2.4e6 });
    views.set(name, { ink });
    session.load(name).then(() => fit(wrap, page, ink));
    requestAnimationFrame(() => fit(wrap, page, ink));
    return wrap;
  }

  /** The page (28 × 21 rem) scaled to the card's width; the ink layer reads the scale from it. */
  function fit(wrap, page, ink) {
    if (!wrap.isConnected) return;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const k = Math.min(1.25, wrap.clientWidth / ((PAGE_W / 100) * rem));
    page.style.transform = `scale(${k})`;
    wrap.style.height = (PAGE_H / 100) * rem * k + "px";
    ink?.render();
  }

  // ---- the screens --------------------------------------------------------------------------------

  function draw(g, el) {
    if (!el) return;
    const now = Date.now();
    const at = relayAt(g, now);
    if (at.phase === "countdown") return ctx.countdown(g);
    el.classList.remove("counting");
    if (at.phase === "gathering") return show(el, "gather", () => gathering(g), g);
    if (at.phase === "cancelled") return ctx.shut();
    if (at.phase === "round") {
      const task = relayTask(g, me(), at.round);
      if (!task) return ctx.shut();
      const mine = g.pages[task.book + ":" + task.round];
      if (mine) show(el, `wait:${at.round}`, () => waiting(g, at), g);
      else show(el, `round:${at.round}`, () => roundCard(g, at, task), g);
      built.tick?.(at);
      return soon(g, Math.min(1000, at.left));
    }
    if (at.phase === "between") {
      show(el, "between:" + at.round, () => between(at), g);
      return soon(g, at.until - now);
    }
    if (at.phase === "album" || at.phase === "done") return show(el, "album", () => album(g), g);
  }

  /**
   * Builds a card once for a key and then only brings it up to date (update(g)): the card does not
   * come in again each time someone hands in or a page is turned, and a finger drawing on it keeps
   * its line.
   */
  function show(el, key, make, g) {
    if (built?.key === key && built.el === el && built.card?.isConnected) return void built.update?.(g);
    clear();
    const made = make();
    built = { key, el, ...made };
    el.replaceChildren(made.card);
    made.after?.();
  }

  function gathering(g) {
    const asker = g.by === me();
    const who = h("div", { class: "relay-who" });
    const foot = h("div", { class: "game-foot" });
    const card = h("div", { class: "game-card relay-card", id: "relay-gather" },
      h("div", { class: "game-head" }, h("span", { class: "game-title", text: "이어 그리기" }), h("span", { class: "relay-sub", text: "모이는 중" })),
      h("p", { class: "relay-say", text: "한 줄 → 그림 → 한 줄 … 차례로 넘겨요. 마지막에 다 같이 앨범을 넘겨 봐요." }),
      who, foot);
    const begin = h("button", { class: "chip primary", id: "relay-begin", type: "button", onclick: () => { commit(beginOps(session.clock, ctx.doc(), g.id, { by: me() })); buzz(app, 12); } });
    foot.append(...(asker
      ? [begin, h("button", { class: "chip", id: "relay-cancel", type: "button", text: "그만두기", onclick: () => commit(quitOps(session.clock, ctx.doc(), g.id, { by: me() })) })]
      : [h("p", { class: "game-hint", text: `${nameOf(g.by)}님이 시작하면 같이 시작해요` }),
        h("button", { class: "chip", id: "relay-leave", type: "button", text: "빠지기", onclick: () => { commit(replyOps(session.clock, ctx.doc(), g.id, { by: me(), yes: false })); ctx.shut(); } })]));
    const update = (now) => {
      who.replaceChildren(people(now));
      begin.disabled = now.players.length < 2;
      begin.textContent = now.players.length < 2 ? "친구를 기다려요" : `${now.players.length}명이서 시작`;
    };
    update(g);
    return { card, update };
  }

  function between(at) {
    const last = at.kind === "album";
    const card = h("div", { class: "game-card relay-card relay-between", id: "relay-between" },
      h("div", { class: "relay-pass", "aria-hidden": "true" }, h("span", { class: "relay-book" })),
      h("p", { class: "relay-big", text: last ? "다 됐어요! 앨범을 펼쳐요" : "옆 사람에게 넘겨요" }));
    buzz(app, 8);
    return { card };
  }

  function waiting(g, at) {
    const say = h("p", { class: "relay-say" });
    const who = h("div", { class: "relay-who" });
    const card = h("div", { class: "game-card relay-card", id: "relay-wait" },
      head(g, at),
      h("p", { class: "relay-big", text: "넘겼어요 ✓" }),
      say, who);
    const bar = card.querySelector(".relay-time");
    const update = (now) => {
      const done = new Set(Object.entries(now.pages).filter(([k]) => k.endsWith(":" + at.round)).map(([, p]) => p.by));
      say.textContent = `다른 사람을 기다려요 (${done.size}/${now.players.length})`;
      who.replaceChildren(people(now, done));
    };
    update(g);
    return { card, update, tick: (now) => tickBar(bar, now) };
  }

  function head(g, at) {
    const bar = h("div", { class: "relay-time", id: "relay-time", role: "timer" }, h("span", { class: "relay-time-fill" }));
    return h("div", { class: "relay-head" },
      h("div", { class: "game-head" },
        h("span", { class: "game-title", text: WHAT[at.kind] }),
        h("span", { class: "relay-sub", text: `${at.round + 1} / ${g.rounds}` }),
        h("span", { class: "relay-secs", id: "relay-secs" })),
      bar);
  }

  function tickBar(bar, at) {
    if (!bar || !at.left) return;
    const total = RELAY[at.kind];
    bar.firstChild.style.width = Math.max(0, Math.min(100, (100 * at.left) / total)) + "%";
    bar.classList.toggle("hurry", at.left < 10000);
    const secs = bar.parentElement?.querySelector(".relay-secs");
    if (secs) {
      secs.textContent = Math.ceil(at.left / 1000) + "초";
      secs.classList.toggle("hurry", at.left < 10000);
    }
  }

  /** My turn: a line, a drawing, a guess. Handed in by 다 했어요 or, when time runs out, as it is. */
  function roundCard(g, at, task) {
    const from = task.from ? g.pages[task.from.book + ":" + task.from.round] : null;
    let sent = false;
    const hand = (text) => {
      if (sent) return;
      sent = true;
      commit(pageOps(session.clock, ctx.doc(), g.id, { by: me(), round: task.round, text: task.kind === "draw" ? undefined : String(text ?? "") }));
      buzz(app, 14);
    };
    const parts = [head(g, at)];
    let field = null;
    let stopInk = null;
    let fitPage = null;
    if (task.kind === "draw") {
      const given = from?.text;
      parts.push(h("p", { class: "relay-say", text: given ? SAY.draw : "앞 사람이 비워 뒀어요. 마음대로 그려요." }),
        given && h("p", { class: "relay-given", id: "relay-given", text: given }));
      const name = relayDoc(g.id, task.book, task.round);
      const page = h("div", { class: "relay-page", id: "relay-page" });
      const wrap = h("div", { class: "relay-page-wrap" }, page);
      const tools = h("div", { class: "ink-tools relay-tools", id: "relay-ink-tools" });
      const mineIds = [];
      const ink = new InkLayer({
        host: page,
        ink: () => session.doc(name),
        grow: false,
        maxPixels: 2.4e6,
        steady: () => getSettings(app.store).inkSteady ?? 1,
        shapes: () => getSettings(app.store).inkShapes !== false,
        onShape: () => buzz(app),
        onStroke: ({ pts, color, width, size, brush, shape }) => {
          const made = strokeOps(session.clock, session.doc(name), { pts, color, width, size, brush, shape, by: me() });
          session.commit(name, made.ops);
          if (made.ops[0]) mineIds.push(made.ops[0].id);
          return made.ops[0]?.id;
        },
        onErase: (id) => session.commit(name, eraseOps(session.clock, session.doc(name), id).ops),
      });
      const setTool = (tool) => {
        pen.tool = tool;
        ink.setTool(tool);
        ink.setStyle({ color: pen.color, width: pen.width, brush: pen.brush, size: pen.size || null });
        drawInkTools(tools, { pen, setTool, store: app.store, layout: "row" });
      };
      const undo = h("button", { class: "chip", id: "relay-undo", type: "button", text: "되돌리기",
        onclick: () => { const id = mineIds.pop(); if (id) session.commit(name, eraseOps(session.clock, session.doc(name), id).ops); } });
      parts.push(wrap, tools, h("div", { class: "game-foot" }, undo, h("button", { class: "chip primary", id: "relay-done", type: "button", text: "다 했어요", onclick: () => hand() })));
      session.load(name).then(() => ink.render());
      setTool(pen.tool === "pen" || pen.tool?.startsWith("eraser") ? pen.tool : "pen");
      fitPage = () => fit(wrap, page, ink);
      stopInk = () => ink.destroy();
    } else {
      if (task.kind === "guess") {
        parts.push(h("p", { class: "relay-say", text: from ? SAY.guess : "앞 사람이 그림을 비워 뒀어요. 떠오르는 대로 써요." }),
          drawing(relayDoc(g.id, task.from.book, task.from.round)));
      } else parts.push(h("p", { class: "relay-say", text: SAY.write }));
      field = h("input", { class: "input relay-input", id: "relay-text", maxlength: RELAY.maxText, autocomplete: "off", enterkeyhint: "done",
        placeholder: task.kind === "write" ? "예: " + EXAMPLES[(g.players.indexOf(me()) + g.id.length) % EXAMPLES.length] : "이건… ",
        onkeydown: (e) => { if (e.key === "Enter" && field.value.trim()) hand(field.value); } });
      parts.push(field, h("div", { class: "game-foot" }, h("button", { class: "chip primary", id: "relay-done", type: "button", text: "다 했어요", onclick: () => hand(field.value) })));
    }
    const card = h("div", { class: "game-card relay-card relay-round", id: "relay-round", data: { kind: task.kind } }, ...parts.filter(Boolean));
    const bar = card.querySelector(".relay-time");
    // Time is up: handed in as it is (a line half written, a drawing half drawn), a moment before the end.
    const auto = setTimeout(() => hand(field?.value), Math.max(0, at.end - Date.now() - 400));
    chime(app);
    const onResize = () => fitPage?.();
    addEventListener("resize", onResize);
    return {
      card,
      tick: (now) => tickBar(bar, now),
      after: () => { fitPage?.(); if (field && !matchMedia("(pointer: coarse)").matches) field.focus({ preventScroll: true }); },
      stop: () => { clearTimeout(auto); removeEventListener("resize", onResize); stopInk?.(); },
    };
  }

  /**
   * The album: each book from its first line to its last page, turned for everyone by anyone's 다음.
   * One card; each page turned comes in at the bottom (a new book starts the list again).
   */
  function album(g) {
    const sub = h("span", { class: "relay-sub" });
    const intro = h("p", { class: "relay-big", text: "누가 넘기든 모두에게 같이 넘어가요" });
    const list = h("div", { class: "relay-album", id: "relay-album" });
    const foot = h("div", { class: "game-foot" });
    const card = h("div", { class: "game-card relay-card relay-album-card", id: "relay-album-card" },
      h("div", { class: "game-head" }, h("span", { class: "game-title", text: "앨범" }), sub), intro, list, foot);
    let book = -1;
    let count = 0;
    let state = "";
    const entry = (p) => h("div", { class: "relay-entry", data: { kind: p.kind }, style: { "--c": colorOf(p.by) } },
      h("span", { class: "relay-entry-who" }, h("span", { class: "relay-dot" }), p.by === me() ? "나" : nameOf(p.by)),
      p.kind === "draw" ? drawing(p.doc) : h("p", { class: "relay-entry-text", text: p.text || "(비워 둠)" }));
    const update = (now) => {
      const pages = relayAlbum(now);
      const upTo = Math.min(now.turn, pages.length - 1);
      const current = upTo < 0 ? 0 : pages[upTo].book;
      if (current !== book) {
        list.replaceChildren();
        book = current;
        count = 0;
      }
      const inBook = pages.filter((p, i) => p.book === current && i <= upTo);
      const fresh = inBook.slice(count).map((p) => {
        const el = entry(p);
        if (count) el.classList.add("arrived");
        return el;
      });
      list.append(...fresh);
      count = inBook.length;
      intro.hidden = upTo >= 0;
      list.hidden = upTo < 0;
      const owner = now.players[current];
      sub.textContent = upTo < 0 ? "펼쳐요" : `${owner === me() ? "내" : nameOf(owner) + "의"} 책 · ${current + 1}/${now.players.length}`;
      const next = upTo + 1;
      const key = now.state + ":" + next;
      if (key !== state) {
        state = key;
        foot.replaceChildren(...(now.state === "done"
          ? [h("button", { class: "chip primary", id: "relay-again", type: "button", text: "한 판 더", onclick: () => { ctx.shut(); ctx.again(); } }),
            h("button", { class: "chip", id: "relay-close", type: "button", text: "닫기", onclick: () => ctx.shut() })]
          : [h("button", { class: "chip primary", id: "relay-next", type: "button", text: upTo < 0 ? "첫 장" : next >= pages.length ? "끝" : pages[next].book !== current ? "다음 책" : "다음",
              onclick: () => { commit(turnOps(session.clock, ctx.doc(), now.id, { by: me(), n: next })); buzz(app, 8); } }),
            h("button", { class: "chip", id: "relay-close", type: "button", text: "닫기", onclick: () => ctx.shut() })]));
      }
      const last = fresh.at(-1);
      if (last) requestAnimationFrame(() => last.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
    };
    update(g);
    return { card, update };
  }

  return { draw, close: clear, destroy: () => { clear(); off(); } };
}
