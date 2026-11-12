// The scenarios. Each gets `open({dev, hash, width, height, dark})` → page.
// `dev` is a pretend device: its own storage for "who am I", shared room data.

import assert from "node:assert/strict";

export const scenarios = [];
const scenario = (name, run) => scenarios.push({ name, run });
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const click = (page, sel) => page.eval(`(() => { const el = ${q(sel)}; if (!el) throw new Error("no element ${sel.replace(/"/g, "'")}"); el.click(); return true; })()`);
const fill = async (page, sel, text) => {
  await page.eval(`(() => { const el = ${q(sel)}; if (!el) throw new Error("no element ${sel.replace(/"/g, "'")}"); el.focus(); el.select && el.select(); return true; })()`);
  await page.type(text);
};
const text = (page, sel) => page.eval(`${q(sel)}?.textContent ?? null`);

/** Creates a daily text room on the page and waits until it is open. Returns the room id. */
export async function createRoom(page, { room = "우리 방", name = "가람", pin = "" } = {}) {
  await click(page, "#add-daily");
  await click(page, '[data-kind="daily-text"]');
  await fill(page, "#room-name", room);
  await fill(page, "#my-name", name);
  if (pin) await fill(page, "#my-pin", pin);
  await click(page, "#create-room");
  await page.waitFor(`location.hash.startsWith("#r-") && ${q("#room-title")}`);
  return page.eval("location.hash.slice(3)");
}

/** Joins the open room as a new person. */
export async function joinNew(page, { name = "나래", pin = "" } = {}) {
  await page.waitFor(q("#join-name"));
  await fill(page, "#join-name", name);
  if (pin) await fill(page, "#join-pin", pin);
  await click(page, "#enter");
  await page.waitFor(q("#room-title"));
}

const myColor = (page) => page.eval(`window.__app.session?.me?.color ?? null`);

scenario("home: both halves fit a 360-wide screen", async ({ open, out }) => {
  for (const dark of [false, true]) {
    const page = await open({ dark });
    await page.waitFor(q("#home"));
    const m = await page.eval(`(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { daily: r('[data-side="daily"]').width, creative: r('[data-side="creative"]').width, scroll: document.documentElement.scrollWidth, inner: innerWidth,
        titles: [...document.querySelectorAll(".half-title")].map((e) => e.textContent) };
    })()`);
    assert.equal(m.inner, 360);
    assert.ok(m.scroll <= 360, "no sideways scroll: " + m.scroll);
    assert.ok(Math.abs(m.daily - 180) <= 1 && Math.abs(m.creative - 180) <= 1, JSON.stringify(m));
    assert.deepEqual(m.titles, ["일상", "창작"]);
    await page.shot(out(dark ? "home-empty-dark.png" : "home-empty-light.png"));
  }
});

scenario("create: a text room opens and is listed on home afterwards", async ({ open, out }) => {
  const page = await open();
  const id = await createRoom(page, { room: "우리 둘", name: "가람" });
  assert.match(id, /^[a-z2-7]{12}$/);
  assert.equal(await text(page, "#room-title"), "우리 둘");
  assert.equal(await page.eval("window.__app.session.me.name"), "가람");
  await click(page, "#back");
  await page.waitFor(`${q('[data-side="daily"] .room-row')}`);
  assert.equal(await text(page, '[data-side="daily"] .room-row .room-name'), "우리 둘");
  await page.shot(out("home-light.png"));
  await click(page, '[data-side="daily"] .room-row');
  await page.waitFor(q("#room-title"));
  assert.equal(await page.eval("location.hash"), "#r-" + id);
});

scenario("create: an empty room name or a bad code is refused with a reason", async ({ open }) => {
  const page = await open();
  await click(page, "#add-daily");
  await click(page, '[data-kind="daily-text"]');
  await click(page, "#create-room");
  assert.equal(await text(page, "#form-error"), "방 이름을 적어 주세요.");
  await fill(page, "#room-name", "방");
  await fill(page, "#my-name", "가람");
  await fill(page, "#my-pin", "12");
  await click(page, "#create-room");
  assert.equal(await text(page, "#form-error"), "개인 식별 코드는 숫자 5자리예요.");
  assert.equal(await page.eval("location.hash"), "");
});

