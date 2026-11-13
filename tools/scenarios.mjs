// The scenarios. Each gets `open({dev, hash, width, height, dark})` → page.
// `dev` is a pretend device: its own storage for "who am I", shared room data.

import assert from "node:assert/strict";

export const scenarios = [];
const scenario = (name, run) => scenarios.push({ name, run });
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
/**
 * Presses an element the way a finger does: the press goes to whatever is on
 * top at the element's centre. An element that something else covers cannot be
 * pressed, and the scenario fails saying what is in the way. (A scripted
 * el.click() would succeed there and hide the fault.)
 */
const click = async (page, sel) => {
  const name = sel.replace(/"/g, "'");
  const at = await page.eval(`(async () => {
    const el = ${q(sel)};
    if (!el) throw new Error("no element ${name}");
    // Let a sheet that is sliding in come to rest, so the press lands where the element will be.
    // Only motion that carries this element counts, and never for long: a screen that is not
    // in front may not advance its animations at all.
    const moving = document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.contains(el) && a.effect.getComputedTiming().iterations !== Infinity);
    await Promise.race([Promise.all(moving.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 500))]);
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) throw new Error("${name} has no size on screen");
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === el || el.contains(hit))) {
      const what = !hit ? "nothing" : hit.id ? "#" + hit.id : hit.tagName.toLowerCase() + (hit.className ? "." + String(hit.className).split(" ").join(".") : "");
      throw new Error("${name} cannot be pressed: " + what + " is on top of it");
    }
    return { x, y };
  })()`);
  await page.tap(at.x, at.y);
};
/** Taps a field, checks that the tap put the caret there, and types over what it held. */
const fill = async (page, sel, text) => {
  await click(page, sel);
  await page.eval(`(() => { const el = ${q(sel)}; if (document.activeElement !== el) throw new Error("tapping ${sel.replace(/"/g, "'")} did not put the caret in it"); el.select && el.select(); return true; })()`);
  await page.type(text);
};
const text = (page, sel) => page.eval(`${q(sel)}?.textContent ?? null`);

/** Creates a daily text room on the page and waits until it is open. Returns the room id. */
export async function createRoom(page, { room = "우리 방", name = "가람", pin = "", keepInvite = false, noInvite = false } = {}) {
  await click(page, "#add-daily");
  await click(page, '[data-kind="daily-text"]');
  await fill(page, "#room-name", room);
  await fill(page, "#my-name", name);
  if (pin) await fill(page, "#my-pin", pin);
  await click(page, "#create-room");
  await page.waitFor(`location.hash.startsWith("#r-") && ${q("#room-title")}`);
  // A new room opens with its invitation showing; most scenarios put it away.
  if (!keepInvite && !noInvite) {
    await page.waitFor(q("#invite-done"));
    await click(page, "#invite-done");
  }
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

/** The address a trial build was told it is published at; null for the source files and plain builds. */
const builtBase = (page) => page.eval(`window.__app.shareBase()`);
/** Where another test device opens a room: this server's page with the room's hash. */
const localLink = (page, dev, id) => page.eval(`location.href.split("#")[0]`).then((base) => base.replace(/dev=[^&#]*/, "dev=" + dev) + "#r-" + id);

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

// ---- design and error states -----------------------------------------------------

import { contrast, memberColor, INK, PAPER } from "../src/core/paint.js";

const hex = (rgb) => "#" + rgb.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");

scenario("contrast: ink, muted text and all eight colours read on the paper, light and dark", async ({ open }) => {
  for (const dark of [false, true]) {
    const theme = dark ? "dark" : "light";
    const [a] = await together(open, [], { dark });
    await focusEnd(a);
    await a.type("글자색 확인");
    await a.waitFor(`${TODAY}.querySelector(".draw .w")`);
    const css = await a.eval(`(() => { const cs = getComputedStyle(document.documentElement); const probe = (v) => { const e = document.createElement("i"); e.style.color = v; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
      return { paper: probe(cs.getPropertyValue("--paper")), ink: probe(cs.getPropertyValue("--ink")), muted: probe(cs.getPropertyValue("--muted")),
        word: getComputedStyle(${TODAY}.querySelector(".draw .w")).color, stamp: getComputedStyle(${TODAY}.querySelector(".stamp")).color, drawInk: getComputedStyle(${TODAY}.querySelector(".draw")).color }; })()`);
    assert.equal(hex(css.paper), PAPER[theme], "the stylesheet and the colour rules agree on the paper");
    assert.equal(hex(css.ink), INK[theme], "and on the ink");
    assert.equal(hex(css.word), memberColor(0, theme));
    assert.equal(hex(css.drawInk), INK[theme]);
    for (const [name, value] of Object.entries({ ink: css.ink, muted: css.muted, word: css.word, stamp: css.stamp })) {
      assert.ok(contrast(hex(value), hex(css.paper)) >= 4.5, `${theme} ${name} ${contrast(hex(value), hex(css.paper)).toFixed(2)}`);
    }
    await click(a, "#room-settings");
    const swatches = await a.eval(`[...document.querySelectorAll(".swatch")].map((s) => getComputedStyle(s).backgroundColor)`);
    assert.equal(swatches.length, 8);
    swatches.forEach((c, i) => assert.ok(contrast(hex(c), hex(css.paper)) >= 4.5, `${theme} colour ${i}`));
  }
});

scenario("motion: the wheel turns once when a third writer joins a word, and not at all under reduced motion", async ({ open }) => {
  for (const reducedMotion of [false, true]) {
    const [a, b, c] = await together(open, ["나래", "다온"], { reducedMotion });
    await focusEnd(a);
    await a.type("가");
    await sameOnAll([a, b, c], "가");
    await focusEnd(b);
    await b.type("나");
    await sameOnAll([a, b, c], "가나");
    await focusEnd(c);
    await c.type("다");
    await a.waitFor(`${TODAY}.querySelector(".draw .w").dataset.paint === "wheel"`);
    assert.equal(await a.eval(`${TODAY}.querySelector(".draw .w").classList.contains("spin")`), !reducedMotion);
    await a.reload();
    await a.waitFor(`window.__app && window.__app.booted && ${TODAY} && ${TODAY}.querySelector(".draw .w")`);
    assert.equal(await a.eval(`${TODAY}.querySelector(".draw .w").classList.contains("spin")`), false, "a wheel that was already there does not turn on load");
  }
});

scenario("read-only: when writing is refused the tools hide and the page says so", async ({ open }) => {
  const [a] = await together(open, []);
  await focusEnd(a);
  await a.type("쓸 수 있을 때 쓴 글");
  await a.eval(`(() => { window.__app.transport.readOnly = true; window.__app.session.emit("status", "offline"); return true; })()`);
  await a.waitFor(`document.querySelector("#banner").textContent === "보기만 할 수 있어요"`);
  assert.equal(await a.eval(`getComputedStyle(document.querySelector(".toolbar")).display`), "none");
  assert.equal(await a.eval(`${TODAY}.querySelector("textarea").readOnly`), true);
  assert.equal(await drawn(a), "쓸 수 있을 때 쓴 글");
  await a.eval(`(() => { window.__app.transport.readOnly = false; window.__app.session.emit("status", "online"); return true; })()`);
  await a.waitFor(`document.querySelector("#banner").hidden && !${TODAY}.querySelector("textarea").readOnly`);
});

scenario("slow start: while nothing answers the home says 아직 연결 중 and still works", async ({ open }) => {
  const page = await open({ init: "window.claude = { use: () => new Promise(() => {}) };" });
  await page.waitFor(`document.querySelector("#connecting")?.textContent === "아직 연결 중"`, 4000);
  await click(page, "#home-settings");
  await page.waitFor(`document.querySelector('[data-theme-choice="dark"]')`);
  await click(page, '[data-theme-choice="dark"]');
  assert.equal(await page.eval("document.documentElement.dataset.theme"), "dark");
});

scenario("no store: the page says other devices cannot connect and works on its own", async ({ open }) => {
  const page = await open({ init: "window.claude = { use: () => Promise.resolve(null) };" });
  await page.waitFor(`document.querySelector("#notice")?.textContent === "이 화면에서는 다른 기기와 연결되지 않아요"`);
  // A room made in such a view lives on this device only, so no invitation is offered.
  await createRoom(page, { noInvite: true });
  assert.equal(await text(page, "#banner"), "이 기기에만 있는 방이에요. 다른 기기와는 연결되지 않아요.");
  await focusEnd(page);
  await page.type("혼자 쓰기");
  await sameOnAll([page], "혼자 쓰기");
});

scenario("new version: an op this app does not know shows the refresh notice", async ({ open }) => {
  const [a] = await together(open, []);
  await a.eval(`window.__app.session.receive("s:" + ${TODAY}.dataset.day, [{ t: "sticker", id: "999999@zzzzzz", x: 1 }])`);
  await a.waitFor(`document.querySelector("#banner").textContent === "새 버전이 있어요. 새로고침해 주세요"`);
  await focusEnd(a);
  await a.type("그래도 쓸 수 있어요");
  await sameOnAll([a], "그래도 쓸 수 있어요");
});

scenario("diagnostics: the panel names the transport, what is unsent, and the version", async ({ open }) => {
  const [a] = await together(open, []);
  await click(a, "#room-settings");
  const facts = await a.eval(`Object.fromEntries([...document.querySelectorAll("#diag dt")].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]))`);
  assert.equal(facts["전송 방식"], "local");
  assert.equal(facts["아직 못 보낸 기록"], "0");
  assert.equal(facts["버전"], await a.eval("window.__app.version"));
  assert.equal(facts["마지막 오류"], "없음");
});

scenario("wide screen: the column is centred and scaled to 1.4", async ({ open, out }) => {
  const page = await open({ width: 1280, height: 800 });
  await createRoom(page);
  await focusEnd(page);
  await page.type("넓은 화면에서도 가운데 종이 한 장");
  const r = await page.eval(`(() => { const b = document.querySelector("#app").getBoundingClientRect(); return { left: b.left, width: b.width, height: b.height, scroll: document.documentElement.scrollWidth, font: parseFloat(getComputedStyle(${TODAY}.querySelector(".draw")).fontSize) }; })()`);
  assert.ok(Math.abs(r.width - 504) <= 1 && Math.abs(r.left - 388) <= 1, JSON.stringify(r));
  assert.ok(Math.abs(r.font - 22.4) < 0.1 && r.height === 800 && r.scroll <= 1280, JSON.stringify(r));
  await page.shot(out("room-wide.png"));
});

scenario("grain: the colour fields carry visible film grain", async ({ open }) => {
  const page = await open();
  await page.waitFor(q("#home"));
  const g = await page.eval(`(() => { const s = getComputedStyle(document.querySelector('[data-side="daily"]'), "::after"); return { image: s.backgroundImage.slice(0, 30), opacity: Number(s.opacity), blend: s.mixBlendMode }; })()`);
  assert.match(g.image, /^url\("data:image\/svg\+xml/);
  assert.ok(g.opacity >= 0.5, JSON.stringify(g));
});

scenario("narrow screen: at 320 wide the column shrinks to fit and nothing scrolls sideways", async ({ open }) => {
  const page = await open({ width: 320, height: 640 });
  await createRoom(page);
  await focusEnd(page);
  await page.type("좁은 화면에서도 옆으로 밀리지 않아요");
  const r = await page.eval(`(() => { const b = document.querySelector("#app").getBoundingClientRect(); return { left: b.left, width: b.width, scroll: document.documentElement.scrollWidth }; })()`);
  assert.ok(Math.abs(r.width - 320) <= 1 && Math.abs(r.left) <= 1 && r.scroll <= 320, JSON.stringify(r));
});

scenario("full store: the page says the storage is full and keeps what was typed", async ({ open }) => {
  const [a] = await together(open, []);
  await focusEnd(a);
  await a.type("가득 찼을 때 쓴 글");
  await a.eval(`(() => { window.__app.transport.full = true; window.__app.session.emit("status", "offline"); return true; })()`);
  await a.waitFor(`document.querySelector("#banner").textContent === "저장 공간이 가득 찼어요"`);
  assert.equal(await drawn(a), "가득 찼을 때 쓴 글");
  assert.equal(await a.eval(`${TODAY}.querySelector("textarea").readOnly`), false);
});

scenario("stamp: tapping a time stamp tells who wrote the line and when", async ({ open }) => {
  const [a] = await together(open, []);
  await focusEnd(a);
  await a.type("누가 언제 썼는지");
  await a.waitFor(q(".sheet.today .stamp"));
  await click(a, ".sheet.today .stamp");
  await a.waitFor(q(".toast"));
  assert.match(await text(a, ".toast"), /^가람 님이 (오전|오후) \d{1,2}:\d{2}에 썼어요$/);
});

scenario("speed: typing stays quick on a sheet that already holds 10,000 characters", async ({ open }) => {
  const [a] = await together(open, []);
  await writeAt(a, "가나다라 마바사 아자차카 타파하 ".repeat(588) + "\n".repeat(8), Date.now());
  await a.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text().length >= 10000 && ${TODAY}.querySelector("textarea").value.length >= 10000`);
  await focusEnd(a);
  const ms = await a.eval(`(async () => { const ta = ${TODAY}.querySelector("textarea"); const times = [];
    for (let i = 0; i < 20; i++) { const t0 = performance.now(); document.execCommand("insertText", false, "가"); times.push(performance.now() - t0); await new Promise((r) => setTimeout(r, 0)); }
    times.sort((x, y) => x - y); return times[10]; })()`);
  console.log("     median keystroke " + ms.toFixed(1) + " ms");
  assert.ok(ms < 50, "median keystroke took " + ms.toFixed(1) + " ms");
  assert.equal(await a.eval(`window.__app.session.sheet(${TODAY}.dataset.day).text().length`), await a.eval(`${TODAY}.querySelector("textarea").value.length`));
});

// ---- the trial host's frame ---------------------------------------------------------

scenario("sandbox: inside a scripts-only frame a room can still be created and written in", async ({ open }) => {
  const page = await open({ sandbox: true });
  await page.waitFor(q("#home"));
  assert.equal(await page.eval(`(() => { try { localStorage.getItem("x"); return "storage allowed"; } catch { return "storage refused"; } })()`), "storage refused", "the frame really is sandboxed");
  await createRoom(page, { room: "틀 안의 방", name: "가람", pin: "24680" });
  await focusEnd(page);
  await page.type("틀 안에서도 써져요");
  await sameOnAll([page], "틀 안에서도 써져요");
});

scenario("sandbox: the code form answers inside the frame, by button and by the Enter key", async ({ open }) => {
  const page = await open({ sandbox: true });
  await click(page, "#by-code");
  await fill(page, "#code", "zzzzzzzzzzzz");
  await click(page, "#open-code");
  await page.waitFor(`${q("#form-error")}?.textContent === "그 코드의 방을 찾을 수 없어요."`);
  await fill(page, "#code", "yyyy");
  await page.eval(`(() => { document.querySelector("#form-error").textContent = ""; return true; })()`);
  await page.key("Enter");
  await page.waitFor(`${q("#form-error")}?.textContent === "그 코드의 방을 찾을 수 없어요."`);
});

const FAKE_RUNTIME = `window.claude = (() => { const view = import("/__mock/claude-runtime.js").then((m) => m.makeRuntime().view()); return { use: (name) => view.then((v) => v.use(name)) }; })();`;

scenario("trial frame: with the page runtime present a room is created, written, left and found again", async ({ open }) => {
  const page = await open({ sandbox: true, init: FAKE_RUNTIME });
  await page.waitFor(`window.__app.transport && window.__app.transport.info().kind === "claude"`);
  assert.equal(await page.eval(`document.querySelector("#notice")?.textContent ?? ""`), "이 기기에는 방 목록이 저장되지 않아요");
  const id = await createRoom(page, { room: "시험판 방", name: "가람" });
  await focusEnd(page);
  await page.type("저장소에 남는 글");
  await sameOnAll([page], "저장소에 남는 글");
  await page.waitFor(`window.__app.session.pending === 0`);
  await click(page, "#back");
  await page.waitFor(q('[data-side="daily"] .room-row'));
  await click(page, '[data-side="daily"] .room-row');
  await page.waitFor(`${q("#room-title")} && ${TODAY}`);
  await sameOnAll([page], "저장소에 남는 글");
  assert.equal(await page.eval("location.hash"), "#r-" + id);
});

scenario("invite: a new room shows a link to send, and the link opens the room on another device", async ({ open, out }) => {
  const a = await open({ dev: "a" });
  const id = await createRoom(a, { room: "초대하는 방", keepInvite: true });
  const link = await text(a, "#invite-link");
  assert.equal(link, ((await builtBase(a)) || await a.eval(`location.href.split("#")[0]`)) + "#r-" + id);
  assert.equal(await text(a, "#invite-code"), id);
  await a.shot(out("invite-light.png"));
  await click(a, "#copy-link");
  await a.waitFor(q(".toast"));
  assert.match(await text(a, ".toast"), /^(링크를 복사했어요|링크를 길게 눌러 복사해 주세요)$/);
  await click(a, "#invite-done");
  assert.equal(await a.eval(`document.querySelector(".scrim") === null`), true);
  await click(a, "#invite");
  await a.waitFor(q("#invite-link"));
  const b = await open({ dev: "b" });
  await b.goto(await localLink(a, "b", id));
  await b.waitFor("window.__app && window.__app.booted");
  await joinNew(b, { name: "나래" });
  assert.equal(await text(b, "#room-title"), "초대하는 방");
  assert.equal(await b.eval(`document.querySelector(".scrim") === null`), true, "a guest is not shown the invitation");
});

scenario("invite: the published page's own address is used when the build names one", async ({ open }) => {
  const page = await open({ init: `document.addEventListener("DOMContentLoaded", () => { if (document.querySelector('meta[name="share-base"]')) return; const m = document.createElement("meta"); m.name = "share-base"; m.content = "https://claude.ai/artifact/AbC123"; document.head.append(m); });` });
  const id = await createRoom(page, { keepInvite: true });
  // A trial build already names its address; the source files get the stand-in above.
  const base = await builtBase(page);
  assert.match(base, /^https:\/\/claude\.ai\/artifact\/\w+$/);
  assert.equal(await text(page, "#invite-link"), base + "#r-" + id);
  assert.equal(await text(page, "#invite-note"), "시험판이라 Claude에서 이 페이지를 공유받은 사람만 들어올 수 있어요.");
});

const FAKE_SHARE = `navigator.share = (data) => { window.__shared = data; return Promise.resolve(); };`;

scenario("invite: on a device with a share sheet, 보내기 hands it the room link", async ({ open }) => {
  const page = await open({ init: FAKE_SHARE });
  const id = await createRoom(page, { room: "보내는 방", keepInvite: true });
  if (await builtBase(page)) return; // a trial build never offers the share sheet; the next scenario covers it
  await click(page, "#send-link");
  await page.waitFor("window.__shared");
  const shared = await page.eval("window.__shared");
  assert.equal(shared.url, await text(page, "#invite-link"));
  assert.ok(shared.url.endsWith("#r-" + id));
  assert.equal(shared.title, "보내는 방");
});

scenario("invite: the trial page offers copying only, because its frame refuses the share sheet", async ({ open }) => {
  const page = await open({ init: FAKE_SHARE + `document.addEventListener("DOMContentLoaded", () => { const m = document.createElement("meta"); m.name = "share-base"; m.content = "https://claude.ai/artifact/AbC123"; document.head.append(m); });` });
  await createRoom(page, { keepInvite: true });
  assert.equal(await page.eval(`document.querySelector("#send-link") === null`), true);
  assert.equal(await page.eval(`document.querySelector("#copy-link") !== null`), true);
});

// ---- views that misbehave: each is one way the trial page's host could differ from a plain browser ----

/** The stand-in runtime, with options for makeRuntime and statements run against it as `rt`. */
const fakeRuntime = (options = {}, tweak = "") => `window.claude = (() => { const view = import("/__mock/claude-runtime.js").then((m) => { const rt = m.makeRuntime(${JSON.stringify(options)}); ${tweak} window.__rt = rt; return rt.view(); }); return { use: (name) => view.then((v) => v.use(name)) }; })();`;
const LOCAL_BANNER = "이 기기에만 있는 방이에요. 다른 기기와는 연결되지 않아요.";
const usesStore = `window.__app.transport && window.__app.transport.info().kind === "claude"`;

scenario("misbehaving view: when the store refuses the write, the room is made on this device and says so", async ({ open, out }) => {
  const page = await open({ sandbox: true, init: fakeRuntime({}, `rt.rejectWrites = "capability_disabled";`) });
  await page.waitFor(usesStore);
  await createRoom(page, { room: "혼자 쓰는 방", noInvite: true });
  assert.equal(await text(page, "#banner"), LOCAL_BANNER);
  assert.equal(await page.eval(`document.querySelector(".scrim") === null`), true, "no invitation for a room nobody else can reach");
  await focusEnd(page);
  await page.type("그래도 써져요");
  await sameOnAll([page], "그래도 써져요");
  await click(page, "#invite");
  assert.equal(await text(page, "#invite-local"), "이 방은 이 기기에만 있어서 링크로 초대할 수 없어요.");
  assert.equal(await page.eval(`document.querySelector("#invite-link") === null`), true);
  await click(page, "#invite-done");
  await click(page, "#back");
  await page.waitFor(q('[data-side="daily"] .room-row'));
  assert.equal(await text(page, '[data-side="daily"] .room-row .room-when'), "이 기기만");
  assert.match(await text(page, "#notice"), /다른 기기와 연결되지 않아요/);
  await page.shot(out("home-device-only.png"));
  await click(page, "#home-settings");
  assert.match(await text(page, "#diag"), /create: capability_disabled/);
  await page.shot(out("home-diagnostics.png"));
  // the room is still there to go back into
  await page.key("Escape");
  await click(page, '[data-side="daily"] .room-row');
  await page.waitFor(`${q("#room-title")} && ${TODAY}`);
  await sameOnAll([page], "그래도 써져요");
});

scenario("misbehaving view: when the store never answers, creating stops waiting and makes the room on this device", async ({ open }) => {
  const page = await open({ sandbox: true, query: "patience=400", init: fakeRuntime({}, `rt.hangWrites = true;`) });
  await page.waitFor(usesStore);
  await click(page, "#add-daily");
  await click(page, '[data-kind="daily-text"]');
  await fill(page, "#room-name", "기다리다 만든 방");
  await fill(page, "#my-name", "가람");
  await click(page, "#create-room");
  await page.waitFor(`${q("#form-status")}?.textContent === "방을 만드는 중…"`, 300);
  await page.waitFor(`location.hash.startsWith("#r-") && ${q("#room-title")}`, 3000);
  assert.equal(await text(page, "#banner"), LOCAL_BANNER);
  assert.equal(await text(page, "#room-title"), "기다리다 만든 방");
});

scenario("misbehaving view: a live channel that never answers does not hold up the store", async ({ open }) => {
  const page = await open({ sandbox: true, init: fakeRuntime({ hangRoom: true }) });
  await page.waitFor(usesStore, 1000);
  const id = await createRoom(page, { room: "저장소만 있는 방" });
  assert.equal(await page.eval(`document.querySelector("#banner").hidden`), true);
  assert.equal((await page.eval(`window.__rt.store.has("rooms/${id}")`)), true, "the room went to the shared store");
  await click(page, "#room-settings");
  assert.match(await text(page, "#diag"), /실시간 채널none/);
});

scenario("misbehaving view: a page whose address change is never announced still opens the room it made", async ({ open }) => {
  const page = await open({ init: `window.addEventListener("hashchange", (event) => event.stopImmediatePropagation(), true);` });
  await createRoom(page, { room: "주소가 조용한 방" });
  assert.equal(await text(page, "#room-title"), "주소가 조용한 방");
  await click(page, "#back");
  await page.waitFor(q('[data-side="daily"] .room-row'));
  await click(page, '[data-side="daily"] .room-row');
  await page.waitFor(`${q("#room-title")} && ${TODAY}`);
});

scenario("misbehaving view: when the room list cannot be read, home says so and a room can still be made", async ({ open }) => {
  const page = await open({ sandbox: true, query: "patience=300", init: fakeRuntime({}, `rt.hangReads = true; rt.hangWrites = true;`) });
  await page.waitFor(`${q("#notice")}?.textContent.includes("다른 기기와 연결되지 않아요")`, 3000);
  await createRoom(page, { room: "목록 없이 만든 방", noInvite: true });
  assert.equal(await text(page, "#banner"), LOCAL_BANNER);
});

scenario("home: the settings sheet shows how this view is connected and what happened so far", async ({ open }) => {
  const page = await open({ sandbox: true, init: fakeRuntime() });
  await page.waitFor(usesStore);
  await click(page, "#home-settings");
  const diag = await text(page, "#diag");
  assert.match(diag, /전송 방식claude/);
  assert.match(diag, /저장소ok/);
  assert.match(diag, /runtime found/);
  assert.match(diag, /db ok/);
  const plain = await open({ dev: "b" });
  await click(plain, "#home-settings");
  assert.match(await text(plain, "#diag"), /전송 방식local/);
  assert.match(await text(plain, "#diag"), /runtime absent/);
});

// ---- what a person sees and can touch ----------------------------------------------------------

/** For every text field on screen: is it a visible box, with visible text and caret, sitting where its label is? */
const fieldFaults = (page) => page.eval(`(() => {
  const alpha = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return 1; const p = m[1].split(/[ ,/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
  const faults = [];
  const fields = [...document.querySelectorAll('.scrim input[type="text"], .join input[type="text"]')];
  if (!fields.length) faults.push("no fields found");
  for (const el of fields) {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); const id = "#" + el.id;
    if (cs.position !== "static" && cs.position !== "relative") faults.push(id + " is positioned " + cs.position);
    if (alpha(cs.color) < 1 || alpha(cs.webkitTextFillColor) < 1) faults.push(id + " shows its text as " + cs.webkitTextFillColor);
    if (alpha(cs.caretColor) === 0) faults.push(id + " has an invisible caret");
    if (parseFloat(cs.borderTopWidth) < 1) faults.push(id + " has no border");
    if (r.height < 36 || r.height > 60) faults.push(id + " is " + Math.round(r.height) + "px tall");
    const label = document.querySelector('label[for="' + el.id + '"]');
    if (label && Math.abs(r.top - label.getBoundingClientRect().bottom) > 12) faults.push(id + " is not under its label");
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit !== el) faults.push(id + " is covered by " + (hit ? hit.id || hit.className || hit.tagName : "nothing"));
  }
  for (let i = 0; i < fields.length; i++) for (let j = i + 1; j < fields.length; j++) {
    const a = fields[i].getBoundingClientRect(), b = fields[j].getBoundingClientRect();
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) faults.push("#" + fields[i].id + " and #" + fields[j].id + " overlap");
  }
  return faults;
})()`);
/** Waits for a sheet to finish sliding in (never long: a screen that is not in front may not animate). */
const settled = (page) => page.eval(`(() => { const moving = document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.matches(".panel, .toast")); return Promise.race([Promise.all(moving.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 500))]).then(() => true); })()`);

scenario("forms: every field is a visible box that a tap reaches, on every screen that has one", async ({ open, out }) => {
  for (const dark of [false, true]) {
    const tag = dark ? "dark" : "light";
    const a = await open({ dev: "a" + tag, dark });
    await click(a, "#add-daily");
    await settled(a);
    await a.shot(out(`kinds-${tag}.png`));
    await click(a, '[data-kind="daily-text"]');
    await settled(a);
    assert.deepEqual(await fieldFaults(a), [], "new room form");
    await fill(a, "#room-name", "보이는 방");
    await fill(a, "#my-name", "가람");
    await fill(a, "#my-pin", "13579");
    assert.deepEqual(await a.eval(`["room-name", "my-name", "my-pin"].map((id) => document.getElementById(id).value)`), ["보이는 방", "가람", "13579"]);
    await a.shot(out(`form-create-${tag}.png`));
    await click(a, "#create-room");
    await a.waitFor(`location.hash.startsWith("#r-") && ${q("#invite-done")}`);
    await settled(a);
    await a.shot(out(`invite-${tag}.png`));
    const roomId = await a.eval("location.hash.slice(3)");
    await click(a, "#invite-done");
    await click(a, "#room-settings");
    await settled(a);
    assert.deepEqual(await fieldFaults(a), [], "room settings");
    await a.shot(out(`settings-${tag}.png`));
    await a.key("Escape");
    await click(a, "#back");
    await a.waitFor(q("#by-code"));
    await click(a, "#by-code");
    await settled(a);
    assert.deepEqual(await fieldFaults(a), [], "code form");
    await fill(a, "#code", "abcdefgh2345");
    assert.equal(await a.eval(`document.getElementById("code").value`), "abcdefgh2345");
    await a.shot(out(`form-code-${tag}.png`));
    await click(a, "#open-code");
    await a.waitFor(`${q("#form-error")}?.textContent === "그 코드의 방을 찾을 수 없어요."`);

    const b = await open({ dev: "b" + tag, dark });
    await b.goto(await localLink(a, "b" + tag, roomId));
    await b.waitFor("window.__app && window.__app.booted");
    await b.waitFor(q("#join-name"));
    await settled(b);
    assert.deepEqual(await fieldFaults(b), [], "join screen");
    await fill(b, "#join-name", "나래");
    await b.shot(out(`join-${tag}.png`));
    await click(b, "#join-back");
    await b.waitFor(q("#back-pin"));
    assert.deepEqual(await fieldFaults(b), [], "join screen, returning");
    await b.shot(out(`join-back-${tag}.png`));
  }
});
