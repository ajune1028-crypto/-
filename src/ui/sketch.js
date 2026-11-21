// 그려서 맞히기 on screen (core/game.js "sketch"; the reference study §4: Skribbl's turns as
// scribble.rs and Skribblrs.io run them, with 초성 hints). Everyone who joins plays; in turn one picks a
// word and draws it — the others watch the line appear as it is drawn (live, as in every drawing) and
// type guesses; wrong ones show to everyone, a right one only as "맞혔어요". The hint grows from ○ to
// 초성 to one syllable. When everyone has it or time is up, the answer shows, and the next one draws.
// At the end, everyone's points.
//
// The screens: gathering (as 이어 그리기), the 3·2·1, picking a word (the drawer; the others wait),
// drawing and guessing, the answer, the scores.

import { h } from "./dom.js";
import { buzz, chime } from "./chime.js";
import { InkLayer, drawInkTools } from "./ink.js";
import { LiveInk } from "./live-ink.js";
import { strokeOps, eraseOps } from "../core/ink.js";
import { getSettings } from "../identity.js";
import { beginOps, quitOps, replyOps, wordOps, tryOps, sketchAt, sketchHint, sketchDoc, nearWord, SKETCH } from "../core/game.js";

const PAGE_W = 2800; // the drawing page in stroke units (hundredths of a rem): 28 × 21 rem, 4:3
const PAGE_H = 2100;

/**
 * ctx: { app, session, doc: () => GameDoc, me: () => member, nameOf, colorOf, commit(made), countdown(g),
 * again() (asks a new one), shut() (puts the game away) }. Returns { draw(g, el), close(), destroy() }.
 */