scenario("create: the creative side and unfinished kinds say 준비 중", async ({ open }) => {
  const page = await open();
  await click(page, "#add-creative");
  const kinds = await page.eval(`[...document.querySelectorAll(".kind")].map((b) => [b.dataset.kind, b.disabled, b.querySelector(".soon")?.textContent ?? ""])`);
  assert.deepEqual(kinds, [["creative-song", true, "준비 중"], ["creative-writing", true, "준비 중"], ["creative-board", true, "준비 중"]]);
});

scenario("second device: finds the room, joins as a new person with another colour", async ({ open }) => {
  const a = await open({ dev: "a" });
  const id = await createRoom(a, { room: "같이 쓰는 방" });
  const b = await open({ dev: "b" });
  await b.waitFor(q("#others .room-row"));
  assert.equal(await text(b, "#others .room-row .room-name"), "같이 쓰는 방");
  await click(b, "#others .room-row");
  await joinNew(b, { name: "나래" });
  assert.equal(await b.eval("location.hash"), "#r-" + id);
  assert.equal(await myColor(a), 0);
  assert.equal(await myColor(b), 1);
  await a.waitFor(`window.__app.session.room.members().length === 2`);
  await a.waitFor(`document.querySelectorAll("#people .dot").length === 2`);
});

scenario("code: a room opens by typing its code", async ({ open }) => {
  const a = await open({ dev: "a" });
  const id = await createRoom(a);
  const b = await open({ dev: "b" });
  await click(b, "#by-code");
  await fill(b, "#code", "zzzzzzzzzzzz");
  await click(b, "#open-code");
  assert.equal(await text(b, "#form-error"), "그 코드의 방을 찾을 수 없어요.");
  await fill(b, "#code", id.toUpperCase() + " ");
  await click(b, "#open-code");
  await b.waitFor(q("#join-name"));
});

scenario("returning: the right code makes another device the same person", async ({ open }) => {
  const a = await open({ dev: "a" });
  const id = await createRoom(a, { name: "가람", pin: "24680" });
  const c = await open({ dev: "c", hash: "r-" + id });
  await c.waitFor(q("#join-back"));
  await click(c, "#join-back");
  await c.waitFor(q(".who"));
  assert.equal(await text(c, ".who .who-name"), "가람");
  await click(c, ".who");
  await fill(c, "#back-pin", "11111");
  await click(c, "#enter");
  await c.waitFor(`${q("#form-error")}?.textContent === "코드가 맞지 않아요."`);
  await fill(c, "#back-pin", "24680");
  await click(c, "#enter");
  await c.waitFor(q("#room-title"));
  assert.equal(await c.eval("window.__app.session.me.id"), await a.eval("window.__app.session.me.id"));
  assert.equal(await myColor(c), 0);
  assert.equal(await c.eval("window.__app.session.room.members().length"), 1);
});

scenario("returning: five wrong codes mean a 30-second wait", async ({ open }) => {
  const a = await open({ dev: "a" });
  const id = await createRoom(a, { pin: "24680" });
  const c = await open({ dev: "c", hash: "r-" + id });
  await c.waitFor(q("#join-back"));
  await click(c, "#join-back");
  await click(c, ".who");
  for (let i = 0; i < 5; i++) {
    await fill(c, "#back-pin", "0000" + i);
    await click(c, "#enter");
    await c.waitFor(`${q("#form-error")}?.textContent.length > 0`);
  }
  await c.waitFor(`${q("#form-error")}?.textContent.startsWith("5번 틀렸어요.")`);
  await fill(c, "#back-pin", "24680");
  await click(c, "#enter");
  assert.ok((await text(c, "#form-error")).startsWith("5번 틀렸어요."), "still locked with the right code");
  assert.equal(await c.eval(`${q("#room-title")} === null`), true);
});

scenario("returning: with nobody holding a code the list explains why it is empty", async ({ open }) => {
  const a = await open({ dev: "a" });
  const id = await createRoom(a);
  const c = await open({ dev: "c", hash: "r-" + id });
  await c.waitFor(q("#join-back"));
  await click(c, "#join-back");
  assert.equal(await text(c, "#no-codes"), "이 방에는 개인 식별 코드를 정한 사람이 아직 없어요.");
});

scenario("missing room: a link to a room that does not exist says so", async ({ open }) => {
  const page = await open({ hash: "r-aaaaaaaaaaaa" });
  await page.waitFor(q("#missing"));
  assert.equal(await text(page, "#missing h1"), "방을 찾을 수 없어요");
  await click(page, "#back");
  await page.waitFor(q("#home"));
});