export function sketchScreen(ctx) {
  const { app, session, nameOf, colorOf, commit } = ctx;
  const me = () => ctx.me();
  let built = null; // what is on screen now, kept while the same thing goes on
  let timer = 0;
  // The room's live lines if it draws (the same presence), or our own.
  const ownLive = !session.liveInk;
  const live = session.liveInk || new LiveInk(session);
  const pen = { tool: "pen", brush: getSettings(app.store).inkBrush || "pen", color: "black", width: 2 };
  const off = session.on("change", ({ doc: name }) => { if (name?.startsWith("k:G")) built?.ink?.render(); });

  function clear() {
    clearTimeout(timer);
    built?.stop?.();
    built?.ink?.destroy();
    built = null;
  }

  function soon(g, ms) {
    clearTimeout(timer);
    timer = setTimeout(() => draw(ctx.doc().game(g.id) || g, built?.el), Math.max(16, ms));
  }

  /** Builds a card once for a key and then only brings it up to date (a line being drawn keeps going). */
  function show(el, key, make, g) {
    if (built?.key === key && built.el === el && built.card?.isConnected) return void built.update?.(g);
    clear();
    const made = make();
    built = { key, el, ...made };
    el.replaceChildren(made.card);
    made.after?.();
  }

  function draw(g, el) {
    if (!el) return;
    const now = Date.now();
    const at = sketchAt(g, now);
    if (at.phase === "countdown") return ctx.countdown(g);
    el.classList.remove("counting");
    if (at.phase === "gathering") return show(el, "gather", () => gathering(g), g);
    if (at.phase === "cancelled") return ctx.shut();
    if (at.phase === "choose") {
      show(el, "choose:" + at.n, () => choosing(g, at), g);
      built.tick?.(at);
      return soon(g, Math.min(500, at.left));
    }
    if (at.phase === "draw") {
      show(el, "draw:" + at.n, () => drawing(g, at), g);
      built.tick?.(at);
      return soon(g, Math.min(500, at.left));
    }
    if (at.phase === "reveal") {
      show(el, "reveal:" + at.n, () => reveal(g, at), g);
      return soon(g, at.until - now);
    }
    return show(el, "scores", () => scores(g), g);
  }

  // ---- parts ------------------------------------------------------------------------------------

  const who = (m) => (m === me() ? "나" : nameOf(m));

  function people(g, done = null) {
    return h("div", { class: "relay-people" }, g.players.map((p) => h("span", { class: "relay-person" + (done && done.has(p) ? " done" : ""), style: { "--c": colorOf(p) } },
      h("span", { class: "relay-dot" }), h("span", { text: who(p) }))));
  }

  function head(g, at, total) {
    const bar = h("div", { class: "relay-time", id: "sketch-time", role: "timer" }, h("span", { class: "relay-time-fill" }));
    const secs = h("span", { class: "relay-secs", id: "sketch-secs" });
    const el = h("div", { class: "relay-head" },
      h("div", { class: "game-head" },
        h("span", { class: "game-title", text: "그려서 맞히기" }),
        h("span", { class: "relay-sub", text: `${at.n + 1} / ${g.turns}` }),
        secs),
      bar);
    const tick = (now) => {
      if (!now.left) return;
      bar.firstChild.style.width = Math.max(0, Math.min(100, (100 * now.left) / total)) + "%";
      bar.classList.toggle("hurry", now.left < 10000);
      secs.textContent = Math.ceil(now.left / 1000) + "초";
      secs.classList.toggle("hurry", now.left < 10000);
    };
    return { el, tick };
  }

  /** The page (28 × 21 rem) scaled to the card's width; the ink layer reads the scale from it. */
  function page(name, editable) {
    const sheet = h("div", { class: "relay-page" + (editable ? "" : " shown"), id: "sketch-page" });
    const wrap = h("div", { class: "relay-page-wrap" }, sheet);
    const mine = [];
    const ink = new InkLayer({
      host: sheet,
      ink: () => session.doc(name),
      share: live.on(name),
      grow: false,
      maxPixels: 2.4e6,
      steady: () => getSettings(app.store).inkSteady ?? 0,
      shapes: () => getSettings(app.store).inkShapes !== false,
      onShape: () => buzz(app),
      onStroke: editable
        ? ({ pts, color, width, size, brush, shape }) => {
            const made = strokeOps(session.clock, session.doc(name), { pts, color, width, size, brush, shape, by: me() });
            session.commit(name, made.ops);
            if (made.ops[0]) mine.push(made.ops[0].id);
            return made.ops[0]?.id;
          }
        : () => null,
      onErase: editable ? (id) => session.commit(name, eraseOps(session.clock, session.doc(name), id).ops) : () => {},
    });
    const fit = () => {
      if (!wrap.isConnected) return;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const k = Math.min(1.25, wrap.clientWidth / ((PAGE_W / 100) * rem));
      sheet.style.transform = `scale(${k})`;
      wrap.style.height = (PAGE_H / 100) * rem * k + "px";
      ink.render();
    };
    session.load(name).then(fit);
    return { wrap, ink, fit, undo: () => { const id = mine.pop(); if (id) session.commit(name, eraseOps(session.clock, session.doc(name), id).ops); } };
  }

  /** What has been said this turn: wrong guesses as typed, right ones only as "맞혔어요". */
  function saidList(s) {
    return s.said.map((x) => h("p", { class: "sketch-line" + (x.got ? " got" : ""), style: { "--c": colorOf(x.by) } },
      h("b", { text: who(x.by) }), x.got ? " 맞혔어요! ✓" : ": " + x.text));
  }

  // ---- the screens --------------------------------------------------------------------------------

  function gathering(g) {
    const asker = g.by === me();
    const whoEl = h("div", { class: "relay-who" });
    const foot = h("div", { class: "game-foot" });
    const card = h("div", { class: "game-card relay-card", id: "sketch-gather" },
      h("div", { class: "game-head" }, h("span", { class: "game-title", text: "그려서 맞히기" }), h("span", { class: "relay-sub", text: "모이는 중" })),
      h("p", { class: "relay-say", text: "한 사람이 그리고 모두 맞혀요. 힌트는 초성으로! 빨리 맞힐수록 점수가 커요." }),
      whoEl, foot);
    const begin = h("button", { class: "chip primary", id: "sketch-begin", type: "button", onclick: () => { commit(beginOps(session.clock, ctx.doc(), g.id, { by: me() })); buzz(app, 12); } });
    foot.append(...(asker
      ? [begin, h("button", { class: "chip", id: "sketch-cancel", type: "button", text: "그만두기", onclick: () => commit(quitOps(session.clock, ctx.doc(), g.id, { by: me() })) })]
      : [h("p", { class: "game-hint", text: `${nameOf(g.by)}님이 시작하면 같이 시작해요` }),
        h("button", { class: "chip", id: "sketch-leave", type: "button", text: "빠지기", onclick: () => { commit(replyOps(session.clock, ctx.doc(), g.id, { by: me(), yes: false })); ctx.shut(); } })]));
    const update = (now) => {
      whoEl.replaceChildren(people(now));
      begin.disabled = now.players.length < 2;
      begin.textContent = now.players.length < 2 ? "친구를 기다려요" : `${now.players.length}명이서 시작`;
    };
    update(g);
    return { card, update };
  }

  function choosing(g, at) {
    const s = at.s;
    const top = head(g, at, SKETCH.choose);
    const parts = [top.el];
    if (s.drawer === me()) {
      parts.push(h("p", { class: "relay-say", text: "그릴 낱말을 골라요" }),
        h("div", { class: "sketch-words", id: "sketch-words" }, s.options.map((w, i) => h("button", { class: "chip sketch-word", id: "sketch-word-" + i, type: "button", data: { word: w }, text: w,
          onclick: (e) => {
            for (const b of e.currentTarget.parentElement.children) b.disabled = true;
            commit(wordOps(session.clock, ctx.doc(), g.id, { by: me(), n: s.n, w }));
            buzz(app, 12);
          } }))));
      chime(app);
    } else {
      parts.push(h("p", { class: "relay-big", text: `${nameOf(s.drawer)}님이 그릴 낱말을 고르는 중` }), board(g));
    }
    const card = h("div", { class: "game-card relay-card sketch-card", id: "sketch-choose" }, ...parts);
    return { card, tick: top.tick };
  }

  function drawing(g, at) {
    const s = at.s;
    const mine = s.drawer === me();
    const name = sketchDoc(g.id, s.n);
    const top = head(g, at, SKETCH.draw);
    const sheet = page(name, mine);
    const said = h("div", { class: "sketch-said", id: "sketch-said", "aria-live": "polite" });
    const parts = [top.el];
    let hint = null;
    let guessBox = null;
    let stopTools = null;
    if (mine) {
      parts.push(h("p", { class: "sketch-mine" }, "이 낱말을 그려요 · ", h("b", { id: "sketch-secret", text: s.word })), sheet.wrap);
      const tools = h("div", { class: "ink-tools relay-tools", id: "sketch-ink-tools" });
      const setTool = (tool) => {
        pen.tool = tool;
        sheet.ink.setTool(tool);
        sheet.ink.setStyle({ color: pen.color, width: pen.width, brush: pen.brush, size: pen.size || null });
        drawInkTools(tools, { pen, setTool, store: app.store, layout: "row" });
      };
      setTool(pen.tool === "pen" || pen.tool?.startsWith("eraser") ? pen.tool : "pen");
      parts.push(tools, h("div", { class: "game-foot" }, h("button", { class: "chip", id: "sketch-undo", type: "button", text: "되돌리기", onclick: () => sheet.undo() })), said);
      stopTools = () => sheet.ink.setTool(null);
    } else {
      hint = h("p", { class: "sketch-hint", id: "sketch-hint", "aria-live": "polite" });
      const near = h("p", { class: "sketch-near", id: "sketch-near" });
      const field = h("input", { class: "input relay-input", id: "sketch-guess", maxlength: SKETCH.maxTry, autocomplete: "off", enterkeyhint: "send", placeholder: "정답은…" });
      const send = () => {
        const text = field.value.trim();
        if (!text) return;
        commit(tryOps(session.clock, ctx.doc(), g.id, { by: me(), n: s.n, text }));
        const word = ctx.doc().game(g.id)?.schedule[s.n]?.word ?? s.word;
        near.textContent = nearWord(word, text) ? "거의 맞았어요!" : "";
        field.value = "";
      };
      field.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) send(); });
      const got = h("p", { class: "sketch-got", id: "sketch-got", hidden: true });
      guessBox = h("div", { class: "sketch-guess" }, field, h("button", { class: "chip primary", id: "sketch-send", type: "button", text: "보내기", onclick: () => send() }));
      parts.push(hint, sheet.wrap, said, near, got, guessBox);
    }
    const card = h("div", { class: "game-card relay-card sketch-card", id: "sketch-draw", data: { mine: String(mine) } }, ...parts);
    let lastSaid = -1;
    const update = (now) => {
      const turn = now.schedule[s.n];
      if (!turn) return;
      if (turn.said.length !== lastSaid) {
        lastSaid = turn.said.length;
        said.replaceChildren(...saidList(turn));
        said.scrollTop = said.scrollHeight;
      }
      const right = turn.correct.find((x) => x.by === me());
      if (!mine && right) {
        const got = card.querySelector("#sketch-got");
        if (got.hidden) {
          got.hidden = false;
          got.textContent = `맞혔어요! +${right.points}`;
          guessBox.hidden = true;
          card.querySelector("#sketch-near").textContent = "";
          buzz(app, 14);
          chime(app);
        }
      }
    };
    const tick = (now) => {
      top.tick(now);
      if (hint) hint.textContent = sketchHint(now.s?.word ?? s.word, now.f ?? 0);
    };
    update(g);
    const onResize = () => sheet.fit();
    addEventListener("resize", onResize);
    if (mine) chime(app);
    return {
      card,
      ink: sheet.ink,
      update,
      tick,
      after: () => { sheet.fit(); if (!mine && !matchMedia("(pointer: coarse)").matches) card.querySelector("#sketch-guess")?.focus({ preventScroll: true }); },
      stop: () => { removeEventListener("resize", onResize); stopTools?.(); },
    };
  }

  function reveal(g, at) {
    const s = at.s;
    const sheet = page(sketchDoc(g.id, s.n), false);
    const got = s.correct.length
      ? h("div", { class: "sketch-said" }, s.correct.map((x) => h("p", { class: "sketch-line got", style: { "--c": colorOf(x.by) } }, h("b", { text: who(x.by) }), ` +${x.points}`)))
      : h("p", { class: "relay-say", text: "아무도 못 맞혔어요" });
    const card = h("div", { class: "game-card relay-card sketch-card", id: "sketch-reveal" },
      h("div", { class: "game-head" }, h("span", { class: "game-title", text: "정답" }), h("span", { class: "relay-sub", text: `${who(s.drawer)}의 그림` })),
      h("p", { class: "sketch-answer", id: "sketch-answer", text: s.word }),
      sheet.wrap, got);
    buzz(app, 8);
    return { card, ink: sheet.ink, after: () => sheet.fit() };
  }

  /** Everyone's points, most first. */
  function board(g) {
    const order = g.players.slice().sort((a, b) => g.scores[b] - g.scores[a] || g.players.indexOf(a) - g.players.indexOf(b));
    return h("ol", { class: "sketch-board", id: "sketch-board" }, order.map((p, i) => h("li", { class: "sketch-score" + (i === 0 && g.scores[p] > 0 ? " first" : ""), style: { "--c": colorOf(p) } },
      h("span", { class: "relay-dot" }), h("span", { class: "sketch-who", text: who(p) }), h("b", { text: String(g.scores[p]) }))));
  }

  function scores(g) {
    const card = h("div", { class: "game-card relay-card sketch-card", id: "sketch-scores" },
      h("div", { class: "game-head" }, h("span", { class: "game-title", text: "점수" }), h("span", { class: "relay-sub", text: "그려서 맞히기" })),
      board(g),
      h("div", { class: "game-foot" },
        h("button", { class: "chip primary", id: "sketch-again", type: "button", text: "한 판 더", onclick: () => { ctx.shut(); ctx.again(); } }),
        h("button", { class: "chip", id: "sketch-close", type: "button", text: "닫기", onclick: () => ctx.shut() })));
    chime(app);
    return { card };
  }

  return { draw, close: clear, destroy: () => { clear(); off(); if (ownLive) live.close(); } };
}