scenario("storage refused: the app still runs and says the list is not kept", async ({ open }) => {
  const page = await open({ dev: "broken" });
  await page.waitFor(q("#home"));
  assert.equal(await text(page, "#notice"), "이 기기에는 방 목록이 저장되지 않아요");
  await createRoom(page);
  assert.equal(await page.eval("window.__app.store.available"), false);
});

scenario("settings: name, colour and code changes reach the other device", async ({ open }) => {
  const a = await open({ dev: "a" });
  const id = await createRoom(a, { name: "가람" });
  const b = await open({ dev: "b", hash: "r-" + id });
  await joinNew(b, { name: "나래" });
  await click(a, "#room-settings");
  await fill(a, "#set-name", "가람이");
  await click(a, '.swatch[data-color="5"]');
  await fill(a, "#set-pin", "13579");
  await click(a, "#save-pin");
  await b.waitFor(`(() => { const m = window.__app.session.room.members()[0]; return m.name === "가람이" && m.color === 5 && !!m.pin; })()`);
  assert.equal(await text(a, "#room-code"), id);
  assert.equal(await a.eval(`window.__app.store.get("last", {}).pin`), "13579");
});

scenario("settings: theme choice is kept and applied", async ({ open }) => {
  const page = await open();
  await click(page, "#home-settings");
  await click(page, '[data-theme-choice="dark"]');
  assert.equal(await page.eval("document.documentElement.dataset.theme"), "dark");
  await page.reload();
  await page.waitFor("window.__app && window.__app.booted");
  assert.equal(await page.eval("document.documentElement.dataset.theme"), "dark");
});

// ---- text room ----------------------------------------------------------------

import { dayLabel } from "../src/core/time.js";

const TODAY = `document.querySelector(".sheet.today")`;
const focusEnd = (page) => page.eval(`(() => { const ta = ${TODAY}.querySelector("textarea"); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); return true; })()`);
const sheetText = (page) => page.eval(`window.__app.session.sheet(${TODAY}.dataset.day).text()`);
const drawn = (page) => page.eval(`[...${TODAY}.querySelectorAll(".draw .ln")].map((l) => l.textContent.replace(/\\u200b/g, "")).join("\\n")`);
const inputValue = (page) => page.eval(`${TODAY}.querySelector("textarea").value`);
const words = (page) => page.eval(`[...${TODAY}.querySelectorAll(".draw .w")].map((w) => ({ text: w.textContent, paint: w.dataset.paint, level: w.dataset.level, color: getComputedStyle(w).color, bg: getComputedStyle(w).backgroundImage }))`);
const wordCentre = (page, text) => page.eval(`(() => { const w = [...${TODAY}.querySelectorAll(".draw .w")].find((x) => x.textContent === ${JSON.stringify(text)}); const r = w.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const sameOnAll = async (pages, expected) => {
  for (const p of pages) {
    await p.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text() === ${JSON.stringify(expected)}`);
    await p.waitFor(`[...${TODAY}.querySelectorAll(".draw .ln")].map((l) => l.textContent.replace(/\\u200b/g, "")).join("\\n") === ${JSON.stringify(expected)}`);
  }
};
/** Opens a room on device a and joins it from more devices. */
async function together(open, names = ["나래"], view = {}) {
  const a = await open({ dev: "a", ...view });
  const id = await createRoom(a, { name: "가람" });
  const rest = [];
  for (const [i, name] of names.entries()) {
    const p = await open({ dev: "bcdef"[i], hash: "r-" + id, ...view });
    await joinNew(p, { name });
    rest.push(p);
  }
  for (const p of [a, ...rest]) await p.waitFor(TODAY + ` && window.__app.session.room.members().length === ${names.length + 1}`);
  return [a, ...rest, id];
}
/** Writes text into today's sheet with a chosen writing time, bypassing the keyboard. */
const writeAt = (page, text, at) => page.eval(`(() => {
  const s = window.__app.session; const day = ${TODAY}.dataset.day; const sheet = s.sheet(day);
  const ids = sheet.ids(); let after = ids.length ? ids[ids.length - 1] : "0"; const ops = [];
  for (const v of ${JSON.stringify(text)}) { const id = s.clock.next(); ops.push({ t: "ins", id, after, v, by: s.me.id, at: ${at} }); after = id; }
  s.commit("s:" + day, ops); return true; })()`);

scenario("typing: what one screen types shows on the other within a second", async ({ open, out }) => {
  const [a, b] = await together(open);
  await focusEnd(a);
  await a.type("안녕 오늘 뭐 했어");
  const t0 = Date.now();
  await sameOnAll([a, b], "안녕 오늘 뭐 했어");
  assert.ok(Date.now() - t0 < 1000, "took " + (Date.now() - t0));
  assert.equal(await inputValue(b), "안녕 오늘 뭐 했어");
  await a.key("Enter");
  await a.type("나는 학교 갔다 왔어");
  await sameOnAll([a, b], "안녕 오늘 뭐 했어\n나는 학교 갔다 왔어");
  await a.shot(out("room-light.png"));
});

scenario("concurrent: two screens typing at once lose nothing and end equal", async ({ open }) => {
  const [a, b] = await together(open);
  await focusEnd(a);
  await focusEnd(b);
  for (let i = 0; i < 10; i++) await Promise.all([a.type("가"), b.type("나")]);
  await a.waitFor(`window.__app.session.pending === 0`);
  await b.waitFor(`window.__app.session.pending === 0`);
  await a.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text().length === 20`);
  await b.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text().length === 20`);
  const [ta, tb] = [await sheetText(a), await sheetText(b)];
  assert.equal(ta, tb);
  assert.equal([...ta].filter((c) => c === "가").length, 10);
  assert.equal([...ta].filter((c) => c === "나").length, 10);
  assert.equal(await inputValue(a), ta);
  assert.equal(await inputValue(b), ta);
});

scenario("hangul: a syllable being composed shows live and leaves one character", async ({ open }) => {
  const [a, b] = await together(open);
  await focusEnd(a);
  for (const step of ["ㅎ", "하", "한"]) {
    await a.ime(step);
    await sameOnAll([b], step);
  }
  await a.type("한");
  await a.ime("ㄱ");
  await a.ime("그");
  await a.ime("글");
  await a.type("글");
  await sameOnAll([a, b], "한글");
  assert.equal(await a.eval(`window.__app.session.sheet(${TODAY}.dataset.day).size`), 2);
  assert.equal(await inputValue(a), "한글");
});

scenario("hangul: text arriving from the other screen does not break a composition", async ({ open }) => {
  const [a, b] = await together(open);
  await focusEnd(b);
  await b.type("먼저 쓴 글 ");
  await sameOnAll([a, b], "먼저 쓴 글 ");
  await focusEnd(a);
  await a.ime("ㅎ");
  await b.eval(`(() => { const ta = ${TODAY}.querySelector("textarea"); ta.setSelectionRange(0, 0); return true; })()`);
  await b.type("앞에 ");
  await sameOnAll([b], "앞에 먼저 쓴 글 ㅎ");
  assert.equal(await drawn(a), "앞에 먼저 쓴 글 ㅎ", "the drawn layer is already up to date");
  assert.equal(await inputValue(a), "먼저 쓴 글 ㅎ", "the input box waits until the composition ends");
  await a.ime("하");
  await a.type("하");
  await sameOnAll([a, b], "앞에 먼저 쓴 글 하");
  await a.waitFor(`${TODAY}.querySelector("textarea").value === "앞에 먼저 쓴 글 하"`);
  await a.type("!");
  await sameOnAll([a, b], "앞에 먼저 쓴 글 하!");
});

scenario("colours: one writer solid, two split, three a wheel", async ({ open, out }) => {
  const [a, b, c] = await together(open, ["나래", "다온"]);
  await focusEnd(a);
  await a.type("가나");
  await sameOnAll([a, b, c], "가나");
  let w = (await words(b))[0];
  assert.equal(w.paint, "solid");
  assert.equal(w.bg, "none");
  await focusEnd(b);
  await b.type("다");
  await sameOnAll([a, b, c], "가나다");
  for (const p of [a, b, c]) {
    await p.waitFor(`${TODAY}.querySelector(".draw .w").dataset.paint === "split"`);
    assert.match((await words(p))[0].bg, /^linear-gradient\(/);
  }
  await focusEnd(c);
  await c.type("라");
  await sameOnAll([a, b, c], "가나다라");
  for (const p of [a, b, c]) {
    await p.waitFor(`${TODAY}.querySelector(".draw .w").dataset.paint === "wheel"`);
    assert.match((await words(p))[0].bg, /^conic-gradient\(/);
  }
  assert.equal(await a.eval(`${TODAY}.querySelector("textarea").selectionStart`), 2, "my caret stays where I left it while others write after it");
  await focusEnd(a);
  await a.type(" 혼자 쓴 말");
  await sameOnAll([a, b, c], "가나다라 혼자 쓴 말");
  await a.eval("document.activeElement.blur()");
  await a.shot(out("room-wheel.png"));
});

scenario("mix: a double tap seeps, then blends, then resets, on both screens", async ({ open, out }) => {
  const [a, b] = await together(open);
  await focusEnd(a);
  await a.type("하나 ");
  await sameOnAll([a, b], "하나 ");
  await focusEnd(b);
  await b.type("둘 ");
  await sameOnAll([a, b], "하나 둘 ");
  await focusEnd(a);
  await a.type("셋");
  await sameOnAll([a, b], "하나 둘 셋");
  const base = (await words(a))[1];
  assert.equal(base.paint, "solid");
  const expect = async (paint, level) => {
    for (const p of [a, b]) await p.waitFor(`(() => { const w = ${TODAY}.querySelectorAll(".draw .w")[1]; return w.dataset.paint === "${paint}" && w.dataset.level === "${level}"; })()`);
  };
  let [x, y] = await wordCentre(a, "둘");
  await a.dblTap(x, y);
  await expect("seep", 1);
  assert.match((await words(b))[1].bg, /linear-gradient\(to right/);
  await a.shot(out("room-seep.png"));
  await a.dblTap(x, y);
  await expect("solid", 2);
  const blended = (await words(b))[1];
  assert.notEqual(blended.color, base.color, "a new mixed colour");
  await a.dblTap(x, y);
  await expect("solid", 0);
  assert.equal((await words(b))[1].color, base.color);
  assert.equal(await sheetText(a), "하나 둘 셋", "double taps never change the text");
});

scenario("mix: switched off, a mixed word shows one colour and a double tap does nothing", async ({ open }) => {
  const [a, b] = await together(open);
  await focusEnd(a);
  await a.type("하나 ");
  await focusEnd(b);
  await sameOnAll([a, b], "하나 ");
  await b.type("둘");
  await sameOnAll([a, b], "하나 둘");
  await focusEnd(a);
  await a.type("이");
  await sameOnAll([a, b], "하나 둘이");
  await a.waitFor(`${TODAY}.querySelectorAll(".draw .w")[1].dataset.paint === "split"`);
  await click(b, "#room-settings");
  await click(b, "#set-mixing");
  await b.eval(`document.querySelector(".scrim").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  await b.waitFor(`${TODAY}.querySelectorAll(".draw .w")[1].dataset.paint === "solid"`);
  const [x, y] = await wordCentre(b, "둘이");
  await b.dblTap(x, y);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await b.eval(`window.__app.session.sheet(${TODAY}.dataset.day).mixLevel(${TODAY}.querySelectorAll(".draw .w")[1].dataset.anchor)`), 0);
  assert.equal((await words(a))[1].paint, "split", "the other screen keeps its own setting");
});

scenario("colours off: every word is ink, and the toolbar button brings colour back", async ({ open }) => {
  const [a, b] = await together(open);
  await focusEnd(a);
  await a.type("가나 ");
  await focusEnd(b);
  await sameOnAll([a, b], "가나 ");
  await b.type("다라");
  await sameOnAll([a, b], "가나 다라");
  await click(a, "#toggle-colors");
  await a.waitFor(`[...${TODAY}.querySelectorAll(".draw .w")].every((w) => w.dataset.paint === "ink")`);
  const ink = await a.eval(`getComputedStyle(${TODAY}.querySelector(".draw")).color`);
  for (const w of await words(a)) assert.equal(w.color, ink);
  assert.equal((await words(b))[0].paint, "solid");
  await click(a, "#toggle-colors");
  await a.waitFor(`${TODAY}.querySelector(".draw .w").dataset.paint === "solid"`);
});

scenario("offline: what was typed while cut off arrives after reconnecting", async ({ open }) => {
  const [a, b] = await together(open);
  await a.eval("window.__app.transport.setOffline(true)");
  await a.waitFor(`document.querySelector("#status").dataset.status === "offline"`);
  await focusEnd(a);
  await a.type("끊긴 동안 쓴 글");
  await focusEnd(b);
  await b.type("그동안 상대가 쓴 글 ");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await sheetText(b), "그동안 상대가 쓴 글 ");
  await a.eval("window.__app.transport.setOffline(false)");
  await a.waitFor(`document.querySelector("#status").dataset.status === "online" && window.__app.session.pending === 0`);
  const total = "끊긴 동안 쓴 글".length + "그동안 상대가 쓴 글 ".length;
  await a.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text().length === ${total}`);
  await b.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text().length === ${total}`);
  assert.equal(await sheetText(a), await sheetText(b));
  await a.waitFor(`${TODAY}.querySelector("textarea").value === window.__app.session.sheet(${TODAY}.dataset.day).text()`);
});

scenario("undo: only my own writing goes away, and redo brings it back", async ({ open }) => {
  const [a, b] = await together(open);
  await focusEnd(a);
  await a.type("내 글 ");
  await sameOnAll([a, b], "내 글 ");
  await focusEnd(b);
  await b.type("상대 글");
  await sameOnAll([a, b], "내 글 상대 글");
  assert.equal(await a.eval(`document.querySelector("#redo").disabled`), true);
  await click(a, "#undo");
  await sameOnAll([a, b], "상대 글");
  assert.equal(await inputValue(a), "상대 글");
  assert.equal(await a.eval(`document.querySelector("#undo").disabled`), true);
  await click(a, "#redo");
  await sameOnAll([a, b], "내 글 상대 글");
});

scenario("refresh: the text and who I am survive a reload", async ({ open }) => {
  const [a, b] = await together(open);
  await focusEnd(a);
  await a.type("새로고침해도 남는 글");
  await sameOnAll([a, b], "새로고침해도 남는 글");
  const me = await a.eval("window.__app.session.me.id");
  await a.reload();
  await a.waitFor(`window.__app && window.__app.booted && ${TODAY}`);
  await sameOnAll([a], "새로고침해도 남는 글");
  assert.equal(await a.eval("window.__app.session.me.id"), me);
  assert.equal(await a.eval(`document.querySelector("#join-name") === null`), true);
});

scenario("layers: the drawn text and the input box always have the same height", async ({ open }) => {
  const [a] = await together(open, []);
  const samples = ["가", "안녕 오늘 뭐 했어 나는 학교 갔다 와서 숙제하고 지금은 그냥 누워 있어 너는 뭐 해", "abc def ghi jkl mno pqr stu vwx yz ".repeat(4),
    "한 줄\n\n세 번째 줄\n", "\n\n", "supercalifragilisticexpialidocious".repeat(3), "띄어쓰기없이아주길게이어서쓰는한글문장이줄을넘어가도두겹이똑같이꺾여야한다는것을확인하는글",
    "mix 섞어 쓰기 English 한국어 123 !!! ".repeat(5), "끝에 공백     ", "😀 이모지 😀😀 섞기 🎹", "a\nb\nc\nd\ne\nf\ng\nh"];
  for (const sample of samples) {
    await a.eval(`(() => { const ta = ${TODAY}.querySelector("textarea"); ta.focus(); ta.select(); return true; })()`);
    await a.type(sample);
    await a.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text() === ${JSON.stringify(sample)}`);
    const m = await a.eval(`(() => { const s = ${TODAY}; const ta = s.querySelector("textarea"); const draw = s.querySelector(".draw");
      const probe = ta.cloneNode(); probe.value = ta.value; probe.style.height = "0"; probe.style.minHeight = "0"; ta.parentElement.append(probe);
      const need = probe.scrollHeight; probe.remove();
      return { need, draw: draw.scrollHeight, min: parseFloat(getComputedStyle(draw).minHeight) || 0, box: ta.clientHeight, drawBox: draw.clientHeight }; })()`);
    assert.ok(Math.abs(Math.max(m.need, m.min) - m.draw) <= 1, JSON.stringify(sample.slice(0, 20)) + " " + JSON.stringify(m));
    assert.ok(Math.abs(m.box - m.drawBox) <= 1, "input box covers the drawn text " + JSON.stringify(m));
  }
});

scenario("stamps: lines an hour apart are stamped, and the day header names the day", async ({ open }) => {
  const [a] = await together(open, []);
  const day = await a.eval(`${TODAY}.dataset.day`);
  const tz = await a.eval(`window.__app.session.room.meta("tz")`);
  assert.equal(await text(a, ".sheet.today .day"), dayLabel(day));
  const base = Date.parse(day + "T00:00:00Z");
  // Find the UTC instants that are 09:10 and 12:20 on this day in the room's zone.
  const local = (h, m) => { for (let t = base - 14 * 3600e3; t < base + 38 * 3600e3; t += 600e3) { const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(t).reduce((o, x) => (o[x.type] = x.value, o), {}); if (`${p.year}-${p.month}-${p.day}` === day && +p.hour === h && +p.minute === m) return t; } throw new Error("no such time"); };
  await writeAt(a, "아침에 쓴 글\n같은 시간에 한 줄 더", local(9, 10));
  await writeAt(a, "\n점심에 쓴 글", local(12, 20));
  await a.waitFor(`document.querySelectorAll(".sheet.today .stamp").length === 2`);
  assert.deepEqual(await a.eval(`[...document.querySelectorAll(".sheet.today .stamp")].map((s) => s.textContent)`), ["오전 9시", "오후 12시"]);
  const tops = await a.eval(`(() => { const s = ${TODAY}; const st = [...s.querySelectorAll(".stamp")].map((x) => x.getBoundingClientRect().top); const ln = [...s.querySelectorAll(".draw .ln")].map((x) => x.getBoundingClientRect().top); return { st, ln }; })()`);
  assert.ok(Math.abs(tops.st[0] - tops.ln[0]) <= 6 && Math.abs(tops.st[1] - tops.ln[2]) <= 6, JSON.stringify(tops));
});

scenario("days: older sheets come first, only seven load until asked for more", async ({ open }) => {
  const [a] = await together(open, []);
  await a.eval(`(() => { const s = window.__app.session; for (let d = 1; d <= 9; d++) { const id = s.clock.next(); s.commit("s:2026-01-0" + d, [{ t: "ins", id, after: "0", v: String(d), by: s.me.id, at: Date.parse("2026-01-0" + d + "T03:00:00Z") }]); } return true; })()`);
  await a.waitFor(`window.__app.session.pending === 0`);
  await a.reload();
  await a.waitFor(`window.__app && window.__app.booted && ${TODAY}`);
  await a.waitFor(`document.querySelectorAll(".sheet").length === 8`);
  const days = await a.eval(`[...document.querySelectorAll(".sheet")].map((s) => s.dataset.day)`);
  assert.deepEqual(days.slice(0, 7), ["2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"]);
  assert.equal(await text(a, '.sheet[data-day="2026-01-05"] .day'), "1월 5일 월요일");
  await a.waitFor(`document.querySelector('.sheet[data-day="2026-01-09"] .draw').textContent.includes("9")`);
  await click(a, "#older");
  await a.waitFor(`document.querySelectorAll(".sheet").length === 10 && document.querySelector("#older") === null`);
});

scenario("carets: the other person's caret is drawn in their colour", async ({ open }) => {
  const [a, b] = await together(open);
  await focusEnd(b);
  await b.type("여기 쓰는 중");
  await a.waitFor(`${TODAY}.querySelector(".caret.remote")`);
  const info = await a.eval(`(() => { const c = ${TODAY}.querySelector(".caret.remote"); const last = [...${TODAY}.querySelectorAll(".draw .w")].pop().getBoundingClientRect(); const r = c.getBoundingClientRect(); return { dx: Math.abs(r.left - last.right), name: c.querySelector(".caret-name")?.textContent }; })()`);
  assert.ok(info.dx <= 3, JSON.stringify(info));
  assert.equal(info.name, "나래");
  await focusEnd(a);
  await a.waitFor(`${TODAY}.querySelector(".caret.mine")`);
});

scenario("overflow: a very long unbroken string wraps and never widens the page", async ({ open, out }) => {
  for (const dark of [false, true]) {
    const [a] = await together(open, [], { dark });
    await focusEnd(a);
    await a.type("w".repeat(300) + " 그리고 한글도 조금 섞어서 씁니다");
    await a.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text().length > 300`);
    const m = await a.eval(`({ page: document.documentElement.scrollWidth, inner: innerWidth, paper: ${TODAY}.querySelector(".paper").scrollWidth, paperBox: ${TODAY}.querySelector(".paper").clientWidth })`);
    assert.ok(m.page <= m.inner && m.paper <= m.paperBox, JSON.stringify(m));
    if (dark) await a.shot(out("room-dark.png"));
  }
});
