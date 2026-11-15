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

scenario("home: each room says what kind it is; nothing flashes blue; corners take the glass colour, the middle colours stay in dark", async ({ open, out }) => {
  const page = await open();
  await createSongRoom(page, { room: "노래 방" });
  await click(page, "#back");
  await createBoard(page, { room: "보드 방" });
  await click(page, "#back");
  await createRoom(page, { room: "글 방" });
  await click(page, "#back");
  await page.waitFor(`document.querySelectorAll(".room-row").length === 3`);
  const rows = await page.eval(`[...document.querySelectorAll(".room-row")].map((r) => [r.querySelector(".room-name").textContent, r.querySelector(".room-kind")?.textContent ?? "", !!r.querySelector(".room-kind svg")]).sort()`);
  assert.deepEqual(rows, [["글 방", "텍스트", true], ["노래 방", "노래 만들기", true], ["보드 방", "화이트보드", true]]);
  // No blue flash where a finger lands (Android draws one on anything tappable unless told not to).
  const flash = await page.eval(`[...document.querySelectorAll(".room-row, .add, .icon-btn")].map((el) => getComputedStyle(el).webkitTapHighlightColor)`);
  assert.ok(flash.length > 3 && flash.every((c) => c === "rgba(0, 0, 0, 0)"), JSON.stringify(flash));
  // The fields: corner and bottom washes are the glass colour; the middle is 일상's orange or 창작's periwinkle.
  const washes = () => page.eval(`(() => {
    const of = (side) => [...getComputedStyle(document.querySelector(".field." + side), "::before").backgroundImage.matchAll(/radial-gradient\\([^,]*,\\s*(color\\([^)]*\\)|rgba?\\([^)]*\\))/g)].map((m) => m[1]);
    return { daily: of("daily"), creative: of("creative") };
  })()`);
  const light = await washes();
  await page.shot(out("home-kinds-light.png"));
  await page.media(true, false);
  const dark = await washes();
  await page.shot(out("home-kinds-dark.png"));
  for (const [theme, w] of [["light", light], ["dark", dark]]) {
    assert.equal(w.daily[1], "rgb(255, 178, 125)", theme + ": 일상's middle is the light orange");
    assert.equal(w.creative[1], "rgb(185, 198, 255)", theme + ": 창작's middle is the light periwinkle");
    assert.ok(w.daily[0] === w.daily[2] && w.creative[0] === w.daily[0] && w.creative[2] === w.daily[0], theme + ": every corner is the one glass colour: " + JSON.stringify(w));
  }
  assert.notEqual(light.daily[0], dark.daily[0], "the glass wash is lighter in light mode and deeper in dark");
});

scenario("home: a long press on a room offers 열기, 복제, 링크 복사, 화이트보드에 넣기 and 목록에서 빼기; 복제 makes '… 복사본' with the same words; 화이트보드에 넣기 puts its lines on a board", async ({ open }) => {
  const page = await open();
  await createRoom(page, { room: "글 방" });
  await focusEnd(page);
  await page.type("첫 줄");
  await page.key("Enter");
  await page.type("둘째 줄");
  await page.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text() === "첫 줄\\n둘째 줄"`);
  await click(page, "#back");
  await createBoard(page, { room: "모으는 보드" });
  await click(page, "#back");
  await page.waitFor(q('.room-row[data-room-kind="daily-text"]'));
  const holdRow = async (sel) => {
    const at = await page.eval(`(() => { const r = ${q(sel)}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await page.touch("start", [at]);
    await pause(700);
    await page.touch("end");
    await page.waitFor(q("#room-actions"));
  };
  await holdRow('.room-row[data-room-kind="daily-text"]');
  assert.ok(await page.eval(`location.hash === "" || location.hash === "#"`), "the long press did not open the room");
  for (const id of ["room-open", "room-duplicate", "room-copy-link", "room-to-board", "room-forget"]) assert.ok(await page.eval(q("#" + id)), id);
  await click(page, "#room-duplicate");
  await page.waitFor(`[...document.querySelectorAll(".room-row .room-name")].some((n) => n.textContent === "글 방 복사본")`, 10000);
  // Into the whiteboard: its two lines as text.
  await holdRow('.room-row[data-room-kind="daily-text"]');
  await click(page, "#room-to-board");
  await page.waitFor(q("#room-actions [data-board]"));
  await click(page, "#room-actions [data-board]");
  await page.waitFor(`document.querySelector(".toast")?.textContent.includes("2개를 넣었어요")`, 10000);
  // The copy holds the same words.
  const copy = await page.eval(`[...document.querySelectorAll(".room-row")].find((r) => r.querySelector(".room-name").textContent === "글 방 복사본").dataset.id`);
  await click(page, `.room-row[data-id="${copy}"]`);
  await page.waitFor(`${TODAY} && window.__app.session?.sheet(${TODAY}.dataset.day).text() === "첫 줄\\n둘째 줄"`, 10000);
  assert.equal(await text(page, "#room-title"), "글 방 복사본");
  await click(page, "#back");
  const boardId = await page.eval(`window.__app.store.get("rooms", []).find((r) => r.name === "모으는 보드").id`);
  await click(page, `.room-row[data-id="${boardId}"]`);
  await page.waitFor(`window.__app.session?.doc("board").items().filter((i) => i.kind === "note").map((i) => i.text).join("|") === "첫 줄|둘째 줄"`, 10000);
});

scenario("create: on the creative side 노래 만들기 and 화이트보드 are open and 글쓰기 says 준비 중", async ({ open }) => {
  const page = await open();
  await click(page, "#add-creative");
  const kinds = await page.eval(`[...document.querySelectorAll(".kind")].map((b) => [b.dataset.kind, b.disabled, b.querySelector(".soon")?.textContent ?? ""])`);
  assert.deepEqual(kinds, [["creative-song", false, ""], ["creative-writing", true, "준비 중"], ["creative-board", false, ""]]);
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
  // Each comes in the colour nearest their glass (both blue here): the maker blue, the second the next nearest free.
  assert.equal(await myColor(a), PALETTE.findIndex((p) => p.key === "blue"));
  assert.ok(Number.isInteger(await myColor(b)) && (await myColor(b)) !== (await myColor(a)), "another colour");
  await a.waitFor(`window.__app.session.room.members().length === 2`);
  await a.waitFor(`document.querySelectorAll("#people .dot").length === 2`);
});

// 본질 1 (같이): home is the door to the rooms, and the door says who is behind it.
scenario("home: a room's row shows the colours of who is in it once a friend has come; a room of one shows none", async ({ open }) => {
  const a = await open({ dev: "a" });
  const id = await createRoom(a, { room: "같이 쓰는 방" });
  const row = `.room-row[data-id="${id}"]`;
  await click(a, "#back");
  await a.waitFor(q(row));
  assert.equal(await a.eval(`document.querySelectorAll('${row} .room-people .dot').length`), 0, "alone: no dots");
  const b = await open({ dev: "b" });
  await b.waitFor(q("#others .room-row"));
  await click(b, "#others .room-row");
  await joinNew(b, { name: "나래" });
  await b.waitFor(`window.__app.session.room.members().length === 2`);
  await click(b, "#back");
  await b.waitFor(`document.querySelectorAll('${row} .room-people .dot').length === 2`);
  const colours = await b.eval(`[...document.querySelectorAll('${row} .room-people .dot')].map((d) => getComputedStyle(d).backgroundColor)`);
  assert.notEqual(colours[0], colours[1], "each person in their own colour");
  await click(a, row);
  await a.waitFor(`window.__app.session.room.members().length === 2`);
  await click(a, "#back");
  await a.waitFor(`document.querySelectorAll('${row} .room-people .dot').length === 2`);
});

// Rooms made before 15 November gave their maker the first colour (coral): one I am alone in takes mine, once.
scenario("colour: a room I am alone in that gave me the first colour takes my colour once; chosen back, it stays; with a friend in it nothing changes", async ({ open }) => {
  const blue = PALETTE.findIndex((p) => p.key === "blue");
  const asBefore = (page) => page.eval(`(() => { const s = window.__app.session; s.commit("room", [{ t: "mem", id: s.clock.next(), m: s.memberId, k: "color", v: 0 }]); window.__app.store.set("colourFixed", {}); return 1; })()`);
  const a = await open({ dev: "a" });
  const id = await createRoom(a, { room: "옛 방" });
  assert.equal(await myColor(a), blue);
  await asBefore(a);
  await a.waitFor(`window.__app.session.me.color === 0`);
  await click(a, "#back");
  await click(a, `.room-row[data-id="${id}"]`);
  await a.waitFor(`window.__app.session?.me?.color === ${blue}`);
  // Once only: made coral again (as by 내 색), it stays coral.
  await a.eval(`(() => { const s = window.__app.session; s.commit("room", [{ t: "mem", id: s.clock.next(), m: s.memberId, k: "color", v: 0 }]); return 1; })()`);
  await click(a, "#back");
  await click(a, `.room-row[data-id="${id}"]`);
  await a.waitFor(q("#room-title"));
  await frames(a);
  assert.equal(await myColor(a), 0, "chosen back, it stays");
  // With a friend in it, nothing changes.
  await click(a, "#back");
  const other = await createRoom(a, { room: "둘 방" });
  await asBefore(a);
  const b = await open({ dev: "b", hash: "r-" + other });
  await joinNew(b, { name: "나래" });
  await a.waitFor(`window.__app.session.room.members().length === 2`);
  await click(a, "#back");
  await click(a, `.room-row[data-id="${other}"]`);
  await a.waitFor(q("#room-title"));
  await a.front(); // a page behind another draws no frames
  await frames(a);
  assert.equal(await myColor(a), 0, "a room with a friend keeps the colours people know each other by");
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
  assert.equal(await myColor(c), await myColor(a), "the same person, the same colour");
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

scenario("public address with a server: a room made on one phone opens by its link on another, typing shows on both, nobody else's home lists it, and a cut line mends", async ({ open, out, fixtures }) => {
  const view = { query: "server=" + encodeURIComponent(fixtures.server) };
  const [a, b, id] = await together(open, ["나래"], view);
  for (const p of [a, b]) assert.equal(await p.eval(`window.__app.transport.info().kind`), "firebase");
  assert.ok(!(await a.eval(`window.__app.store.get("rooms", []).find((r) => r.id === ${JSON.stringify(id)}).local`)), "the room is not kept on one phone only");
  assert.equal(await a.eval(`window.__app.linkFor(${JSON.stringify(id)}).split("#")[1]`), "r-" + id);
  await focusEnd(a);
  await a.type("서버로 같이 써요");
  await sameOnAll([a, b], "서버로 같이 써요");
  await b.waitFor(`window.__app.session.peers.some((p) => !p.isMe && p.state?.m)`);
  const stored = fixtures.firebase.data().rooms[id];
  assert.equal(stored.meta.name, "우리 방");
  assert.ok(Object.keys(stored.docs).some((d) => d.startsWith("s:")), "the writing is on the server: " + Object.keys(stored.docs));
  // A phone that was never given the link sees no rooms: a room is as private as its link.
  const c = await open({ dev: "c", ...view });
  await c.waitFor(`window.__app.transport?.info().kind === "firebase" && !window.__app.connecting`);
  await c.waitFor(`!${q("#connecting")}`);
  assert.equal(await c.eval(`document.querySelectorAll(".room-row").length`), 0);
  assert.ok(!(await c.eval(q("#notice"))), "no 'only on this device' notice where a server answers");
  // The line is cut: the room says so, keeps what is typed, and sends it when the line is back.
  fixtures.firebase.setDown(true);
  await a.waitFor(`window.__app.session.status === "offline"`, 8000);
  await focusEnd(a);
  await a.type(" 끊겨도");
  fixtures.firebase.setDown(false);
  for (const p of [a, b]) await p.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text() === "서버로 같이 써요 끊겨도"`, 25000);
  await b.waitFor(`window.__app.session.status === "online"`, 25000);
  // Opened again later (a reload), the room comes back from the server.
  await b.eval(`location.reload(), true`);
  await b.waitFor(`window.__app && window.__app.booted && window.__app.session && ${TODAY}`, 10000);
  await sameOnAll([b], "서버로 같이 써요 끊겨도");
  await b.shot(out("server-room.png"));
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
  await sameOnAll([a, b], "하나 ");
  await focusEnd(b);
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
  await sameOnAll([a, b], "가나 ");
  await focusEnd(b);
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
      return { need, draw: draw.scrollHeight, min: parseFloat(getComputedStyle(draw).minHeight) || 0, box: ta.clientHeight, drawBox: draw.clientHeight, scroll: ta.scrollHeight - ta.clientHeight }; })()`);
    assert.ok(Math.abs(Math.max(m.need, m.min) - m.draw) <= 1, JSON.stringify(sample.slice(0, 20)) + " " + JSON.stringify(m));
    // The input box covers the drawn text and never scrolls inside (today's box reaches down
    // the whole page since 15 November, so a tap low on the page writes at the end).
    assert.ok(m.box >= m.drawBox - 1 && m.scroll <= 1, "input box covers the drawn text " + JSON.stringify(m));
  }
});

scenario("time: no hour labels in the margin; a long press on a word says who wrote it, on which day and at what time", async ({ open }) => {
  const [a] = await together(open, []);
  const day = await a.eval(`${TODAY}.dataset.day`);
  const tz = await a.eval(`window.__app.session.room.meta("tz")`);
  assert.equal(await text(a, ".sheet.today .day"), dayLabel(day));
  const base = Date.parse(day + "T00:00:00Z");
  // Find the UTC instants that are 09:10 and 12:20 on this day in the room's zone.
  const local = (h, m) => { for (let t = base - 14 * 3600e3; t < base + 38 * 3600e3; t += 600e3) { const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(t).reduce((o, x) => (o[x.type] = x.value, o), {}); if (`${p.year}-${p.month}-${p.day}` === day && +p.hour === h && +p.minute === m) return t; } throw new Error("no such time"); };
  await writeAt(a, "아침에 쓴 글\n같은 시간에 한 줄 더", local(9, 10));
  await writeAt(a, "\n점심에 쓴 글", local(12, 20));
  await a.waitFor(`${TODAY}.querySelectorAll(".draw .ln").length === 3`);
  assert.equal(await a.eval(`document.querySelectorAll(".stamp").length`), 0, "the margin stays clean");
  // Press and hold on 점심에: who, which day, what time.
  const date = dayLabel(day).split(" ").slice(0, 2).join(" ");
  const at = await a.eval(`(() => { const w = [...${TODAY}.querySelectorAll(".draw .w")].find((x) => x.textContent === "점심에"); const r = w.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await a.touch("start", [at]);
  await pause(700);
  await a.touch("end");
  await a.waitFor(q(".toast"));
  assert.equal(await text(a, ".toast"), `가람 님이 ${date} 오후 12:20에 썼어요`);
  // A quick tap says nothing.
  await a.waitFor(`!${q(".toast")}`, 6000);
  const morning = await a.eval(`(() => { const w = [...${TODAY}.querySelectorAll(".draw .w")].find((x) => x.textContent === "아침에"); const r = w.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await a.touch("start", [morning]);
  await a.touch("end");
  await pause(900);
  assert.ok(!(await a.eval(q(".toast"))), "a tap only puts the caret there");
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
    // The words stay inside the paper (the drawing layer alone reaches a little past its sides, by design),
    // and neither the page nor the room scrolls sideways.
    const m = await a.eval(`(() => { const p = ${TODAY}.querySelector(".paper").getBoundingClientRect(); const words = [...${TODAY}.querySelectorAll(".draw .w")].map((w) => w.getBoundingClientRect()); const body = document.getElementById("room-body"); return { page: document.documentElement.scrollWidth, inner: innerWidth, body: body.scrollWidth - body.clientWidth, right: Math.max(...words.map((r) => r.right)), paperRight: p.right, ta: ${TODAY}.querySelector("textarea").scrollWidth - ${TODAY}.querySelector("textarea").clientWidth }; })()`);
    assert.ok(m.page <= m.inner && m.body <= 0 && m.right <= m.paperRight && m.ta <= 0, JSON.stringify(m));
    if (dark) await a.shot(out("room-dark.png"));
  }
});

// ---- design and error states -----------------------------------------------------

import { contrast, memberColor, INK, PAPER, PALETTE } from "../src/core/paint.js";

/** "rgb(…)", "rgba(…)" or "color(srgb r g b / a)" (what color-mix() computes to) → "#rrggbb". */
const hex = (css) => {
  const m = /color\(srgb ([-\d.e]+) ([-\d.e]+) ([-\d.e]+)/.exec(css);
  const parts = m ? m.slice(1, 4).map((v) => Math.round(Math.min(1, Math.max(0, Number(v))) * 255)) : css.match(/\d+/g).slice(0, 3).map(Number);
  return "#" + parts.map((n) => n.toString(16).padStart(2, "0")).join("");
};

scenario("contrast: ink, muted text and all eight colours read on the paper, light and dark", async ({ open }) => {
  for (const dark of [false, true]) {
    const theme = dark ? "dark" : "light";
    const [a] = await together(open, [], { dark });
    await focusEnd(a);
    await a.type("글자색 확인");
    await a.waitFor(`${TODAY}.querySelector(".draw .w")`);
    const css = await a.eval(`(() => { const cs = getComputedStyle(document.documentElement); const probe = (v) => { const e = document.createElement("i"); e.style.color = v; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
      return { paper: probe(cs.getPropertyValue("--paper")), ink: probe(cs.getPropertyValue("--ink")), muted: probe(cs.getPropertyValue("--muted")),
        word: getComputedStyle(${TODAY}.querySelector(".draw .w")).color, drawInk: getComputedStyle(${TODAY}.querySelector(".draw")).color }; })()`);
    assert.equal(hex(css.paper), PAPER[theme], "the stylesheet and the colour rules agree on the paper");
    assert.equal(hex(css.ink), INK[theme], "and on the ink");
    assert.equal(hex(css.word), memberColor(await myColor(a), theme), "my words in my colour");
    assert.equal(hex(css.drawInk), INK[theme]);
    for (const [name, value] of Object.entries({ ink: css.ink, muted: css.muted, word: css.word })) {
      assert.ok(contrast(hex(value), hex(css.paper)) >= 4.5, `${theme} ${name} ${contrast(hex(value), hex(css.paper)).toFixed(2)}`);
    }
    await click(a, "#room-settings");
    const swatches = await a.eval(`[...document.querySelectorAll(".swatch[data-color]")].map((s) => getComputedStyle(s).backgroundColor)`);
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
  await page.waitFor(`document.querySelector("#notice")?.textContent === "아직 서버가 없어서 방은 이 기기에만 있어요"`);
  // A room made in such a view lives on this device only, so no invitation is offered.
  await createRoom(page, { noInvite: true });
  assert.equal(await text(page, "#banner"), "이 기기에만 있는 방이에요. 다른 기기와는 연결되지 않아요.");
  await focusEnd(page);
  await page.type("혼자 쓰기");
  await sameOnAll([page], "혼자 쓰기");
});

scenario("public page: with no server yet, rooms stay on this device and the screens say so", async ({ open }) => {
  // No ?dev: the page as people open it on a public address (GitHub Pages), before a server exists.
  const page = await open({ dev: "" });
  await page.waitFor(`document.querySelector("#notice")?.textContent === "아직 서버가 없어서 방은 이 기기에만 있어요"`);
  await createRoom(page, { noInvite: true });
  assert.equal(await text(page, "#banner"), "이 기기에만 있는 방이에요. 다른 기기와는 연결되지 않아요.");
  await click(page, "#invite");
  await page.waitFor(q("#invite-local"));
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

scenario("wide screen: lying down or on a computer the app takes the width; the writing stays a 360 column", async ({ open, out }) => {
  const page = await open({ width: 1280, height: 800 });
  await createRoom(page);
  await focusEnd(page);
  await page.type("넓은 화면에서도 가운데 종이 한 장");
  const r = await page.eval(`(() => { const b = document.querySelector("#app").getBoundingClientRect(); const s = document.querySelector(".sheets").getBoundingClientRect(); return { orient: document.documentElement.dataset.orient, width: b.width, height: b.height, sheetLeft: s.left, sheetWidth: s.width, scroll: document.documentElement.scrollWidth, font: parseFloat(getComputedStyle(${TODAY}.querySelector(".draw")).fontSize), rem: parseFloat(getComputedStyle(document.documentElement).fontSize) }; })()`);
  assert.equal(r.orient, "landscape");
  assert.ok(r.width === 1280 && r.height === 800 && r.scroll <= 1280, JSON.stringify(r));
  assert.ok(Math.abs(r.rem - 20) < 0.01 && Math.abs(r.font - 20) < 0.1, "scaled by the height: " + JSON.stringify(r));
  assert.ok(Math.abs(r.sheetWidth - 22.5 * r.rem) <= 1 && Math.abs(r.sheetLeft + r.sheetWidth / 2 - 640) <= 1, "the writing column is 360 wide and centred: " + JSON.stringify(r));
  await page.shot(out("room-wide.png"));
});

scenario("landscape phone: the song room's timeline uses the width and the controls fit the height", async ({ open, out, fixtures }) => {
  const page = await open({ width: 780, height: 360 });
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  const m = await page.eval(`(() => { const t = document.getElementById("timeline").getBoundingClientRect(); const tools = document.getElementById("song-tools").getBoundingClientRect(); return { orient: document.documentElement.dataset.orient, tw: t.width, th: t.height, toolsBottom: tools.bottom, scroll: document.documentElement.scrollWidth }; })()`);
  assert.equal(m.orient, "landscape");
  assert.ok(m.tw > 700 && m.th > 120 && m.toolsBottom <= 360 && m.scroll <= 780, JSON.stringify(m));
  await page.shot(out("song-landscape.png"));
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
const settled = (page) => page.eval(`(() => { const moving = document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.matches(".panel, .toast, .drawer, .float")); return Promise.race([Promise.all(moving.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 500))]).then(() => true); })()`);

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

// ---- glass ---------------------------------------------------------------------------------------

/** "rgb(1, 2, 3)" or "rgba(1, 2, 3, 0.5)" → [r, g, b, a]. */
const rgba = (css) => {
  const m = /color\(srgb ([-\d.e]+) ([-\d.e]+) ([-\d.e]+)(?: \/ ([\d.e]+))?\)/.exec(css);
  if (m) return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255, m[4] === undefined ? 1 : Number(m[4])];
  const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[ ,/]+/).filter(Boolean).map(Number);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
};
/** One colour laid over another, as a hex. */
const over = (top, bottom) => { const [r, g, b, a] = top; const hx = (v) => Math.round(v).toString(16).padStart(2, "0"); return "#" + hx(r * a + bottom[0] * (1 - a)) + hx(g * a + bottom[1] * (1 - a)) + hx(b * a + bottom[2] * (1 - a)); };
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 1];

scenario("glass: the chrome is frosted and blue, and text stays readable on the sheet and on the colour fields", async ({ open, out }) => {
  for (const dark of [false, true]) {
    const theme = dark ? "dark" : "light";
    const [a] = await together(open, [], { dark });
    await focusEnd(a);
    await a.type("유리 위의 글");
    await a.waitFor(`${TODAY}.querySelector(".draw .w")`);
    const css = await a.eval(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const probe = (name) => { const e = document.createElement("i"); e.style.color = "var(" + name + ")"; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
      const look = (sel) => { const e = document.querySelector(sel); if (!e) return null; const s = getComputedStyle(e); return { filter: s.backdropFilter || s.webkitBackdropFilter || "", bg: s.backgroundColor, image: s.backgroundImage, color: s.color }; };
      const tokens = {};
      for (const name of ["--paper", "--ink", "--muted", "--soft", "--sheet", "--accent", "--base", "--daily-b", "--creative-b", "--sky"]) tokens[name] = probe(name);
      return { tokens, strength: parseFloat(cs.getPropertyValue("--field-strength")), bar: look(".room > .bar"), toolbar: look(".toolbar"), paper: look(".paper"), day: look(".day") };
    })()`);
    const t = Object.fromEntries(Object.entries(css.tokens).map(([k, v]) => [k, rgba(v)]));
    const paper = t["--paper"];
    // The colour fields at their strongest, as painted over the paper.
    // (Corners are the glass colour, --sky; the middle is 일상's orange or 창작's periwinkle, the same in both themes,
    // so on near-black the field glows at half strength.)
    const fields = ["--daily-b", "--creative-b", "--sky"].map((name) => [name, hexRgb(over([...t[name].slice(0, 3), css.strength], paper))]);
    assert.ok(css.strength >= 0.45 && css.strength <= 1, "field strength " + css.strength);

    // 1. Text on the writing sheet: the sheet is frosted, so the field behind shows through a little.
    assert.ok(t["--sheet"][3] < 1 && t["--sheet"][3] >= 0.85, "the sheet is translucent but mostly solid: " + t["--sheet"][3]);
    const inks = { ink: hex(css.tokens["--ink"]), muted: hex(css.tokens["--muted"]) };
    for (let i = 0; i < 8; i++) inks["colour " + i] = memberColor(i, theme);
    for (const [fieldName, field] of fields) {
      const surface = over(t["--sheet"], field);
      for (const [name, colour] of Object.entries(inks)) {
        const c = contrast(colour, surface);
        assert.ok(c >= 4.5, `${theme}: ${name} on the sheet over ${fieldName} is ${c.toFixed(2)}`);
      }
    }

    // 2. Text straight on a colour field uses ink or the soft tone, and both read at the field's strongest.
    for (const [fieldName, field] of fields) {
      for (const name of ["--ink", "--soft"]) {
        const c = contrast(hex(css.tokens[name]), over([0, 0, 0, 0], field));
        assert.ok(c >= 4.5, `${theme}: ${name} on ${fieldName} is ${c.toFixed(2)}`);
      }
    }
    assert.equal(hex(css.day.color), hex(css.tokens["--soft"]), "the date above a sheet sits on the field");

    // 3. The chrome is glass: it blurs what is behind it and lets it through.
    for (const [name, el] of [["top bar", css.bar], ["toolbar", css.toolbar]]) {
      assert.match(el.filter, /blur\(/, `${theme}: the ${name} blurs what is behind it`);
      assert.ok(el.image.includes("gradient") || rgba(el.bg)[3] < 1, `${theme}: the ${name} is see-through`);
    }
    // 4. Blue: the accent is a blue, and the ground outside the column leans blue.
    const [ar, ag, ab] = t["--accent"];
    assert.ok(ab > ar + 60 && ab > ag, `${theme}: accent ${css.tokens["--accent"]} is blue`);
    assert.ok(t["--base"][2] > t["--base"][0], `${theme}: the ground leans blue`);
    assert.ok(contrast("#ffffff", hex(css.tokens["--accent"])) >= 4.5, `${theme}: white reads on the accent`);
    await a.shot(out(`glass-room-${theme}.png`));

    await click(a, "#room-settings");
    await settled(a);
    const panel = await a.eval(`(() => { const s = getComputedStyle(document.querySelector(".panel")); return { filter: s.backdropFilter || s.webkitBackdropFilter || "", bg: s.backgroundColor, image: s.backgroundImage, button: getComputedStyle(document.querySelector("#save-pin")).backgroundImage + getComputedStyle(document.querySelector("#save-pin")).backgroundColor }; })()`);
    assert.match(panel.filter, /blur\(/, `${theme}: sheets that slide up are frosted`);
    await a.shot(out(`glass-settings-${theme}.png`));
    await a.key("Escape");
    await click(a, "#back");
    await a.waitFor(q("#by-code"));
    const home = await a.eval(`(() => { const g = (sel) => { const e = document.querySelector(sel); const s = getComputedStyle(e); return { filter: s.backdropFilter || s.webkitBackdropFilter || "", color: s.color }; };
      return { add: g("#add-daily"), pill: g("#by-code"), note: g(".half-note"), when: g(".room-when") }; })()`);
    assert.match(home.add.filter, /blur\(/, `${theme}: the + button is glass`);
    assert.match(home.pill.filter, /blur\(/, `${theme}: the code pill is glass`);
    assert.equal(hex(home.note.color), hex(css.tokens["--soft"]), "notes on the home fields use the soft tone");
    await a.shot(out(`glass-home-${theme}.png`));
  }
});

// ---- song room ------------------------------------------------------------------------------------

/** Makes a song room on the creative side and waits for its timeline. */
async function createSongRoom(page, { room = "우리 노래", name = "가람" } = {}) {
  await click(page, "#add-creative");
  await click(page, '[data-kind="creative-song"]');
  await fill(page, "#room-name", room);
  await fill(page, "#my-name", name);
  await click(page, "#create-room");
  await page.waitFor(`location.hash.startsWith("#r-") && ${q("#invite-done")}`);
  await click(page, "#invite-done");
  await page.waitFor(q("#timeline"));
  return page.eval("location.hash.slice(3)");
}

/** Puts a sound file into the song room as if picked from the phone, and waits for its clip. */
async function importSound(page, file, clips = 1) {
  await page.setFiles("#song-file", [file]);
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === ${clips} && ${q("#song-status")}.hidden`, 20000);
}

/** Makes sure a clip is the chosen one (a tap on a chosen clip would put its menu away). */
async function choose(page, sel) {
  // With another clip's menu open, the first tap only puts that menu away (nothing underneath is chosen).
  for (let i = 0; i < 2 && !(await page.eval(`${q(sel)}.classList.contains("selected")`)); i++) {
    await click(page, sel);
    await page.waitFor(`${q(sel)}.classList.contains("selected") || !${q("#clip-menu")}`).catch(() => {});
  }
  await page.waitFor(`${q(sel)}.classList.contains("selected") && ${q("#clip-menu")}`);
}

const noteNames = (page, sel = ".clip[data-id]") => page.eval(`[...document.querySelectorAll(${JSON.stringify(sel + " .note")})].map((n) => n.textContent)`);
const songClips = (page) => page.eval(`window.__app.session.doc("song").layout().map((c) => ({ id: c.id, start: c.start, length: c.length, lane: c.lane, muted: c.muted, offset: c.offset }))`);

/** Taps the time bar at a time (ms). */
async function tapTime(page, ms) {
  const at = await page.eval(`(() => {
    const tl = document.getElementById("timeline");
    const r = document.getElementById("ruler").getBoundingClientRect();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return { x: r.left + 0.9 * rem + ${ms} / 1000 * Number(tl.dataset.pps), y: r.top + r.height / 2 };
  })()`);
  await page.tap(at.x, at.y);
}

scenario("song: a hummed recording becomes a clip whose bars are the notes sung, named 도레미", async ({ open, out, fixtures }) => {
  for (const dark of [false, true]) {
    const page = await open({ dark, dev: dark ? "d" : "a" });
    await createSongRoom(page);
    // An empty room offers every way in at once: record here, the phone's recorder app, a file.
    await page.waitFor(`!${q("#song-start")}.hidden`);
    assert.equal(await page.eval(`[${q("#start-record")}, ${q("#start-capture")}, ${q("#start-file")}].every((e) => e && e.getBoundingClientRect().height > 30)`), true);
    await importSound(page, fixtures.doremi);
    assert.equal(await page.eval(`${q("#song-start")}.hidden`), true, "the start card goes once there is a clip");
    assert.deepEqual(await noteNames(page), ["도", "레", "미", "파", "솔"]);
    const notes = await page.eval(`[...window.__app.session.doc("song").sources.values()][0].notes.map((n) => [n.p, n.d])`);
    assert.deepEqual(notes.map(([p]) => p), [60, 62, 64, 65, 67]);
    for (const [, d] of notes) assert.ok(Math.abs(d - 450) <= 40, "each note sung 0.45 s lasts " + d + " ms");
    // Higher notes sit higher in the clip.
    const tops = await page.eval(`[...document.querySelectorAll(".clip[data-id] .note")].map((n) => n.getBoundingClientRect().top)`);
    for (let i = 1; i < tops.length; i++) assert.ok(tops[i] < tops[i - 1], "each note above the one before: " + tops.join(", "));
    const fits = await page.eval(`document.documentElement.scrollWidth <= innerWidth && document.getElementById("song-tools").getBoundingClientRect().bottom <= innerHeight`);
    assert.ok(fits, "nothing sticks out of the 360-wide screen");
    await page.shot(out(`song-${dark ? "dark" : "light"}.png`));
  }
});

scenario("song: 원본 | 피아노 at the top right switches between waveform and notes, per device", async ({ open, out, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  const right = await page.eval(`(() => { const r = document.querySelector(".mode-switch").getBoundingClientRect(); return r.right > innerWidth * 0.7 && r.top < 140; })()`);
  assert.ok(right, "the switch sits at the top right");
  assert.equal(await page.eval(`${q("#mode-piano")}.getAttribute("aria-pressed")`), "true", "piano is the default");
  assert.ok(await page.eval(`!!document.querySelector(".clip[data-id] .wave.faint")`), "the original shows faintly behind the notes");
  await click(page, "#mode-original");
  await page.waitFor(`!document.querySelector(".clip[data-id] .note") && document.querySelector(".clip[data-id] .wave:not(.faint)")`);
  assert.equal(await page.eval(`window.__app.store.get("settings", {}).songMode`), "original");
  await page.shot(out("song-original.png"));
  await click(page, "#mode-piano");
  await page.waitFor(`document.querySelectorAll(".clip[data-id] .note").length === 5`);
});

scenario("song: the microphone records a take, notes appear while singing, and the take keeps them", async ({ open, out }) => {
  const page = await open();
  await createSongRoom(page);
  assert.equal(await page.eval(`${q("#record")}.hidden`), false, "the record button is there where a microphone is");
  await click(page, "#record");
  await page.waitFor(q("#rec-clip"), 8000);
  await page.waitFor(`document.querySelectorAll("#rec-clip .note").length >= 2`, 8000);
  await page.shot(out("song-recording.png"));
  await page.waitFor(`document.getElementById("song-clock").textContent >= "0:03.0"`, 8000);
  await click(page, "#record");
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 1`, 8000);
  const notes = await page.eval(`[...window.__app.session.doc("song").sources.values()][0].notes.map((n) => n.p)`);
  assert.deepEqual(notes, [67, 64, 64, 65, 62, 62], "the notes sung into the microphone");
  const blob = await page.eval(`(async () => { const src = [...window.__app.session.doc("song").sources.values()][0]; const kept = await window.__app.blobs.get(src.blob); return kept ? new Uint8Array(kept.data).length : 0; })()`);
  assert.ok(blob > 100000, "the recording itself is kept on this device: " + blob + " bytes");
});

scenario("song: split at the playhead, copy, paste on another row, mute, delete, then undo it all", async ({ open, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  const [first] = await songClips(page);
  await tapTime(page, first.start + 1000);
  await choose(page, ".clip[data-id]");
  await page.waitFor(`${q("#clip-split")} && !${q("#clip-split")}.disabled`);
  await click(page, "#clip-split");
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 2`);
  let clips = await songClips(page);
  assert.ok(Math.abs(clips[0].length - 1000) < 40 && Math.abs(clips[1].offset - clips[0].length) < 1, JSON.stringify(clips));
  assert.deepEqual(await noteNames(page, `.clip[data-id="${clips[1].id}"]`), ["미", "파", "솔"]);

  await choose(page, `.clip[data-id="${clips[1].id}"]`);
  await click(page, "#clip-copy");
  await tapTime(page, 0);
  await choose(page, `.clip[data-id="${clips[0].id}"]`);
  await click(page, "#clip-paste");
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 3`);
  clips = await songClips(page);
  assert.deepEqual(clips.map((c) => c.lane).sort(), [0, 0, 1], "the paste went to the row below, where there was room");

  const pasted = clips.find((c) => c.lane === 1);
  await choose(page, `.clip[data-id="${pasted.id}"]`);
  await click(page, "#clip-mute");
  await page.waitFor(`document.querySelector('.clip[data-id="${pasted.id}"]').classList.contains("muted")`);
  await click(page, "#clip-delete");
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 2`);

  for (let i = 0; i < 4; i++) await click(page, "#undo");
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 1`);
  clips = await songClips(page);
  assert.equal(clips[0].length, first.length, "back to the one clip it was");
  await click(page, "#redo");
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 2`);
});

// The owner: "녹음 저거 직사각형이 지금 빨간색이잖아 저거를 내색깔로" and "녹음 누르면 색깔 바꾸기도".
scenario("song: a recording comes in my colour (the people colour nearest my glass colour, not the first one); 색 gives it another that a friend sees too; 기본 brings mine back; undo", async ({ open, out, fixtures }) => {
  const a = await open({ dev: "a" });
  const id = await createSongRoom(a);
  const blue = PALETTE.findIndex((p) => p.key === "blue");
  assert.equal(await myColor(a), blue, "a blue glass (the default): I am blue, not the first colour (coral)");
  await importSound(a, fixtures.doremi);
  const b = await open({ dev: "b", hash: "r-" + id });
  await joinNew(b, { name: "나래" });
  await b.waitFor(`window.__app.session.doc("song").layout().length === 1`);
  const clipRgb = (p) => p.eval(`(() => { const el = document.querySelector(".clip[data-id]"); const e = document.createElement("i"); e.style.color = getComputedStyle(el).getPropertyValue("--c"); document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; })()`);
  const mine = await clipRgb(a);
  assert.equal(mine, await a.eval(`getComputedStyle(document.querySelector("#people .dot")).backgroundColor`), "the rectangle is in my colour");
  await choose(a, ".clip[data-id]");
  await click(a, "#clip-tint");
  await a.waitFor(q('#clip-menu [data-tint="6"]'));
  assert.equal(await a.eval(`document.getElementById("clip-menu").textContent.trim()`), "←", "only the dots and ← (no 기본 while it is the recorder's colour, no stray words)");
  await a.front();
  await a.shot(out("song-clip-colours.png"));
  const want = await a.eval(`getComputedStyle(document.querySelector('#clip-menu [data-tint="6"]')).backgroundColor`);
  await click(a, '#clip-menu [data-tint="6"]');
  await a.waitFor(`window.__app.session.doc("song").layout()[0].tint === 6`);
  assert.equal(await clipRgb(a), want, "the rectangle takes the colour chosen");
  await b.waitFor(`window.__app.session.doc("song").layout()[0].tint === 6`);
  await b.waitFor(`(() => { const el = document.querySelector(".clip[data-id]"); return el && getComputedStyle(el).getPropertyValue("--c").trim() !== ""; })()`);
  // 기본: whoever recorded it again.
  await choose(a, ".clip[data-id]");
  await click(a, "#clip-tint");
  await click(a, "#clip-tint-none");
  await a.waitFor(`window.__app.session.doc("song").layout()[0].tint === null`);
  assert.equal(await clipRgb(a), mine);
  await click(a, "#undo");
  await a.waitFor(`window.__app.session.doc("song").layout()[0].tint === 6`);
});

// The owner: "15초에 거기 가가지고 그 한번 터치해서… 분할 누르면 거기 딱 이렇게 끊겨서" - the tap is the place.
scenario("song: a tap on a clip puts the playhead where it was tapped, so 분할 cuts there; the menu shows only what can be done now", async ({ open, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  const [first] = await songClips(page);
  // After the import the playhead stands at the end of the take, outside it.
  const at = await page.eval(`(() => {
    const tl = document.getElementById("timeline");
    const r = document.getElementById("ruler").getBoundingClientRect();
    const c = document.querySelector(".clip[data-id]").getBoundingClientRect();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return { x: r.left + 0.9 * rem + ${first.start + 800} / 1000 * Number(tl.dataset.pps), y: c.top + c.height / 2 };
  })()`);
  await page.tap(at.x, at.y);
  await page.waitFor(`${q(".clip[data-id]")}.classList.contains("selected") && ${q("#clip-menu")}`);
  assert.equal(await page.eval(`document.querySelectorAll("#clip-menu button:disabled").length`), 0, "no greyed buttons");
  assert.equal(await page.eval(`!!${q("#clip-paste")}`), false, "nothing copied yet: no 붙여넣기");
  assert.equal(await page.eval(`!!${q("#clip-join")}`), false, "no clip after it: no 잇기");
  await click(page, "#clip-split");
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 2`);
  const clips = await songClips(page);
  assert.ok(Math.abs(clips[0].length - 800) < 40, "cut where the clip was tapped: " + JSON.stringify(clips));
  // Once something is copied and a clip follows on the row, 붙여넣기 and 잇기 are there.
  await choose(page, `.clip[data-id="${clips[0].id}"]`);
  await click(page, "#clip-copy");
  await page.waitFor(`${q("#clip-paste")} && ${q("#clip-join")} && !document.querySelector("#clip-menu button:disabled")`);
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

scenario("song: with a finger too, a held clip moves and a quick drag scrolls", async ({ open, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  const [before] = await songClips(page);
  const where = () => page.eval(`(() => {
    const r = document.querySelector(".clip[data-id]").getBoundingClientRect();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rowH: 5.25 * rem, pps: Number(document.getElementById("timeline").dataset.pps), scroll: document.getElementById("timeline").scrollLeft };
  })()`);
  // A quick finger drag: the timeline scrolls, the clip stays.
  let at = await where();
  await page.touch("start", [[at.x, at.y]]);
  for (let i = 1; i <= 5; i++) await page.touch("move", [[at.x - 20 * i, at.y]]);
  await page.touch("end");
  assert.ok((await where()).scroll > at.scroll, "the timeline scrolled");
  assert.deepEqual((await songClips(page))[0], before, "the clip did not move");
  await page.eval(`document.getElementById("timeline").scrollLeft = 0`);
  // Held past the browser's own long press, then dragged a second later and a row down.
  at = await where();
  await page.touch("start", [[at.x, at.y]]);
  await pause(900);
  await page.waitFor(`document.querySelector(".clip.lifted")`);
  for (let i = 1; i <= 10; i++) await page.touch("move", [[at.x + (at.pps * i) / 10, at.y + (at.rowH * i) / 10]]);
  await page.touch("end");
  await page.waitFor(`window.__app.session.doc("song").layout()[0].lane === 1`);
  const [after] = await songClips(page);
  assert.ok(Math.abs(after.start - before.start - 1000) <= 30, "moved by a second: " + after.start);
});

scenario("song: a clip held and dragged moves in time and to another row; a quick drag scrolls instead", async ({ open, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  const [before] = await songClips(page);
  const where = () => page.eval(`(() => {
    const r = document.querySelector(".clip[data-id]").getBoundingClientRect();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rowH: 5.25 * rem, pps: Number(document.getElementById("timeline").dataset.pps), scroll: document.getElementById("timeline").scrollLeft };
  })()`);
  // A quick drag: the timeline scrolls, the clip stays.
  let at = await where();
  await page.press(at.x, at.y);
  for (let i = 1; i <= 5; i++) await page.moveTo(at.x - 20 * i, at.y);
  await page.release(at.x - 100, at.y);
  assert.ok((await where()).scroll > at.scroll, "the timeline scrolled");
  assert.deepEqual((await songClips(page))[0], before, "the clip did not move");
  await page.eval(`document.getElementById("timeline").scrollLeft = 0`);
  // Held, then dragged: one second later, one row down.
  at = await where();
  await page.press(at.x, at.y);
  await pause(550);
  await page.waitFor(`document.querySelector(".clip.lifted")`);
  for (let i = 1; i <= 10; i++) await page.moveTo(at.x + (at.pps * i) / 10, at.y + (at.rowH * i) / 10);
  await page.release(at.x + at.pps, at.y + at.rowH);
  await page.waitFor(`window.__app.session.doc("song").layout()[0].lane === 1`);
  const [after] = await songClips(page);
  assert.ok(Math.abs(after.start - before.start - 1000) <= 30, "moved by a second: " + after.start);
  await click(page, "#undo");
  await page.waitFor(`window.__app.session.doc("song").layout()[0].lane === 0`);
  assert.equal((await songClips(page))[0].start, before.start);
});

scenario("song: playing moves the playhead and the play button turns into pause", async ({ open, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  await tapTime(page, 0);
  await click(page, "#play");
  await page.waitFor(`${q("#play")}.getAttribute("aria-pressed") === "true"`);
  await page.waitFor(`document.getElementById("song-clock").textContent >= "0:00.8"`, 4000);
  await click(page, "#play");
  await page.waitFor(`${q("#play")}.getAttribute("aria-pressed") === "false"`);
  const stopped = await text(page, "#song-clock");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await text(page, "#song-clock"), stopped, "the playhead stays where it was stopped");
  await click(page, "#to-start");
  assert.equal(await text(page, "#song-clock"), "0:00.0");
});

scenario("song: the tone button switches the piano between 밝게 and 어둡게 and remembers it", async ({ open }) => {
  const page = await open();
  await createSongRoom(page);
  assert.equal(await page.eval(`${q("#tone")}.dataset.tone`), "bright");
  await click(page, "#tone");
  await page.waitFor(`${q("#tone")}.dataset.tone === "dark"`);
  assert.equal(await page.eval(`window.__app.store.get("settings", {}).pianoTone`), "dark");
  await click(page, "#room-settings");
  await page.waitFor(q("#tone-dark"));
  assert.equal(await page.eval(`${q("#tone-dark")}.getAttribute("aria-pressed")`), "true");
  await click(page, "#tone-bright");
  await page.key("Escape");
  assert.equal(await page.eval(`${q("#tone")}.dataset.tone`), "bright");
});

scenario("song: where the page may not use the microphone, the record button says why and offers the phone's recorder app", async ({ open, fixtures }) => {
  const page = await open({ init: "Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });" });
  await createSongRoom(page);
  assert.equal(await page.eval(`${q("#record")}.hidden`), false, "the record button is always there");
  assert.match(await text(page, "#start-mic-reason"), /폰 녹음 앱/);
  await click(page, "#record");
  await page.waitFor(q("#add-sound"));
  assert.match(await text(page, "#add-mic-reason"), /폰 녹음 앱/);
  assert.equal(await page.eval(`${q("#add-record")}.disabled`), true);
  assert.equal(await page.eval(`${q("#add-capture")}.htmlFor + "|" + ${q("#add-file")}.htmlFor`), "song-capture|song-file");
  // What the phone's recorder app hands back comes in like any file.
  await page.setFiles("#song-capture", [fixtures.doremi]);
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 1 && ${q("#song-status")}.hidden`, 20000);
  assert.equal(await page.eval(`!!document.querySelector("#add-sound")`), false, "the sheet closed by itself");
  assert.equal((await noteNames(page)).length, 5);
});

scenario("song: the phone's recorder app is asked for with an audio capture picker, opened by a tap on a label", async ({ open }) => {
  const page = await open();
  await createSongRoom(page);
  const picker = await page.eval(`(() => { const i = document.getElementById("song-capture"); return { type: i.type, accept: i.accept, capture: i.getAttribute("capture"), shown: getComputedStyle(i).display !== "none" }; })()`);
  assert.deepEqual(picker, { type: "file", accept: "audio/*", capture: "user", shown: true }, "a real (if invisible) input, so the label can open it");
  const file = await page.eval(`document.getElementById("song-file").accept`);
  assert.match(file, /audio\/\*/);
  assert.match(file, /\.m4a/);
});

// The owner pressed 크롬에서 열기 inside Claude and got Claude's "페이지를 찾을 수 없습니다" (the page wants its owner's
// login there, and has no microphone anyway): from inside Claude, Chrome gets the public build.
scenario("song: inside Claude, 크롬에서 열기 opens the public build (no login, it records), and says its rooms stay on that device", async ({ open }) => {
  // Claude's page: its runtime, and no microphone for the frame.
  const page = await open({ sandbox: true, init: FAKE_RUNTIME + `Object.defineProperty(Document.prototype, "permissionsPolicy", { configurable: true, get() { return { allowsFeature: (f) => f !== "microphone" }; } });` });
  await createSongRoom(page);
  await page.waitFor(q("#start-open-browser"));
  const link = await page.eval(`document.getElementById("start-open-browser").href`);
  assert.equal(link, "https://raw.githack.com/ajune1028-crypto/-/main/site/index.html");
  assert.match(await text(page, "#start-open-browser"), /녹음되는 공개 주소/);
  assert.ok(await page.eval(q("#start-public-note")), "it says where rooms are kept there");
});

scenario("song: in an app view that opens no file chooser (the Claude app), a tap on 폰 녹음 앱 offers the same room in Chrome; a file that arrives needs no help", async ({ open, out, fixtures }) => {
  // Like the Claude app: the frame keeps the microphone, and a tap on a picker opens nothing.
  const page = await open({ init: `Object.defineProperty(Document.prototype, "permissionsPolicy", { configurable: true, get() { return { allowsFeature: (f) => f !== "microphone" }; } });` });
  const id = await createSongRoom(page);
  await page.waitFor(q("#start-open-browser"));
  const link = await page.eval(`document.getElementById("start-open-browser").href`);
  assert.ok(link.endsWith("#r-" + id), "Chrome gets the same room: " + link);
  assert.equal(await page.eval(`document.getElementById("start-open-browser").target`), "_blank");
  assert.ok(await page.eval(q("#start-copy-link")), "and the link can be copied");
  await page.shot(out("song-start-in-claude.png"));
  // A real tap on 폰 녹음 앱: no chooser comes, so after a moment the page says so and offers the way out.
  const centre = (sel) => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  // (Headless Chrome answers a chooser it cannot show with an instant cancel, as an app view that ignores pickers does.)
  await page.tap(...(await centre("#start-capture")));
  await page.waitFor(q("#picker-help"), 6000);
  assert.ok(await page.eval(`!!document.querySelector("#picker-help #help-open-browser") && !!document.querySelector("#picker-help #help-copy-link")`));
  await settled(page);
  await page.shot(out("song-picker-help.png"));
  await page.key("Escape");
  await page.waitFor(`!${q("#picker-help")}`);
  // Where a chooser does open (Chrome holds it open for the test) and a file comes back, nothing more is said.
  await page.interceptChooser(true);
  await page.tap(...(await centre("#start-file")));
  await page.setFiles("#song-file", [fixtures.doremi]);
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 1`, 20000);
  await pause(3000);
  assert.ok(!(await page.eval(q("#picker-help"))), "no help when the file came");
});

for (const ext of ["m4a", "mp3", "webm"]) {
  scenario(`song: a ${ext} recording (as phones save them) is read and its notes found`, async ({ open, fixtures }) => {
    if (!fixtures[ext]) return console.log(`     (skipped: ffmpeg could not make a ${ext} file here)`);
    const page = await open();
    await createSongRoom(page);
    await importSound(page, fixtures[ext]);
    assert.deepEqual(await noteNames(page), ["도", "레", "미", "파", "솔"]);
  });
}

scenario("song: a friend's device shows the same clips and plays them as piano", async ({ open, fixtures }) => {
  const a = await open({ dev: "a" });
  const id = await createSongRoom(a, { room: "같이 부르는 방" });
  await importSound(a, fixtures.doremi);
  const b = await open({ dev: "b" });
  await b.goto(await localLink(a, "b", id));
  await b.waitFor("window.__app && window.__app.booted");
  await joinNew(b, { name: "나래" });
  await b.waitFor(`document.querySelectorAll(".clip[data-id] .note").length === 5`);
  assert.deepEqual(await noteNames(b), ["도", "레", "미", "파", "솔"]);
  await click(b, "#mode-original");
  await b.waitFor(`${q(".clip[data-id] .clip-note")}?.textContent === "원본은 이 기기에 없어요"`);
  // A change on one side shows on the other.
  await choose(a, ".clip[data-id]");
  await click(a, "#clip-mute");
  await b.waitFor(`document.querySelector(".clip[data-id]").classList.contains("muted")`);
});

// ---- look: black, glass, your own colour, text size ------------------------------------------------

scenario("look: dark is near black; the main button glows, small ones are glass; your colour and text size stay across themes", async ({ open, out }) => {
  const page = await open({ dark: true });
  await createRoom(page, { room: "검은 방" });
  const tokens = await page.eval(`(() => { const s = getComputedStyle(document.documentElement); return { paper: s.getPropertyValue("--paper").trim(), base: s.getPropertyValue("--base").trim() }; })()`);
  assert.equal(tokens.paper, PAPER.dark);
  assert.ok(contrast(tokens.paper, "#000000") < 1.1 && contrast(tokens.base, "#000000") < 1.05, "near black: " + JSON.stringify(tokens));
  await click(page, "#room-settings");
  await settled(page);
  const save = await page.eval(`(() => { const s = getComputedStyle(document.getElementById("save-pin")); return { bg: s.backgroundImage, filter: s.backdropFilter || s.webkitBackdropFilter || "" }; })()`);
  assert.match(save.bg, /gradient/, "the 저장 button is a gradient");
  assert.match(save.filter, /blur/, "and glass");
  await page.shot(out("look-dark-settings.png"));
  // Pick pink: the same colour in dark and in light.
  await click(page, '[data-key="pink"]');
  const darkAccent = await page.eval(`getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()`);
  assert.equal(darkAccent, "#e05298");
  await click(page, '[data-theme-choice="light"]');
  const lightAccent = await page.eval(`getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()`);
  assert.equal(lightAccent, darkAccent, "the chosen colour does not change with the theme");
  // Text size: the writing gets bigger.
  const before = await page.eval(`parseFloat(getComputedStyle(document.querySelector(".layers")).fontSize)`);
  await click(page, '[data-text-size="1.3"]');
  const after = await page.eval(`parseFloat(getComputedStyle(document.querySelector(".layers")).fontSize)`);
  assert.ok(Math.abs(after / before - 1.3) < 0.02, `text ${before} → ${after}`);
  // The glass takes the colour too.
  const sky = await page.eval(`(() => { const e = document.createElement("i"); e.style.color = "var(--sky)"; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; })()`);
  const [r, g, b] = rgba(sky);
  assert.ok(r > b && r > g, "the sky under the halves turns pink: " + sky);
  await page.shot(out("look-light-pink.png"));
  // Remembered after a reload.
  await page.reload();
  await page.waitFor("window.__app && window.__app.booted");
  assert.equal(await page.eval(`getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()`), "#e05298");
  assert.equal(await page.eval(`getComputedStyle(document.documentElement).getPropertyValue("--text-scale").trim()`), "1.3");
});

scenario("glass colours: each of 빨주노초파남보갈핑 and 흑백 tints the room's glass, the same in light and in dark", async ({ open }) => {
  const page = await open();
  await createRoom(page, { room: "유리 방" });
  await click(page, "#room-settings");
  await settled(page);
  const presets = await page.eval(`[...document.querySelectorAll(".swatch[data-key]")].map((b) => [b.dataset.key, b.dataset.accent, b.getAttribute("aria-label")])`);
  assert.deepEqual(presets.map((p) => p[2]), ["빨강", "주황", "노랑", "초록", "파랑", "남색", "보라", "갈색", "핑크", "흑백"]);
  const hue = ([r, g, b]) => {
    const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
    if (!d) return 0;
    const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return h * 60;
  };
  const gap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  // The glass's coloured stop: any stop that is not plain white.
  const tinted = (image) => {
    const stops = [...image.matchAll(/color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)|rgba?\((\d+), (\d+), (\d+)/g)]
      .map((m) => (m[1] !== undefined ? m.slice(1, 4).map(Number) : m.slice(4, 7).map((v) => Number(v) / 255)));
    return stops.find((c) => c.some((v) => v < 0.999));
  };
  for (const theme of ["light", "dark"]) {
    await click(page, `[data-theme-choice="${theme}"]`);
    for (const [key, hex, name] of presets) {
      await click(page, `[data-key="${key}"]`);
      const got = await page.eval(`(() => ({
        accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
        bar: getComputedStyle(document.querySelector(".room > .bar")).backgroundImage,
        pressed: document.querySelector('[data-key="${key}"]').getAttribute("aria-pressed"),
      }))()`);
      assert.equal(got.accent, hex, `${theme} ${name}: the colour is used as chosen`);
      assert.equal(got.pressed, "true", `${theme} ${name}: its swatch shows as chosen`);
      const stop = tinted(got.bar);
      assert.ok(stop, `${theme} ${name}: the glass has a coloured stop: ${got.bar}`);
      const want = hue([1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255));
      assert.ok(gap(hue(stop), want) < 8, `${theme} ${name}: the glass takes the colour (${hue(stop).toFixed(1)}° vs ${want.toFixed(1)}°): ${got.bar}`);
    }
  }
});

// ---- drawing -----------------------------------------------------------------------------------------

// 본질 (5.3): "하나의 텍스트 적을 공간" - today's sheet is the page itself, not a box with dead space under it.
scenario("text room: today's sheet runs to the bottom of the screen, and a tap low on its empty part writes at the end", async ({ open }) => {
  const page = await open();
  await createRoom(page);
  await focusEnd(page);
  await page.type("첫 줄");
  await page.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text() === "첫 줄"`);
  const box = await page.eval(`(() => {
    const b = document.getElementById("room-body").getBoundingClientRect();
    const p = ${TODAY}.querySelector(".paper").getBoundingClientRect();
    return { body: b.bottom, paper: p.bottom, x: p.left + p.width / 2 };
  })()`);
  assert.ok(box.body - box.paper < 40, "the paper reaches the bottom of the room: " + JSON.stringify(box));
  await page.eval(`document.activeElement.blur()`);
  await page.tap(box.x, box.paper - 40);
  await page.waitFor(`document.activeElement?.classList.contains("typing")`);
  await page.type(" 이어서");
  await page.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text() === "첫 줄 이어서"`);
});

scenario("text room: a photo hidden in words sparkles; held 2 seconds it comes out, for the friend too; it can be taken out", async ({ open, out, fixtures }) => {
  const [a, b] = await together(open);
  await focusEnd(a);
  await a.type("우리 바다 갔던 날");
  await a.waitFor(`${TODAY}.querySelectorAll(".draw .w").length >= 4`);
  // Choose 바다 in the box, as a long press would.
  await a.eval(`(() => { const ta = ${TODAY}.querySelector("textarea"); const i = ta.value.indexOf("바다"); ta.focus(); ta.setSelectionRange(i, i + 2); return true; })()`);
  await a.waitFor(`document.activeElement === ${TODAY}.querySelector("textarea")`);
  await a.interceptChooser(true);
  await click(a, "#photo");
  await a.setFiles("#photo-file", [fixtures.photo]);
  await a.waitFor(`${TODAY}.querySelector(".draw .w.sparkle")?.textContent === "바다"`, 8000);
  await b.waitFor(`${TODAY}.querySelector(".draw .w.sparkle")?.textContent === "바다"`, 8000);
  const hold = async (page, ms) => {
    const at = await page.eval(`(() => { const r = ${TODAY}.querySelector(".draw .w.sparkle").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await page.touch("start", [at]);
    await pause(ms);
    await page.touch("end");
  };
  await hold(b, 900);
  assert.ok(!(await b.eval(q("#photo-reveal"))), "not before 2 seconds");
  await hold(b, 2300);
  await b.waitFor(`document.querySelector("#photo-reveal img")?.naturalWidth > 0`);
  assert.match(await text(b, ".reveal-who"), /가람 님이 숨겨 둔 사진/);
  await pause(800);
  await b.shot(out("text-photo-reveal.png"));
  await click(b, "#photo-close");
  await b.waitFor(`!${q("#photo-reveal")}`);
  // The one who hid it takes it out: no sparkle on either screen.
  await hold(a, 2300);
  await a.waitFor(q("#photo-remove"));
  await click(a, "#photo-remove");
  await a.waitFor(`!${TODAY}.querySelector(".draw .w.sparkle")`);
  await b.waitFor(`!${TODAY}.querySelector(".draw .w.sparkle")`, 8000);
});

scenario("text room 선택 도구: chosen words get 표시·사진·녹음·잠금; a highlight and a lock reach the friend, who cannot change locked words; a recording hidden in words sparkles and a 2-second hold plays it in a round player", async ({ open, out, fixtures }) => {
  const [a, b] = await together(open);
  await focusEnd(a);
  await a.type("바다에 갔어 노을이 예뻤어");
  const day = await a.eval(`${TODAY}.dataset.day`);
  const sheet = (page) => `window.__app.session.sheet(${JSON.stringify(day)})`;
  await sameOnAll([a, b], "바다에 갔어 노을이 예뻤어");
  const choose = (page, from, to) => page.eval(`(() => { const ta = ${TODAY}.querySelector("textarea"); ta.focus(); ta.setSelectionRange(${from}, ${to}); document.dispatchEvent(new Event("selectionchange")); return true; })()`);
  // 노을이: 표시 in yellow, then 잠금.
  await choose(a, 7, 10);
  await a.waitFor(`!${q("#sel-tools")}.hidden && ${q("#sel-lock")} && ${q('#sel-tools [data-hl="yellow"]')}`);
  await click(a, '#sel-tools [data-hl="yellow"]');
  await a.waitFor(`${sheet(a)}.marks().length === 1`);
  await b.waitFor(`[...${TODAY}.querySelectorAll('.w.hl[data-hl="yellow"]')].map((w) => w.textContent).join("") === "노을이"`);
  await click(a, "#sel-lock");
  await a.waitFor(`${sheet(a)}.locks().length === 1 && ${q("#sel-unlock")}`);
  await b.waitFor(`${TODAY}.querySelector(".w.locked.lock-end")?.textContent === "노을이"`);
  await a.shot(out("text-marks-locks.png"));
  // The friend cannot remove a locked letter.
  await b.front();
  await b.eval(`(() => { const ta = ${TODAY}.querySelector("textarea"); ta.focus(); ta.setSelectionRange(9, 9); return true; })()`);
  await b.key("Backspace");
  await b.waitFor(`document.querySelector(".toast")?.textContent.includes("잠긴 글")`);
  assert.equal(await b.eval(`${sheet(b)}.text()`), "바다에 갔어 노을이 예뻤어");
  assert.equal(await b.eval(`${TODAY}.querySelector("textarea").value`), "바다에 갔어 노을이 예뻤어");
  // Its locker frees it.
  await a.front();
  await choose(a, 7, 10);
  await a.waitFor(q("#sel-unlock"));
  await click(a, "#sel-unlock");
  await a.waitFor(`${sheet(a)}.locks().length === 0`);
  // A recording from a file into 바다에.
  await choose(a, 0, 3);
  await a.waitFor(q("#sel-sound"));
  await click(a, "#sel-sound");
  await a.waitFor(q("#text-file"));
  await a.setFiles("#text-file", [fixtures.doremi]);
  await a.waitFor(`${sheet(a)}.attachments().some((x) => x.kind === "sound")`, 15000);
  const att = await a.eval(`${sheet(a)}.attachments().find((x) => x.kind === "sound")`);
  assert.ok(att.dur > 1500 && att.dur < 4000, "about as long as the file: " + att.dur);
  await b.waitFor(`window.__app.session.doc("files").file(${JSON.stringify(att.file)}) && ${TODAY}.querySelector(".w.sparkle.sound")?.textContent === "바다에"`, 10000);
  // On the friend's screen: held 2 seconds, the round player comes and plays.
  await b.front();
  const at = await b.eval(`(() => { const r = ${TODAY}.querySelector(".w.sparkle.sound").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await b.press(at[0], at[1]);
  await b.waitFor(q("#sound-reveal .sound-orb.on"), 4000);
  await b.release(at[0], at[1]);
  assert.match(await text(b, "#sound-who"), /가람 님이 숨겨 둔 녹음/);
  await b.shot(out("text-sound-reveal.png"));
  await click(b, "#sound-remove");
  await a.waitFor(`!${sheet(a)}.attachments().some((x) => x.kind === "sound")`);
});

scenario("room 배경: a gradient from 방 설정 lies behind the room for the friend too; my own photo becomes the background on both screens; the paper turns to glass; 없음 takes it away", async ({ open, out, fixtures }) => {
  const [a, b] = await together(open);
  await focusEnd(a);
  await a.type("배경 바꿔 볼까");
  await click(a, "#room-settings");
  await a.waitFor(q("#bg-choices"));
  await click(a, "#bg-2");
  for (const p of [a, b]) await p.waitFor(`${q("#room-bg")}.dataset.bg === "2" && document.querySelector(".room").classList.contains("has-bg")`);
  assert.equal(await a.eval(`${q("#bg-2")}.getAttribute("aria-pressed")`), "true");
  // My own photo: it travels in parts and shows on both screens once whole.
  await a.interceptChooser(true);
  await click(a, "#bg-photo");
  await a.setFiles("#bg-file", [fixtures.photo]);
  for (const p of [a, b]) await p.waitFor(`${q("#room-bg")}.style.backgroundImage.startsWith('url("blob:') && !${q("#room-bg")}.dataset.bg`, 10000);
  const bg = await b.eval(`window.__app.session.room.meta("bg")`);
  assert.ok(bg.f, "a file of the room");
  await a.key("Escape");
  await a.waitFor(`!document.querySelector(".scrim")`);
  const alpha = await a.eval(`(() => { const c = getComputedStyle(${TODAY}.querySelector(".paper")).backgroundColor; const m = /([\\d.]+)\\)$/.exec(c); return c.startsWith("rgba") || c.includes("/") ? Number(m ? m[1] : 1) : 1; })()`);
  assert.ok(alpha < 0.95, "the paper is glass over the background: " + alpha);
  // What shows at a blank spot is the photo, not the room's colour field.
  assert.equal(await a.eval(`getComputedStyle(document.querySelector(".room"), "::before").display`), "none");
  await a.shot(out("room-background.png"));
  await click(a, "#room-settings");
  await a.waitFor(q("#bg-none"));
  await click(a, "#bg-none");
  for (const p of [a, b]) await p.waitFor(`!document.querySelector(".room").classList.contains("has-bg")`);
});

scenario("text room: 사진 with no words chosen hides the photo in the word at the caret; on an empty sheet it says to write first", async ({ open, fixtures }) => {
  const page = await open();
  await createRoom(page);
  await page.interceptChooser(true);
  // An empty sheet: nothing to hide a photo in.
  await click(page, "#photo");
  await page.waitFor(`document.querySelector(".toast")?.textContent.includes("먼저 글을")`);
  await focusEnd(page);
  await page.type("바다에 갔어 노을이 예뻤어");
  const day = await page.eval(`${TODAY}.dataset.day`);
  await page.waitFor(`window.__app.session.sheet(${JSON.stringify(day)}).text() === "바다에 갔어 노을이 예뻤어"`);
  // The caret right after 갔어.
  await page.eval(`(() => { const ta = ${TODAY}.querySelector("textarea"); ta.focus(); ta.setSelectionRange(6, 6); document.dispatchEvent(new Event("selectionchange")); return true; })()`);
  await click(page, "#photo");
  await page.setFiles("#photo-file", [fixtures.photo]);
  await page.waitFor(`window.__app.session.sheet(${JSON.stringify(day)}).attachments().length === 1`, 8000);
  await page.waitFor(`[...${TODAY}.querySelectorAll(".w.sparkle")].map((w) => w.textContent.trim()).join(" ") === "갔어"`);
});

scenario("text room: two fingers never zoom smaller than the screen; with the pen there is room to draw, and lines past the paper are kept whole", async ({ open }) => {
  const [a] = await together(open, []);
  await focusEnd(a);
  await a.type("한 줄");
  const box = () => a.eval(`(() => { const p = ${TODAY}.querySelector(".paper").getBoundingClientRect(); const l = document.getElementById("sheets").getBoundingClientRect(); return { left: p.left, top: p.top, w: p.width, h: p.height, bottom: p.bottom, lw: l.width }; })()`);
  const b0 = await box();
  // Pinching in leaves the page as wide as the screen: no blank space beside it.
  const mid = [b0.left + b0.w / 2, b0.top + 30];
  await a.pinch([[mid[0] - 90, mid[1]], [mid[0] + 90, mid[1]]], [[mid[0] - 30, mid[1]], [mid[0] + 30, mid[1]]]);
  await frames(a);
  assert.ok(Math.abs((await box()).lw - b0.lw) < 1, "no blank space beside the page");
  // Pen on: there is room below the words to draw in (today's sheet is the whole page since
  // 15 November, so the room is the page; a long page grows past its words).
  await click(a, "#pen");
  await a.waitFor(`!${q("#ink-tools")}.hidden`);
  const b2 = await box();
  const below = await a.eval(`(() => { const d = ${TODAY}.querySelector(".draw").getBoundingClientRect(); const p = ${TODAY}.querySelector(".paper").getBoundingClientRect(); return { room: p.bottom - d.bottom, body: document.getElementById("room-body").clientHeight }; })()`);
  assert.ok(below.room > below.body * 0.5, `room to draw below the words: ${JSON.stringify(below)}`);
  // A line from just left of the paper down into the new room.
  const x0 = b2.left - 8;
  const y0 = b2.top + 30;
  const y1 = b2.bottom - 30;
  await a.press(x0, y0);
  for (let i = 1; i <= 10; i++) await a.moveTo(x0 + (120 * i) / 10, y0 + ((y1 - y0) * i) / 10);
  await a.release(x0 + 120, y1);
  const day = await a.eval(`${TODAY}.dataset.day`);
  await a.waitFor(`window.__app.session.doc("k:${day}").strokes().length === 1`);
  const s = await a.eval(`(() => { const st = window.__app.session.doc("k:${day}").strokes()[0]; const rem = parseFloat(getComputedStyle(document.documentElement).fontSize); let lowest = 0; for (let i = 1; i < st.pts.length; i += 3) lowest = Math.max(lowest, st.pts[i]); return { firstX: st.pts[0], lowest: (lowest / 100) * rem }; })()`);
  assert.ok(s.firstX < 0, "the line began left of the paper and was kept: " + s.firstX);
  // Pen off: the paper still holds the whole drawing, and is still the page down to the bottom.
  await click(a, "#pen");
  await frames(a);
  const b3 = await box();
  assert.ok(b3.h >= s.lowest, `the paper holds the drawing: ${b3.h} (lowest point ${s.lowest.toFixed(0)}, with the pen ${b2.h})`);
  const bottom = await a.eval(`document.getElementById("room-body").getBoundingClientRect().bottom`);
  assert.ok(bottom - b3.bottom < 40, `the paper is the page: ${b3.bottom} of ${bottom}`);
});

scenario("text room: two fingers zoom the page, words and drawings together; nothing reflows; the spot between the fingers stays; a line drawn zoomed lands under the finger", async ({ open }) => {
  const [a] = await together(open, []);
  await focusEnd(a);
  await a.type("확대해서 보는 글");
  await a.waitFor(`${TODAY}.querySelector(".draw .w")`);
  const word = () => a.eval(`(() => { const w = ${TODAY}.querySelector(".draw .w"); const r = w.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, lines: ${TODAY}.querySelectorAll(".draw .ln").length }; })()`);
  const w0 = await word();
  const mid = [w0.cx + 30, w0.cy + 30];
  await a.pinch([[mid[0] - 40, mid[1]], [mid[0] + 40, mid[1]]], [[mid[0] - 80, mid[1]], [mid[0] + 80, mid[1]]]);
  await frames(a);
  const w1 = await word();
  assert.ok(Math.abs(w1.w / w0.w - 2) < 0.15, `words twice as big: ${w0.w} → ${w1.w}`);
  assert.equal(w1.lines, w0.lines, "nothing reflowed");
  const drift = Math.hypot(w1.cx - (mid[0] + (w0.cx - mid[0]) * 2), w1.cy - (mid[1] + (w0.cy - mid[1]) * 2));
  assert.ok(drift < 10, `the page grew around the fingers (off by ${drift.toFixed(1)} px)`);
  // Drawing while zoomed: the line starts where the finger did.
  await click(a, "#pen");
  await a.waitFor(`!${q("#ink-tools")}.hidden`);
  const y = w1.y + w1.h + 24;
  const x0 = Math.max(w1.x, 20);
  await a.press(x0, y);
  for (let i = 1; i <= 8; i++) await a.moveTo(x0 + (60 * i) / 8, y);
  await a.release(x0 + 60, y);
  const day = await a.eval(`${TODAY}.dataset.day`);
  await a.waitFor(`window.__app.session.doc("k:${day}").strokes().length === 1`);
  const back = await a.eval(`(() => { const s = window.__app.session.doc("k:${day}").strokes()[0]; const p = ${TODAY}.querySelector(".paper"); const r = p.getBoundingClientRect(); const z = r.width / p.offsetWidth; const rem = parseFloat(getComputedStyle(document.documentElement).fontSize); return { x: r.left + (s.pts[0] / 100) * rem * z, y: r.top + (s.pts[1] / 100) * rem * z, z }; })()`);
  assert.ok(Math.abs(back.x - x0) < 4 && Math.abs(back.y - y) < 4, `the line starts under the finger: ${JSON.stringify(back)} vs ${x0}, ${y}`);
  // A computer: Ctrl+wheel (and a trackpad pinch) zoom back out.
  await click(a, "#pen");
  await a.wheel(w1.cx, w1.cy, 400, { ctrl: true });
  await frames(a);
  assert.ok((await word()).w < w1.w * 0.8, "Ctrl+wheel zooms out");
});

scenario("drawing: a stylus's line ignores a resting palm; with a finger, a second finger zooms and draws nothing", async ({ open }) => {
  const [a] = await together(open, []);
  const box = await a.eval(`(() => { const r = ${TODAY}.querySelector(".paper").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  await click(a, "#pen");
  await a.waitFor(`!${q("#ink-tools")}.hidden`);
  const day = await a.eval(`${TODAY}.dataset.day`);
  const strokes = `window.__app.session.doc("k:${day}").strokes()`;
  const zoom = () => a.eval(`(() => { const p = ${TODAY}.querySelector(".paper"); return p.getBoundingClientRect().width / p.offsetWidth; })()`);
  const x0 = box.x + box.w * 0.15;
  const x1 = box.x + box.w * 0.85;
  const y = box.y + box.h * 0.4;
  const palm = [box.x + box.w * 0.5, box.y + box.h * 0.8];
  const at = (i) => [x0 + ((x1 - x0) * i) / 12, y];
  // A stylus draws; a palm comes down and shifts a little: the line is whole, the page does not zoom.
  await a.front();
  await a.stylus("down", ...at(0));
  for (let i = 1; i <= 4; i++) await a.stylus("move", ...at(i));
  await a.touch("start", [palm]);
  for (let i = 5; i <= 12; i++) {
    await a.touch("move", [[palm[0] + i, palm[1] - i]]);
    await a.stylus("move", ...at(i));
  }
  await a.stylus("up", ...at(12));
  await a.touch("end");
  await a.waitFor(`${strokes}.length >= 1`);
  const s = await a.eval(`(() => {
    const list = ${strokes};
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const xs = [], ys = [];
    for (let i = 0; i < list[0].pts.length; i += 3) { xs.push((list[0].pts[i] * rem) / 100); ys.push((list[0].pts[i + 1] * rem) / 100); }
    return { n: list.length, wide: Math.max(...xs) - Math.min(...xs), tall: Math.max(...ys) - Math.min(...ys) };
  })()`);
  assert.equal(s.n, 1, "one line, nothing from the palm: " + JSON.stringify(s));
  assert.ok(s.tall < 3, "every point lies on the stylus's line: " + JSON.stringify(s));
  assert.ok(Math.abs(s.wide - (x1 - x0)) < 6, "the whole line was kept, start to end: " + JSON.stringify(s));
  assert.ok(Math.abs((await zoom()) - 1) < 0.01, "a palm does not zoom");
  // A finger starts a line, a second finger lands and they spread: a zoom, no line from either.
  const f = [box.x + box.w * 0.3, box.y + box.h * 0.6];
  await a.touch("start", [f]);
  await a.touch("move", [[f[0] + 12, f[1]]]);
  await a.touch("start", [[f[0] + 12, f[1]], [f[0] + 92, f[1]]]);
  for (let i = 1; i <= 6; i++) await a.touch("move", [[f[0] + 12 - i * 8, f[1]], [f[0] + 92 + i * 8, f[1]]]);
  await a.touch("end");
  await frames(a);
  assert.ok((await zoom()) > 1.3, "two fingers zoomed the page");
  assert.equal(await a.eval(`${strokes}.length`), 1, "and drew nothing");
});

scenario("drawing: pen, brushes and both erasers on today's sheet; the other device sees it; undo works", async ({ open, out }) => {
  const [a, b] = await together(open);
  const box = await a.eval(`(() => { const r = ${TODAY}.querySelector(".paper").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  await click(a, "#pen");
  await a.waitFor(`!${q("#ink-tools")}.hidden`);
  await click(a, '[data-ink="blue"]');
  const y = box.y + box.h * 0.5;
  const stroke = async (page, x0, x1, yy) => {
    await page.press(x0, yy);
    for (let i = 1; i <= 10; i++) await page.moveTo(x0 + ((x1 - x0) * i) / 10, yy);
    await page.release(x1, yy);
  };
  await stroke(a, box.x + box.w * 0.2, box.x + box.w * 0.8, y);
  const day = await a.eval(`${TODAY}.dataset.day`);
  const kinds = (page) => page.eval(`window.__app.session.doc("k:${day}").strokes().map((s) => s.b + ":" + s.c)`);
  await a.waitFor(`window.__app.session.doc("k:${day}").strokes().length === 1`);
  assert.deepEqual(await kinds(a), ["pen:blue"]);
  await b.waitFor(`window.__app.session.doc("k:${day}").strokes().length === 1`);
  await b.front();
  const inked = (page) => page.eval(`(() => { const c = ${TODAY}.querySelector("canvas.ink"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; })()`);
  const full = await inked(b);
  assert.ok(full > 200, "the other screen paints the stroke: " + full + " pixels");
  // 부분 지우개 (the default): rubs out only the middle.
  await a.front();
  await click(a, "#eraser");
  assert.equal(await a.eval(`${q('[data-erase="eraser"]')}.getAttribute("aria-pressed")`), "true", "부분 지우개 is the default");
  await stroke(a, box.x + box.w * 0.45, box.x + box.w * 0.55, y);
  await a.waitFor(`window.__app.session.doc("k:${day}").strokes().length === 2`);
  assert.deepEqual(await kinds(a), ["pen:blue", "erase:black"]);
  await b.waitFor(`window.__app.session.doc("k:${day}").strokes().length === 2`);
  await b.front();
  const rubbed = await inked(b);
  assert.ok(rubbed < full * 0.95 && rubbed > full * 0.4, `part of it is gone: ${full} → ${rubbed}`);
  // 획 지우개: a touch removes the whole stroke, and it is remembered.
  await a.front();
  await click(a, '[data-erase="eraser-stroke"]');
  assert.equal(await a.eval(`window.__app.store.get("settings", {}).inkEraser`), "stroke");
  await a.press(box.x + box.w * 0.25, y);
  await a.release(box.x + box.w * 0.25, y);
  await a.waitFor(`!window.__app.session.doc("k:${day}").strokes().some((s) => s.b === "pen")`);
  // A highlighter stroke.
  await click(a, "#eraser");
  await click(a, '[data-brush="highlighter"]');
  await click(a, '[data-ink="yellow"]');
  await stroke(a, box.x + box.w * 0.2, box.x + box.w * 0.7, box.y + box.h * 0.3);
  await a.waitFor(`window.__app.session.doc("k:${day}").strokes().some((s) => s.b === "highlighter" && s.c === "yellow")`);
  await a.front();
  // Drawings lie beneath the words (the owner: 그림은 아래로), and while the pen is on it still
  // reaches the drawing layer through them.
  const layering = await a.eval(`(() => { const p = ${TODAY}.querySelector(".paper"); const c = p.querySelector("canvas.ink"); const l = p.querySelector(".layers"); const r = p.getBoundingClientRect(); return { canvas: Number(getComputedStyle(c).zIndex), words: Number(getComputedStyle(l).zIndex), hit: document.elementFromPoint(r.left + r.width / 2, r.top + 20)?.matches("canvas.ink") }; })()`);
  assert.ok(layering.canvas < layering.words && layering.hit, "drawings under the words, the pen still draws: " + JSON.stringify(layering));
  // The drawing layer covers the paper (and a little past its sides), never more: a canvas that
  // takes its own pixel size as its size would double on every redraw until the phone gives up.
  const layer = await a.eval(`(() => { const c = ${TODAY}.querySelector("canvas.ink").getBoundingClientRect(); const p = ${TODAY}.querySelector(".paper").getBoundingClientRect(); return { cw: c.width, ch: c.height, pw: p.width, ph: p.height }; })()`);
  assert.ok(layer.cw > layer.pw && layer.cw < layer.pw + 40 && Math.abs(layer.ch - layer.ph) < 2, "the layer is the paper's size: " + JSON.stringify(layer));
  await a.shot(out("drawing.png"));
  // Undo: the highlighter goes, then the whole stroke comes back.
  await click(a, "#pen");
  await a.waitFor(`${q("#ink-tools")}.hidden`);
  await click(a, "#undo");
  await click(a, "#undo");
  await a.waitFor(`JSON.stringify(window.__app.session.doc("k:${day}").strokes().map((s) => s.b)) === '["pen","erase"]'`);
  // With the pen off, the sheet takes typing again.
  await focusEnd(a);
  await a.type("글");
  await a.waitFor(`window.__app.session.sheet("${day}").text() === "글"`);
});

scenario("song: 잇기 joins the two halves of a split back into one, and two takes into one clip", async ({ open, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  const [first] = await songClips(page);
  await tapTime(page, first.start + 1000);
  await choose(page, ".clip[data-id]");
  await click(page, "#clip-split");
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 2`);
  const [front] = await songClips(page);
  await choose(page, `.clip[data-id="${front.id}"]`);
  await page.waitFor(`${q("#clip-join")} && !${q("#clip-join")}.disabled`);
  await click(page, "#clip-join");
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 1`);
  assert.equal((await songClips(page))[0].length, first.length);
  // A second take further along the same row, then join the two.
  await tapTime(page, first.length + 1500);
  await click(page, "#import");
  await page.waitFor(q("#add-sound"));
  await page.setFiles("#song-file", [fixtures.doremi]);
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 2 && ${q("#song-status")}.hidden`, 20000);
  const clips = await songClips(page);
  assert.deepEqual(clips.map((c) => c.lane), [0, 0], "both on the first row");
  await choose(page, `.clip[data-id="${clips[0].id}"]`);
  await click(page, "#clip-join");
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 1`, 8000);
  assert.deepEqual(await noteNames(page), ["도", "레", "미", "파", "솔", "도", "레", "미", "파", "솔"]);
  const kept = await page.eval(`(async () => { const s = window.__app.session.doc("song"); const c = s.layout()[0]; const src = s.source(c.src); return !!(src.blob && await window.__app.blobs.get(src.blob)); })()`);
  assert.ok(kept, "the joined recording is kept too, so 원본 plays it");
  await click(page, "#undo");
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 2`);
});

scenario("song: 음 편집 moves a note up a step, adds one, removes one, and undo puts each back", async ({ open, out, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  await choose(page, ".clip[data-id]");
  await click(page, "#clip-notes");
  await page.waitFor(`document.querySelectorAll("#roll-grid .rnote").length === 5`);
  await settled(page);
  await page.shot(out("note-editor.png"));
  // Drag 도 up by two rows: 레.
  const at = await page.eval(`(() => { const n = document.querySelector('#roll-grid .rnote[data-p="60"]'); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 3, y: r.top + r.height / 2, h: r.height + 2 }; })()`);
  await page.press(at.x, at.y);
  for (let i = 1; i <= 6; i++) await page.moveTo(at.x, at.y - (at.h * 2 * i) / 6);
  await page.release(at.x, at.y - at.h * 2);
  await page.waitFor(`window.__app.session.doc("song").notesOf(window.__app.session.doc("song").layout()[0].src)[0].p === 62`);
  await page.waitFor(`document.querySelectorAll(".clip[data-id] .note")[0].textContent === "레"`);
  // Double-tap an empty spot high up: a new note.
  const spot = await page.eval(`(() => { const g = document.getElementById("roll-grid").getBoundingClientRect(); return { x: g.left + 30, y: g.top + 8 }; })()`);
  await page.dblTap(spot.x, spot.y);
  await page.waitFor(`window.__app.session.doc("song").notesOf(window.__app.session.doc("song").layout()[0].src).length === 6`);
  // Choose 솔 and delete it.
  await click(page, '#roll-grid .rnote[data-p="67"]');
  await click(page, "#note-delete");
  await page.waitFor(`window.__app.session.doc("song").notesOf(window.__app.session.doc("song").layout()[0].src).length === 5`);
  await page.key("Escape");
  for (let i = 0; i < 3; i++) await click(page, "#undo");
  await page.waitFor(`JSON.stringify(window.__app.session.doc("song").notesOf(window.__app.session.doc("song").layout()[0].src).map((n) => n.p)) === "[60,62,64,65,67]"`);
});

scenario("song 박자: tempo and meter from the clock; bars on the ruler; tap and 노래에서 찾기; the metronome clicks; clips snap; 박자 맞추기; one undo step", async ({ open, out, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  const song = `window.__app.session.doc("song")`;
  const tempo = () => page.eval(`JSON.stringify(${song}.tempo())`);
  assert.equal(await text(page, "#beat-label"), "♩ 박자");
  await click(page, "#beat");
  await page.waitFor(q("#beat-sheet"));
  await fill(page, "#bpm-input", "120");
  await page.key("Enter");
  await page.waitFor(`${song}.tempo()?.bpm === 120`);
  await click(page, "#meter-3-4");
  await page.waitFor(`${song}.tempo()?.beats === 3`);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll("#ruler .tick.named")].slice(0, 3).map((t) => t.textContent)`), ["1", "2", "3"], "bars on the ruler");
  // Tap tempo: five taps half a second apart.
  const tapAt = await page.eval(`(() => { const r = document.getElementById("tap-tempo").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  for (let i = 0; i < 5; i++) { await page.tap(...tapAt); await pause(500); }
  const tapped = JSON.parse(await tempo()).bpm;
  assert.ok(tapped >= 105 && tapped <= 125, "tapped about 120: " + tapped);
  // 노래에서 찾기: 도레미 was sung a note every 0.45 s or so.
  await click(page, "#guess-tempo");
  await page.waitFor(`${song}.tempo()?.bpm >= 120 && ${song}.tempo()?.bpm <= 145`);
  await fill(page, "#bpm-input", "120");
  await page.key("Enter");
  await page.waitFor(`${song}.tempo()?.bpm === 120`);
  await click(page, 'label[for="metronome"]');
  assert.equal(await page.eval(`window.__app.store.get("settings", {}).metronome`), true);
  await settled(page);
  await page.shot(out("song-beat-sheet.png"));
  await page.key("Escape");
  await page.waitFor(`!document.getElementById("beat-sheet")`);
  assert.match(await text(page, "#beat-label"), /^♩120 · 1\.1$/);
  // All of that is one step to undo.
  await click(page, "#undo");
  await page.waitFor(`${song}.tempo() === null`);
  await click(page, "#redo");
  await page.waitFor(`${song}.tempo()?.bpm === 120 && ${song}.tempo()?.beats === 3`);
  // The metronome clicks while playing.
  await click(page, "#play");
  await page.waitFor(`(window.__app.player?.clicked || 0) >= 2`, 4000);
  await click(page, "#play");
  // A clip moved by hand lands on the grid (an eighth at 120 is 250 ms).
  await click(page, "#to-start");
  const at = await page.eval(`(() => { const r = document.querySelector(".clip[data-id]").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, pps: Number(document.getElementById("timeline").dataset.pps) }; })()`);
  await page.press(at.x, at.y);
  await pause(550);
  await page.waitFor(`document.querySelector(".clip.lifted")`);
  for (let i = 1; i <= 8; i++) await page.moveTo(at.x + (at.pps * 0.37 * i) / 8, at.y);
  await page.release(at.x + at.pps * 0.37, at.y);
  await page.waitFor(`${song}.layout()[0].start > 0`);
  assert.equal((await page.eval(`${song}.layout()[0].start`)) % 250, 0, "on the grid");
  // 박자 맞추기 in 음 편집: every note starts and ends on the grid; one undo puts them back.
  const before = await page.eval(`JSON.stringify(${song}.notesOf(${song}.layout()[0].src).map((n) => [n.t, n.d]))`);
  await choose(page, ".clip[data-id]");
  await click(page, "#clip-notes");
  await page.waitFor(`document.querySelectorAll("#roll-grid .rnote").length === 5 && !document.getElementById("quantize").hidden`);
  assert.ok(await page.eval(`document.getElementById("roll-grid").classList.contains("beats")`), "beat lines in the roll");
  await click(page, "#quantize");
  await page.waitFor(`(() => { const c = ${song}.layout()[0]; return ${song}.notesOf(c.src).every((n) => (c.start + n.t - c.offset) % 250 === 0 && n.d % 250 === 0); })()`);
  await page.key("Escape");
  await click(page, "#undo");
  await page.waitFor(`JSON.stringify(${song}.notesOf(${song}.layout()[0].src).map((n) => [n.t, n.d])) === ${JSON.stringify(before)}`);
});

scenario("song: the speed button plays 1.5x, 2x, 3x and 0.5x, and at 2x the playhead runs twice as fast", async ({ open, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  assert.equal(await text(page, "#speed"), "1×");
  await click(page, "#speed");
  assert.equal(await text(page, "#speed"), "1.5×");
  await click(page, "#speed");
  assert.equal(await text(page, "#speed"), "2×");
  assert.equal(await page.eval(`window.__app.store.get("settings", {}).songSpeed`), 2);
  await tapTime(page, 0);
  await click(page, "#play");
  const t0 = Date.now();
  await page.waitFor(`document.getElementById("song-clock").textContent >= "0:01.6"`, 4000);
  assert.ok(Date.now() - t0 < 1500, "1.6 s of song in well under 1.6 s");
  await click(page, "#play");
  await click(page, "#speed");
  assert.equal(await text(page, "#speed"), "3×");
  await click(page, "#speed");
  assert.equal(await text(page, "#speed"), "0.5×");
});

scenario("song: on a computer the wheel zooms time, Alt+wheel makes rows taller, Shift+wheel moves sideways", async ({ open, fixtures }) => {
  const page = await open({ width: 1024, height: 700 });
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  const pps = () => page.eval(`Number(document.getElementById("timeline").dataset.pps)`);
  const before = await pps();
  // Low on the timeline, away from the clip and its menu.
  const box = await page.eval(`(() => { const r = document.getElementById("timeline").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom - 30 }; })()`);
  await page.wheel(box.x, box.y, -300);
  assert.ok((await pps()) > before * 1.5, "zoomed in");
  const tall = await page.eval(`document.querySelector(".clip[data-id]").getBoundingClientRect().height`);
  await page.wheel(box.x, box.y, -300, { alt: true });
  assert.ok((await page.eval(`document.querySelector(".clip[data-id]").getBoundingClientRect().height`)) > tall * 1.5, "rows taller");
  await page.wheel(box.x, box.y, 200, { shift: true });
  assert.ok((await page.eval(`document.getElementById("timeline").scrollLeft`)) > 0, "moved sideways");
});

/** Two animation frames: what a gesture changed is on screen. */
const frames = (page) => page.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);

scenario("song: two fingers on a rectangle zoom it (sideways = time, up and down = rows); nothing scrolls away, moves or opens", async ({ open, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  const clips0 = await songClips(page);
  const view = () => page.eval(`(() => {
    const tl = document.getElementById("timeline");
    const box = tl.getBoundingClientRect();
    const c = document.querySelector(".clip[data-id]").getBoundingClientRect();
    const r = document.getElementById("ruler").getBoundingClientRect();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const left = Math.max(c.left, box.left), right = Math.min(c.right, box.right);
    return { pps: Number(tl.dataset.pps), x: (left + right) / 2, seen: right - left, y: c.top + c.height / 2, h: c.height, zero: r.left + 0.9 * rem,
      lifted: !!document.querySelector(".clip.lifted"), menu: !!document.getElementById("clip-menu"), chosen: !!document.querySelector(".clip.selected") };
  })()`);
  const msAt = (v, x) => ((x - v.zero) / v.pps) * 1000;
  const v0 = await view();
  assert.ok(v0.seen > 90, "room for two fingers on the clip: " + JSON.stringify(v0));
  // Sideways, both fingers on the rectangle: 60 px apart spread to 150 px is 2.5 times the time.
  // (Importing chose the clip and opened its menu; a pinch must leave that as it was.)
  const t0 = msAt(v0, v0.x);
  // One finger stays put and the other spreads away, as thumbs often do.
  await page.pinch([[v0.x - 30, v0.y], [v0.x + 30, v0.y]], [[v0.x - 30, v0.y], [v0.x + 120, v0.y]]);
  await frames(page);
  const v1 = await view();
  assert.ok(Math.abs(v1.pps / v0.pps - 2.5) < 0.2, `time zoomed 2.5 times: ${v0.pps} -> ${v1.pps}`);
  const drift = (Math.abs(msAt(v1, v0.x) - t0) / 1000) * v1.pps;
  assert.ok(drift < 12, `the moment under the fingers stays under them (moved ${drift.toFixed(1)} px)`);
  assert.ok(Math.abs(v1.h - v0.h) < 2, "rows keep their height while time zooms");
  // Up and down: the rows grow, time stays.
  await page.pinch([[v1.x, v1.y - 22], [v1.x, v1.y + 22]], [[v1.x, v1.y - 45], [v1.x, v1.y + 45]]);
  await frames(page);
  const v2 = await view();
  assert.ok(v2.h > v1.h * 1.7, `rows taller: ${v1.h} -> ${v2.h}`);
  assert.ok(Math.abs(v2.pps - v1.pps) < 0.5, "an up-and-down pinch leaves time alone");
  // Nothing was picked up, chosen, opened, closed or moved.
  for (const v of [v1, v2]) assert.ok(!v.lifted && v.menu === v0.menu && v.chosen === v0.chosen, JSON.stringify({ v0, v }));
  assert.deepEqual(await songClips(page), clips0);
  // Holding anywhere on the timeline selects no text, which would cancel the touch on phones.
  assert.equal(await page.eval(`getComputedStyle(document.getElementById("timeline")).userSelect`), "none");
});

scenario("song: two fingers in 음 편집 zoom the roll and never move, stretch or add a note", async ({ open, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  await choose(page, ".clip[data-id]");
  await click(page, "#clip-notes");
  await page.waitFor(`document.querySelectorAll("#roll-grid .rnote").length === 5`);
  await settled(page);
  const notes = () => page.eval(`JSON.stringify(window.__app.session.doc("song").notesOf(window.__app.session.doc("song").layout()[0].src).map((n) => [n.t, n.d, n.p]))`);
  const box = (p) => page.eval(`(() => { const r = document.querySelector('#roll-grid .rnote[data-p="${p}"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
  const n0 = await notes();
  // One finger on 도, one on 미, spreading sideways.
  const a = await box(60);
  const b = await box(64);
  await page.pinch([[a.x, a.y], [b.x, b.y]], [[a.x - 30, a.y], [b.x + 60, b.y]]);
  await frames(page);
  assert.equal(await notes(), n0, "no note moved or stretched");
  assert.ok((await box(64)).w > b.w * 1.4, "time zoomed in");
  // Pinching in over an empty spot: the two lifts land close together, but that is no double tap.
  const g = await page.eval(`(() => { const g = document.getElementById("roll-grid").getBoundingClientRect(); const r = document.getElementById("roll").getBoundingClientRect(); return { x: Math.max(g.left, r.left), y: Math.max(g.top, r.top) + 8 }; })()`);
  await page.pinch([[g.x + 30, g.y], [g.x + 150, g.y]], [[g.x + 85, g.y], [g.x + 95, g.y]]);
  await frames(page);
  assert.equal(await notes(), n0, "no note added");
  assert.equal(await page.eval(`document.querySelectorAll("#roll-grid .rnote").length`), 5);
  // A long press on a note picks it up; it must not select the note's name instead (that cancels the touch on phones).
  assert.equal(await page.eval(`getComputedStyle(document.getElementById("roll")).userSelect`), "none");
});

scenario("song: a locked clip cannot be deleted, cut or moved, and its locker unlocks it", async ({ open, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  await choose(page, ".clip[data-id]");
  await click(page, "#clip-lock");
  await page.waitFor(`window.__app.session.doc("song").layout()[0].locked === true`);
  // A locked clip's menu has no 삭제 and no 분할 at all (what cannot be done is not shown).
  await page.waitFor(`!${q("#clip-delete")} && !${q("#clip-split")} && ${q("#clip-lock")}.textContent === "잠금 풀기"`);
  await click(page, "#clip-lock");
  await page.waitFor(`window.__app.session.doc("song").layout()[0].locked === false && ${q("#clip-delete")} && !${q("#clip-delete")}.disabled`);
});

scenario("song: while a friend records, their row shows it growing with their name", async ({ open }) => {
  const a = await open({ dev: "a" });
  const id = await createSongRoom(a, { room: "같이 녹음" });
  const b = await open({ dev: "b" });
  await b.goto(await localLink(a, "b", id));
  await b.waitFor("window.__app && window.__app.booted");
  await joinNew(b, { name: "나래" });
  await b.waitFor(q("#timeline"));
  await a.front();
  await click(a, "#record");
  await a.waitFor(q("#rec-clip"), 8000);
  await b.waitFor(`document.querySelector(".clip.other-rec .rec-name")?.textContent === "가람 녹음 중"`, 8000);
  const w1 = await b.eval(`document.querySelector(".clip.other-rec").getBoundingClientRect().width`);
  await new Promise((r) => setTimeout(r, 700));
  const w2 = await b.eval(`document.querySelector(".clip.other-rec").getBoundingClientRect().width`);
  assert.ok(w2 > w1, "it grows");
  await a.front();
  await click(a, "#record");
  await b.waitFor(`!document.querySelector(".clip.other-rec") && document.querySelectorAll(".clip[data-id]").length === 1`, 8000);
});

// ---- whiteboard -----------------------------------------------------------------------------------

async function createBoard(page, { room = "우리 보드", name = "가람" } = {}) {
  await click(page, "#add-creative");
  await click(page, '[data-kind="creative-board"]');
  await fill(page, "#room-name", room);
  await fill(page, "#my-name", name);
  await click(page, "#create-room");
  await page.waitFor(`location.hash.startsWith("#r-") && ${q("#invite-done")}`);
  await click(page, "#invite-done");
  await page.waitFor(q("#board"));
  return page.eval("location.hash.slice(3)");
}

/** Writes on the board where the writing opened (in place, since 15 November), then ends it. */
async function writeMemo(page, text) {
  await page.waitFor(`document.activeElement?.id === "board-typing"`);
  await page.type(text);
  await page.key("Escape");
  await page.waitFor(`!${q("#board-typing")}`);
}

// 본질 5.5: "엄청 크게… 무한적으로" - the board is the whole screen and the bars float over it.
scenario("whiteboard: the board runs to every edge of the screen under the floating bars; new cards and 모두 보기 keep to the part in view", async ({ open }) => {
  const page = await open();
  await createBoard(page);
  const edges = await page.eval(`(() => { const b = document.getElementById("board").getBoundingClientRect(); return [b.left, innerWidth - b.right, b.top, innerHeight - b.bottom].map((v) => Math.round(v)); })()`);
  assert.ok(edges.every((v) => v <= 1), "edge to edge: " + edges);
  const inView = () => page.eval(`(() => { const v = document.getElementById("room-body").getBoundingClientRect(); return [...document.querySelectorAll(".card")].map((c) => { const r = c.getBoundingClientRect(); return r.top >= v.top - 1 && r.bottom <= v.bottom + 1; }); })()`);
  for (const memo of ["하나", "둘"]) {
    await click(page, "#add-note");
    await writeMemo(page, memo);
  }
  assert.deepEqual(await inView(), [true, true], "new cards land in the part in view, below the bars");
  await click(page, "#mode-move");
  await click(page, "#board-fit");
  await frames(page);
  assert.deepEqual(await inView(), [true, true], "모두 보기 shows them in the part in view");
  await click(page, "#mode-all");
});

// The owner: "많이 확대 및 축소하거나 옆으로 옮기면서 할 때 배열들이 이상하게… 선들이 이상하게".
scenario("whiteboard zoom: zoomed far in, cards stay beneath the bars; the 노래 stretch belongs to 노래 (other modes show the true places); order lines follow a card while it is dragged; loop chips shrink when zoomed out", async ({ open, fixtures }) => {
  const page = await open({ width: 600, height: 800 });
  await songThenBoard(page, fixtures);
  await click(page, "#mode-song");
  for (let n = 1; n <= 2; n++) {
    await click(page, "#my-songs");
    await page.waitFor(`document.querySelector("#song-drawer .song-pick")`, 8000);
    await click(page, "#song-drawer .song-pick");
    await page.waitFor(`document.querySelectorAll(".card.song").length === ${n} && !document.getElementById("song-drawer")`);
  }
  const board = `window.__app.session.doc("board")`;
  await click(page, "#mode-link");
  for (let n = 0; n < 2; n++) { const c = await cardBox(page, n); await page.tap(c.cx, c.cy + 20); await frames(page); }
  await page.waitFor(`${board}.links().length === 1`);
  // 노래 stretches the songs sideways; back in 전체 they stand where they really are.
  await click(page, "#mode-all");
  const plain = await cardBox(page, 1);
  await click(page, "#mode-song");
  await click(page, "#stretch-in");
  await click(page, "#stretch-in");
  const stretched = await cardBox(page, 1);
  assert.ok(stretched.w > plain.w * 1.8, "stretched in 노래: " + plain.w + " → " + stretched.w);
  await click(page, "#mode-all");
  await frames(page);
  const back = await cardBox(page, 1);
  assert.ok(Math.abs(back.w - plain.w) < 1, "전체 shows the true size: " + JSON.stringify({ plain, back }));
  await click(page, "#mode-song");
  await frames(page);
  assert.ok(Math.abs((await cardBox(page, 1)).w - stretched.w) < 1, "노래 keeps its own stretch");
  await click(page, "#mode-all");
  // Zoomed far in, nothing of the cards shows over the bars.
  const v = await page.eval(`(() => { const r = document.getElementById("room-body").getBoundingClientRect(); return [r.left + r.width / 2, r.top + 40]; })()`);
  for (let i = 0; i < 16; i++) await page.wheel(v[0], v[1], -200);
  await frames(page);
  const over = await page.eval(`(() => { const out = []; for (const el of document.querySelectorAll("#room-top button, .room > .bar button")) { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (hit && hit.closest(".board")) out.push(el.id || el.textContent); } return out; })()`);
  assert.deepEqual(over, [], "the bars stay on top of the board");
  // Zoomed out, a loop's chip gets smaller with the board.
  for (let i = 0; i < 30; i++) await page.wheel(v[0], v[1] + 200, 200);
  await frames(page);
  // An order line follows a card while it is dragged.
  for (let i = 0; i < 10; i++) await page.wheel(v[0], v[1] + 200, -200);
  await frames(page);
  await click(page, "#mode-move");
  await click(page, "#board-fit");
  await click(page, "#mode-all");
  await frames(page);
  const card = await cardBox(page, 0);
  const d0 = await page.eval(`document.querySelector(".board-lines path").getAttribute("d")`);
  await page.press(card.cx, card.cy + 20);
  for (let i = 1; i <= 6; i++) await page.moveTo(card.cx, card.cy + 20 + i * 15);
  const d1 = await page.eval(`document.querySelector(".board-lines path").getAttribute("d")`);
  assert.notEqual(d1, d0, "the line moved with the card before it was let go");
  await page.release(card.cx, card.cy + 110);
  await page.waitFor(`${board}.items().some((i) => i.y > 40)`);
});

// The owner: "곡, 텍스트, 그림, 전체… 순서 정리… 붙여넣기… 처음 부분과 끝부분이 엄청 미세하게 가깝다거나… 다른 손가락으로
// 한 번 터치… 왼쪽 딸깍을 누르고 있다가 오른쪽 딸깍… 빛나면서 네온 같이… 노래 모드에서 그 올가미 선택한 부분만".
scenario("whiteboard 올가미 closing and kinds: brought back to its start it closes before the lift and shines; a second finger's tap and a right click close it too; 곡·글·그림·전체 decide what 지우기 and a drag take (drawings move with it); 붙여넣기 puts what was copied inside; in 노래 only its part plays", async ({ open, fixtures }) => {
  const page = await open({ width: 600, height: 800 });
  await songThenBoard(page, fixtures);
  await click(page, "#mode-song");
  await click(page, "#my-songs");
  await page.waitFor(`document.querySelector("#song-drawer .song-pick")`, 8000);
  await click(page, "#song-drawer .song-pick");
  await page.waitFor(`document.querySelectorAll(".card.song").length === 1 && !document.getElementById("song-drawer")`);
  const board = `window.__app.session.doc("board")`;
  await click(page, "#mode-all");
  await click(page, "#add-note");
  await writeMemo(page, "가사");
  // A drawing beside them.
  await click(page, "#board-pen");
  const v = await page.eval(`(() => { const r = document.getElementById("room-body").getBoundingClientRect(); const c = [...document.querySelectorAll(".card")].map((e) => e.getBoundingClientRect()); return { l: Math.min(...c.map((r) => r.left)), t: Math.min(...c.map((r) => r.top)), r: Math.max(...c.map((r) => r.right)), b: Math.max(...c.map((r) => r.bottom)), bottom: r.bottom }; })()`);
  await page.press(v.l + 10, v.b + 30);
  for (let i = 1; i <= 6; i++) await page.moveTo(v.l + 10 + i * 15, v.b + 30 + (i % 2) * 8);
  await page.release(v.l + 100, v.b + 30);
  await page.waitFor(`window.__app.session.doc("k:board").strokes().length === 1`);
  await click(page, "#board-pen");
  await click(page, "#mode-lasso");
  // Round everything, coming right back to the start: it closes (and shines) before the finger lifts.
  const box = { l: v.l - 16, t: v.t - 16, r: Math.min(v.r + 16, 520), b: v.b + 60 };
  const ring = [[box.l, box.t], [box.r, box.t], [box.r, box.b], [box.l, box.b], [box.l, box.t + 4]];
  await page.touch("start", [ring[0]]);
  for (let k = 1; k < ring.length; k++) for (let i = 1; i <= 8; i++) await page.touch("move", [[ring[k - 1][0] + ((ring[k][0] - ring[k - 1][0]) * i) / 8, ring[k - 1][1] + ((ring[k][1] - ring[k - 1][1]) * i) / 8]]);
  await page.waitFor(`${board}.lassos().length === 1`);
  assert.ok(await page.eval(`!!document.querySelector(".board-loops path.neon")`), "it shines when it closes");
  await page.touch("end");
  const loop = await page.eval(`${board}.lassos()[0].id`);
  assert.equal(await text(page, `[id="lasso-kind-${loop}"]`), "전체 3", "전체: the song, the text and the drawing");
  // 글 only: 지우기 takes the text and nothing else.
  await click(page, `[id="lasso-kind-${loop}"]`);
  await click(page, '#lasso-kinds [data-loop-kind="note"]');
  await page.waitFor(`${q(`[id="lasso-kind-${loop}"]`)}.textContent === "글 1"`);
  assert.ok(await page.eval(`${q(`[id="lasso-play-${loop}"]`)}.hidden`), "no ▶ while it takes text only");
  await click(page, `[id="lasso-more-${loop}"]`);
  await click(page, "#lasso-delete");
  await page.waitFor(`${board}.items().length === 1 && window.__app.session.doc("k:board").strokes().length === 1`);
  // 그림 only: a drag inside moves the drawing, not the song card.
  await click(page, `[id="lasso-kind-${loop}"]`);
  await click(page, '#lasso-kinds [data-loop-kind="draw"]');
  const songY = await page.eval(`${board}.items()[0].y`);
  const x0 = await page.eval(`window.__app.session.doc("k:board").strokes()[0].pts[0]`);
  const inside = [box.l + 30, box.b - 10];
  await page.touch("start", [inside]);
  for (let i = 1; i <= 6; i++) await page.touch("move", [[inside[0] + i * 10, inside[1]]]);
  await page.touch("end");
  await page.waitFor(`window.__app.session.doc("k:board").strokes()[0].pts[0] !== ${x0}`);
  assert.equal(await page.eval(`${board}.items()[0].y`), songY, "the song card stayed");
  // 붙여넣기: a copied song goes inside the loop, and the loop goes round it.
  await click(page, `[id="lasso-kind-${loop}"]`);
  await click(page, '#lasso-kinds [data-loop-kind="song"]');
  const lid = await page.eval(`${board}.lassos()[0].id`);
  await click(page, `[id="lasso-more-${lid}"]`);
  await click(page, "#lasso-copy");
  await click(page, `[id="lasso-more-${lid}"]`);
  await click(page, "#lasso-paste");
  await page.waitFor(`${board}.items().filter((i) => i.kind === "song").length === 2 && ${board}.lassos().length === 1`);
  const now = await page.eval(`${board}.lassos()[0].id`);
  await page.waitFor(`document.querySelector('[id="lasso-play-${now}"]')?.textContent.startsWith("▶ 2곡")`);
  // In 노래, the loop's part only: what is outside dims.
  await click(page, "#mode-song");
  await page.waitFor(`document.getElementById("board-content").classList.contains("focus")`);
  await page.waitFor(q("#song-focus"));
  await click(page, "#song-focus");
  await page.waitFor(`!document.getElementById("board-content").classList.contains("focus")`);
  // A second finger's quick tap closes a loop being drawn while the first finger is still down.
  await click(page, "#mode-lasso");
  const empty = await page.eval(`(() => { const r = document.getElementById("room-body").getBoundingClientRect(); return [r.left + 50, r.bottom - 120]; })()`);
  const arc = [];
  for (let i = 1; i <= 8; i++) arc.push([empty[0] + i * 14, empty[1] - (i <= 4 ? i * 16 : (8 - i) * 16)]);
  await page.touch("start", [empty]);
  for (const pt of arc) await page.touch("move", [pt]);
  const last = arc[arc.length - 1];
  await page.touch("start", [last, [last[0] + 120, last[1] - 80]]);
  await page.touchIds("end", [[1, last[0] + 120, last[1] - 80]]); // the second finger lifts where it came down; the first stays
  await page.waitFor(`${board}.lassos().length === 2`, 3000);
  await page.touch("end");
  // A right click while the left button is held closes one too.
  const m0 = [empty[0] + 220, empty[1]];
  await page.press(m0[0], m0[1]);
  for (let i = 1; i <= 8; i++) await page.moveTo(m0[0] + i * 12, m0[1] - (i <= 4 ? i * 14 : (8 - i) * 14));
  await page.rightWhileLeft(m0[0] + 96, m0[1]);
  await page.waitFor(`${board}.lassos().length === 3`, 3000);
  await page.release(m0[0] + 96, m0[1]);
});

// The owner: "두번째나 두번 이상인 것들은 내가 터치한 그 부분의 초로 가게 돼… 세로선이… 거기서 재생하면 거기서부터… 분할을 누르면 분할".
scenario("whiteboard song card: the first tap shows its menu (▶ first); a second tap puts a line with its time where tapped; ▶ plays from there and the menu stays; 분할 cuts there", async ({ open, fixtures }) => {
  const page = await open({ width: 600, height: 800 });
  await songThenBoard(page, fixtures);
  await click(page, "#mode-song");
  await click(page, "#my-songs");
  await page.waitFor(`document.querySelector("#song-drawer .song-pick")`, 8000);
  await click(page, "#song-drawer .song-pick");
  await page.waitFor(`document.querySelectorAll(".card.song").length === 1 && !document.getElementById("song-drawer")`);
  await click(page, "#mode-all");
  const board = `window.__app.session.doc("board")`;
  const card = await cardBox(page, 0);
  const notesBox = await page.eval(`(() => { const r = document.querySelector(".card.song .card-notes").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  await page.tap(notesBox.x + notesBox.w * 0.5, notesBox.y + notesBox.h / 2);
  await page.waitFor(`${q("#card-menu")} && ${q("#card-menu button")}.id === "card-play"`);
  assert.ok(!(await page.eval(`document.querySelector(".card.song .card-cursor")`)), "no line after the first tap");
  // A second tap: a line where tapped, with its time.
  await page.tap(notesBox.x + notesBox.w * 0.4, notesBox.y + notesBox.h / 2);
  await page.waitFor(q(".card.song .card-cursor"));
  const at = await page.eval(`(() => { const c = document.querySelector(".card.song .card-cursor").getBoundingClientRect(); return c.left; })()`);
  assert.ok(Math.abs(at - (notesBox.x + notesBox.w * 0.4)) < 3, "the line is where the finger was");
  const dur = await page.eval(`${board}.items()[0].data.dur`);
  const said = await text(page, ".card.song .card-cursor-time");
  assert.ok(/^\d+\.\d초$/.test(said) && Math.abs(parseFloat(said) - (dur * 0.4) / 1000) <= 0.15, "its time: " + said + " of " + dur + " ms");
  assert.ok(await page.eval(`!!${q("#card-menu")}`), "the menu is still there");
  // ▶ plays from the line, and the menu stays while it plays.
  await click(page, "#card-menu #card-play");
  await page.waitFor(`${q("#card-menu #card-play")}?.textContent === "■ 멈춤"`);
  const line = await page.eval(`parseFloat(document.querySelector(".card.song .card-line")?.style.left || "-1")`);
  assert.ok(line >= 39, "played from the line, not from the start: " + line);
  await click(page, "#card-menu #card-play");
  await page.waitFor(`${q("#card-menu #card-play")}?.textContent === "▶ 듣기"`);
  // 분할 cuts at the line.
  await click(page, "#card-menu #card-cut");
  await page.waitFor(`${board}.items().filter((i) => i.kind === "song").length === 2`);
  const parts = await page.eval(`${board}.items().filter((i) => i.kind === "song").map((i) => i.data.dur).sort((a, b) => a - b)`);
  assert.ok(Math.abs(parts[0] - dur * 0.4) < dur * 0.05, "cut at the line: " + JSON.stringify(parts) + " of " + dur);
  // Without a line (the part just made is chosen, no line yet), 분할 asks for a tap, and that tap cuts.
  await page.waitFor(`${q("#card-menu #card-cut")} && !document.querySelector(".card-cursor")`);
  await click(page, "#card-menu #card-cut");
  const chosen = await page.eval(`(() => { const r = document.querySelector(".card.chosen .card-notes").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await page.tap(chosen[0], chosen[1]);
  await page.waitFor(`${board}.items().filter((i) => i.kind === "song").length === 3`);
});

// The owner: "올가미 기능에서 색깔 바꾸기… 막 여러가지… 올가미기능은 많은걸 할 수 있게".
scenario("whiteboard 올가미 more: a card's own 색; ⋯ 색 colours the loop only (the cards keep their own); 순서 정리 lays them in one row inside a new loop; 잇기 joins the songs from the left; 음소거 and 소리 켜기; 반복 marks its ▶; undo", async ({ open, out, fixtures }) => {
  const page = await open({ width: 600, height: 800 });
  await songThenBoard(page, fixtures);
  await click(page, "#mode-song");
  for (let n = 1; n <= 2; n++) {
    await click(page, "#my-songs");
    await page.waitFor(`document.querySelector("#song-drawer .song-pick")`, 8000);
    await click(page, "#song-drawer .song-pick");
    await page.waitFor(`document.querySelectorAll(".card.song").length === ${n} && !document.getElementById("song-drawer")`);
  }
  const board = `window.__app.session.doc("board")`;
  await click(page, "#mode-all");
  await click(page, "#add-note");
  await writeMemo(page, "후렴");
  // A card's own colour.
  await click(page, ".card.song");
  await page.waitFor(q("#card-menu #card-tint"));
  await click(page, "#card-tint");
  await click(page, '#card-menu [data-tint="2"]');
  await page.waitFor(`${board}.items().filter((i) => i.tint === 2).length === 1`);
  // A loop round all three.
  await click(page, "#mode-lasso");
  const box = await page.eval(`(() => { const rs = [...document.querySelectorAll(".card")].map((c) => c.getBoundingClientRect()); const v = document.getElementById("room-body").getBoundingClientRect(); const rail = document.getElementById("board-rail").getBoundingClientRect(); return { l: Math.max(v.left + 24, Math.min(...rs.map((r) => r.left)) - 14), t: Math.max(v.top + 24, Math.min(...rs.map((r) => r.top)) - 14), r: Math.min(rail.left - 6, Math.max(...rs.map((r) => r.right)) + 14), b: Math.min(v.bottom - 24, Math.max(...rs.map((r) => r.bottom)) + 14) }; })()`);
  const pts = [[box.l, box.t], [box.r, box.t], [box.r, box.b], [box.l, box.b], [box.l, box.t + 20]];
  await page.touch("start", [pts[0]]);
  for (let k = 1; k < pts.length; k++) for (let i = 1; i <= 6; i++) await page.touch("move", [[pts[k - 1][0] + ((pts[k][0] - pts[k - 1][0]) * i) / 6, pts[k - 1][1] + ((pts[k][1] - pts[k - 1][1]) * i) / 6]]);
  await page.touch("end");
  await page.waitFor(`${board}.lassos().length === 1`);
  const first = await page.eval(`${board}.lassos()[0].id`);
  // 색: the loop's own colour; the cards keep theirs ("내 고유색을 바꾸는 게 아니라 거기 색깔을").
  await click(page, `[id="lasso-more-${first}"]`);
  await click(page, "#lasso-tint");
  await click(page, '#lasso-menu [data-tint="5"]');
  await page.waitFor(`${board}.lassos()[0].tint === 5 && ${board}.items().length === 3`);
  assert.deepEqual(await page.eval(`${board}.items().map((i) => i.tint ?? null).sort()`), [2, null, null], "the cards keep their own colours");
  assert.ok(await page.eval(`document.querySelector('.board-loops path[data-lasso="${first}"]').getAttribute("style")?.includes("--lc")`), "the loop is drawn in its colour");
  // 정리: one row, tops even, 24 apart, inside a new loop of the same colour.
  await click(page, `[id="lasso-more-${first}"]`);
  await click(page, "#lasso-tidy");
  await page.waitFor(`${board}.lassos().length === 1 && ${board}.lassos()[0].id !== ${JSON.stringify(first)}`);
  await frames(page);
  const row = await page.eval(`[...document.querySelectorAll(".card")].map((c) => c.getBoundingClientRect()).sort((p, q) => p.left - q.left).map((r) => [r.top, r.left, r.right])`);
  assert.ok(row.every((r) => Math.abs(r[0] - row[0][0]) < 1.5), "tops even: " + JSON.stringify(row));
  for (let i = 1; i < row.length; i++) assert.ok(Math.abs(row[i][1] - row[i - 1][2] - 24) < 2.5, "24 apart: " + JSON.stringify(row));
  const loop = await page.eval(`${board}.lassos()[0]`);
  assert.equal(loop.tint, 5, "the new loop keeps the colour");
  await page.waitFor(`document.querySelector('[id="lasso-play-${loop.id}"]')?.textContent.startsWith("▶ 2곡")`);
  // 잇기: the two songs, from the left.
  const more = `[id="lasso-more-${loop.id}"]`;
  await click(page, more);
  await click(page, "#lasso-chain");
  await page.waitFor(`${board}.links().length === 1`);
  await click(page, more);
  await page.waitFor(q("#lasso-tidy"));
  await page.front();
  await page.shot(out("board-lasso-more.png"));
  await click(page, "#mode-lasso"); // the bars still work while the menu is open; this one closes it
  // 음소거, then 소리 켜기.
  await click(page, more);
  await click(page, "#lasso-mute");
  await page.waitFor(`${board}.items().filter((i) => i.kind === "song").every((i) => i.muted)`);
  await click(page, more);
  assert.equal(await text(page, "#lasso-mute"), "소리 켜기");
  await click(page, "#lasso-mute");
  await page.waitFor(`${board}.items().filter((i) => i.kind === "song").every((i) => !i.muted)`);
  // 반복: its ▶ goes round again (it plays now) and says so; a tap on ▶ stops it, the mark stays.
  await click(page, more);
  await click(page, "#lasso-repeat");
  await page.waitFor(`document.querySelector('[id="lasso-play-${loop.id}"]').textContent === "■ 멈춤 ↻"`);
  await click(page, `[id="lasso-play-${loop.id}"]`);
  await page.waitFor(`document.querySelector('[id="lasso-play-${loop.id}"]').textContent === "▶ 2곡 ↻"`);
  await click(page, more);
  assert.equal(await text(page, "#lasso-repeat"), "반복 끄기");
  await click(page, "#lasso-repeat");
  await page.waitFor(`document.querySelector('[id="lasso-play-${loop.id}"]').textContent === "▶ 2곡"`);
  // Undo takes back one step at a time: 소리 켜기 first.
  await click(page, "#board-undo");
  await page.waitFor(`${board}.items().filter((i) => i.kind === "song").every((i) => i.muted)`);
});

// 본질 5.5: "사진도 넣었다 뺄다 할 수 있고 브러쉬도 있고 필기도 가능하고" - 전체 draws with the text room's brushes.
scenario("whiteboard 그리기: the pen (from any mode it brings 전체) draws on the board beneath the cards and a friend sees it; the stroke eraser takes it off and undo brings it back; two fingers zoom and draw nothing; pen off, a drag moves the board again", async ({ open, out }) => {
  const a = await open({ dev: "a" });
  const id = await createBoard(a);
  const b = await open({ dev: "b", hash: "r-" + id });
  await joinNew(b, { name: "나래" });
  await b.waitFor(q("#board"));
  await click(a, "#mode-link");
  await click(a, "#board-pen");
  await a.waitFor(`${q("#mode-all")}.getAttribute("aria-pressed") === "true" && !${q("#board-ink-tools")}.hidden && ${q("#board-pen")}.getAttribute("aria-pressed") === "true"`);
  const v = await a.eval(`(() => { const r = document.getElementById("room-body").getBoundingClientRect(); return { x: r.left + 60, y: r.top + 150 }; })()`);
  await a.press(v.x, v.y);
  for (let i = 1; i <= 8; i++) await a.moveTo(v.x + i * 20, v.y + i * 6);
  await a.release(v.x + 160, v.y + 48);
  const strokes = (p) => p.eval(`window.__app.session.doc("k:board").strokes().length`);
  await a.waitFor(`window.__app.session.doc("k:board").strokes().length === 1`);
  await b.waitFor(`window.__app.session.doc("k:board").strokes().length === 1`);
  await frames(a);
  const inked = (x, y) => a.eval(`(() => { const c = document.querySelector("#board canvas.ink"); const r = c.getBoundingClientRect(); const k = c.width / r.width; const d = c.getContext("2d").getImageData(Math.round((${x} - r.left) * k) - 6, Math.round((${y} - r.top) * k) - 6, 12, 12).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true; return false; })()`);
  assert.ok(await inked(v.x + 80, v.y + 24), "the line is on the board where it was drawn");
  await a.front();
  await a.shot(out("board-drawing.png"));
  assert.equal(await a.eval(`document.querySelector("#board canvas.ink").nextElementSibling?.id`), "board-content", "drawings lie beneath the cards");
  // The stroke eraser takes it off; undo brings it back.
  await click(a, "#eraser");
  await click(a, '[data-erase="eraser-stroke"]');
  await a.press(v.x + 80, v.y - 30);
  for (let i = 1; i <= 6; i++) await a.moveTo(v.x + 80, v.y - 30 + i * 18);
  await a.release(v.x + 80, v.y + 78);
  await a.waitFor(`window.__app.session.doc("k:board").strokes().length === 0`);
  await b.waitFor(`window.__app.session.doc("k:board").strokes().length === 0`);
  await click(a, "#board-undo");
  await a.waitFor(`window.__app.session.doc("k:board").strokes().length === 1`);
  // Two fingers zoom while the pen is on; nothing is drawn.
  await click(a, '[data-brush="pen"]');
  const before = await a.eval(`getComputedStyle(document.getElementById("board-content")).transform`);
  await a.pinch([[v.x, v.y + 260], [v.x + 100, v.y + 260]], [[v.x - 40, v.y + 260], [v.x + 140, v.y + 260]]);
  await frames(a);
  assert.equal(await strokes(a), 1, "a pinch draws nothing");
  assert.notEqual(await a.eval(`getComputedStyle(document.getElementById("board-content")).transform`), before, "the pinch zoomed");
  // Pen off: a drag moves the board, nothing is drawn.
  await click(a, "#board-pen");
  await a.waitFor(`${q("#board-ink-tools")}.hidden`);
  const pan0 = await a.eval(`getComputedStyle(document.getElementById("board-content")).transform`);
  await a.touch("start", [[v.x + 40, v.y + 300]]);
  for (let i = 1; i <= 6; i++) await a.touch("move", [[v.x + 40 - i * 15, v.y + 300]]);
  await a.touch("end");
  await frames(a);
  assert.notEqual(await a.eval(`getComputedStyle(document.getElementById("board-content")).transform`), pan0, "the board moved");
  assert.equal(await strokes(a), 1);
});

// 본질 5.5: "노트처럼 글 쓰는 것도 진짜 잘 되고" - 글쓰기 writes where the finger is, in place.
scenario("whiteboard 글쓰기: a tap writes right there and a friend sees the words come; a tap on words writes on in them; a tap outside only ends it; empty writing leaves nothing; undo takes it back step by step", async ({ open }) => {
  const a = await open({ dev: "a" });
  const id = await createBoard(a);
  const b = await open({ dev: "b", hash: "r-" + id });
  await joinNew(b, { name: "나래" });
  await b.waitFor(q("#board"));
  assert.deepEqual(await a.eval(`[...document.querySelectorAll(".board-modes button")].map((x) => x.textContent)`), ["전체", "이동", "글쓰기", "잇기", "노래", "올가미"]);
  await click(a, "#mode-write");
  const spot = await a.eval(`(() => { const v = document.getElementById("room-body").getBoundingClientRect(); return [v.left + 70, v.top + 140]; })()`);
  const notes = (p) => p.eval(`window.__app.session.doc("board").items().filter((i) => i.kind === "note").map((i) => i.text)`);
  await a.tap(spot[0], spot[1]);
  await a.waitFor(`document.activeElement?.id === "board-typing"`);
  await a.type("여기에 바로");
  await b.waitFor(`window.__app.session.doc("board").items().some((i) => i.kind === "note" && i.text === "여기에 바로")`);
  const at = await a.eval(`(() => { const r = document.getElementById("board-typing").getBoundingClientRect(); return [r.left, r.top]; })()`);
  assert.ok(Math.abs(at[0] - spot[0]) < 30 && Math.abs(at[1] - spot[1]) < 30, "the words are where the finger was: " + at + " / " + spot);
  // A tap outside ends the writing and does nothing else.
  await a.tap(spot[0], spot[1] + 220);
  await a.waitFor(`!${q("#board-typing")}`);
  assert.deepEqual(await notes(a), ["여기에 바로"]);
  // Writing begun and left empty leaves nothing behind.
  await a.tap(spot[0], spot[1] + 220);
  await a.waitFor(`document.activeElement?.id === "board-typing"`);
  await a.tap(spot[0], spot[1] + 320);
  await a.waitFor(`!${q("#board-typing")}`);
  assert.deepEqual(await notes(a), ["여기에 바로"], "no empty text left behind");
  // A tap on the words writes on in them.
  await click(a, ".card.memo");
  await a.waitFor(`document.activeElement?.id === "board-typing" && document.activeElement.value === "여기에 바로"`);
  await a.type(" 더");
  await a.key("Escape");
  await a.waitFor(`!${q("#board-typing")}`);
  assert.deepEqual(await notes(a), ["여기에 바로 더"]);
  await b.waitFor(`window.__app.session.doc("board").items().some((i) => i.text === "여기에 바로 더")`);
  // Undo: the added words go, then the new text, one step each.
  await click(a, "#board-undo");
  await a.waitFor(`window.__app.session.doc("board").items().some((i) => i.text === "여기에 바로")`);
  await click(a, "#board-undo");
  await a.waitFor(`window.__app.session.doc("board").items().filter((i) => i.kind === "note").length === 0`);
});

scenario("whiteboard: song clips arrive by 보내기 and by + 노래; 잇기 sets the playing order with numbered rainbow lines", async ({ open, out, fixtures }) => {
  const page = await open();
  const boardId = await createBoard(page, { room: "순서 보드" });
  assert.match(await text(page, "#board-hint"), /보내기/);
  await click(page, "#back");
  const songId = await createSongRoom(page, { room: "흥얼 방" });
  await importSound(page, fixtures.doremi);
  // 보내기: straight onto the board.
  await choose(page, ".clip[data-id]");
  await click(page, "#clip-send");
  await page.waitFor(q(`#send-boards [data-room="${boardId}"]`));
  await click(page, `#send-boards [data-room="${boardId}"]`);
  await page.waitFor(`document.querySelector(".toast")?.textContent.includes("화이트보드로 보냈어요")`, 6000);
  // 복사, then + 노래 on the board.
  await choose(page, ".clip[data-id]");
  await click(page, "#clip-copy");
  await page.goto(await page.eval(`location.href.split("#")[0] + "#r-${boardId}"`));
  await page.waitFor("window.__app && window.__app.booted");
  await page.waitFor(`document.querySelectorAll(".card.song").length === 1`);
  await click(page, "#add-song");
  await page.waitFor(`document.querySelectorAll(".card.song").length === 2`);
  assert.equal(await page.eval(`document.querySelector(".card.song .note").textContent`), "도");
  // Without lines the leftmost plays first; 잇기 the right one first, then the left.
  const ids = await page.eval(`window.__app.session.doc("board").items().sort((a, b) => a.x - b.x).map((i) => i.id)`);
  await click(page, "#mode-link");
  await click(page, `.card[data-id="${ids[1]}"]`);
  await click(page, `.card[data-id="${ids[0]}"]`);
  await page.waitFor(`window.__app.session.doc("board").links().length === 1`);
  const line = await page.eval(`(() => { const l = window.__app.session.doc("board").links()[0]; return [l.a, l.b, l.n, l.color, document.querySelector(".board-lines .badge text").textContent]; })()`);
  assert.deepEqual(line, [ids[1], ids[0], 1, "#e5484d", "1"], "line 1 is 빨강");
  assert.deepEqual(await page.eval(`[...document.querySelectorAll(".card.song")].map((c) => [c.dataset.id, c.querySelector(".card-order").textContent]).sort((a, b) => a[1] - b[1]).map((x) => x[0])`), [ids[1], ids[0]]);
  await page.shot(out("board.png"));
  // Play in order: the first card lights up first.
  await click(page, "#board-play");
  await page.waitFor(`document.querySelector(".card.playing")?.dataset.id === ${JSON.stringify(ids[1])}`, 3000);
  await click(page, "#board-play");
  // A memo card.
  await click(page, "#mode-all");
  await click(page, "#add-note");
  await writeMemo(page, "후렴은 여기서부터");
  await page.waitFor(`document.querySelector(".card.memo .card-text")?.textContent === "후렴은 여기서부터"`);
  // Undo takes the memo away again, step by step.
  await click(page, "#board-undo");
  await click(page, "#board-undo");
  await page.waitFor(`!document.querySelector(".card.memo")`);
  void songId;
});

/** A song room with 도레미 in it, then a whiteboard; the page ends in the board. */
async function songThenBoard(page, fixtures) {
  await createSongRoom(page, { room: "흥얼 방" });
  await importSound(page, fixtures.doremi);
  await click(page, "#back");
  return createBoard(page, { room: "노래 보드" });
}
const cardBox = (page, n = 0) => page.eval(`(() => { const c = [...document.querySelectorAll(".card.song")].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[${n}]; const r = c.getBoundingClientRect(); return { id: c.dataset.id, x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);

scenario("whiteboard 노래 모드: modes on top, each mode's tools on the right; 내 노래 slides in from the right; song cards are as long as their songs and stretch sideways", async ({ open, out, fixtures }) => {
  const page = await open();
  await songThenBoard(page, fixtures);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll(".board-modes button")].map((b) => b.textContent)`), ["전체", "이동", "글쓰기", "잇기", "노래", "올가미"]);
  const rail = () => page.eval(`[...document.querySelectorAll("#board-rail button, #board-rail label")].map((b) => b.id)`);
  assert.ok((await rail()).includes("add-note"), "전체 has its own tools on the right");
  await click(page, "#mode-song");
  for (const id of ["my-songs", "board-add-sound", "stretch-in", "stretch-out", "board-speed", "board-sound-mode"]) assert.ok((await rail()).includes(id), "노래 has " + id);
  const railBox = await page.eval(`(() => { const r = document.getElementById("board-rail").getBoundingClientRect(); const b = document.getElementById("board").getBoundingClientRect(); return { right: b.right - r.right, left: r.left - b.left }; })()`);
  assert.ok(railBox.right < 24 && railBox.left > 200, "the tools stand at the right edge: " + JSON.stringify(railBox));
  // 내 노래: a panel from the right with the song room's clip; a tap places it.
  await click(page, "#my-songs");
  await page.waitFor(`document.querySelector("#song-drawer .song-pick")`, 8000);
  const drawer = await page.eval(`(() => { const r = document.getElementById("song-drawer").getBoundingClientRect(); return { right: Math.round(innerWidth - r.right), w: r.width, room: document.querySelector("#song-drawer .drawer-room")?.textContent }; })()`);
  assert.ok(drawer.right <= 1 && drawer.w < 360, "it comes in from the right: " + JSON.stringify(drawer));
  assert.equal(drawer.room, "흥얼 방");
  await settled(page);
  await page.shot(out("board-my-songs.png"));
  await click(page, "#song-drawer .song-pick");
  await page.waitFor(`document.querySelectorAll(".card.song").length === 1 && !document.getElementById("song-drawer")`);
  const item = await page.eval(`window.__app.session.doc("board").items()[0]`);
  assert.equal(item.w, Math.min(960, Math.max(120, Math.round(item.data.dur / 1000 * 60))), "as long as the song");
  // Sideways: buttons and two fingers stretch the card in time; its height and the board's size stay.
  const a = await cardBox(page);
  await click(page, "#stretch-in");
  const b = await cardBox(page);
  assert.ok(Math.abs(b.w / a.w - 1.4) < 0.05 && Math.abs(b.h - a.h) < 1, `stretched ${a.w} → ${b.w}, height ${a.h} → ${b.h}`);
  await page.pinch([[b.cx - 30, b.cy], [b.cx + 30, b.cy]], [[b.cx - 60, b.cy], [b.cx + 60, b.cy]]);
  await frames(page);
  const c = await cardBox(page);
  assert.ok(c.w / b.w > 1.7 && Math.abs(c.h - b.h) < 1, `a sideways pinch stretches: ${b.w} → ${c.w}, height ${b.h} → ${c.h}`);
  assert.ok(await page.eval(`[...document.querySelectorAll(".card.song .note")].some((n) => n.textContent === "도")`), "the notes are named when there is room");
  await page.shot(out("board-song-mode.png"));
});

scenario("whiteboard 노래 모드: cut a card where it is tapped, mute it, edit its notes, copy it; a sound goes straight onto the board", async ({ open, fixtures }) => {
  const page = await open();
  await songThenBoard(page, fixtures);
  await click(page, "#mode-song");
  await click(page, "#my-songs");
  await page.waitFor(`document.querySelector("#song-drawer .song-pick")`, 8000);
  await click(page, "#song-drawer .song-pick");
  await page.waitFor(`document.querySelectorAll(".card.song").length === 1 && !document.getElementById("song-drawer")`);
  const board = `window.__app.session.doc("board")`;
  // Choosing a song card brings its own tools to the right.
  await click(page, ".card.song");
  await page.waitFor(`${q("#card-cut")} && ${q("#card-notes")} && ${q("#card-mute")} && ${q("#card-copy")}`);
  await click(page, "#card-mute");
  await page.waitFor(`${board}.items()[0].muted === true && document.querySelector(".card.song").classList.contains("muted")`);
  await click(page, "#card-mute");
  await page.waitFor(`${board}.items()[0].muted === false`);
  // 분할 cuts at the position line: the chosen card tapped a little left of the middle puts the line there.
  const dur = await page.eval(`${board}.items()[0].data.dur`);
  const box = await cardBox(page);
  await page.tap(box.x + box.w * 0.4, box.cy);
  await page.waitFor(q(".card.song .card-cursor"));
  await click(page, "#card-cut");
  await page.waitFor(`${board}.items().length === 2`);
  const durs = await page.eval(`${board}.items().map((i) => i.data.dur).sort((a, b) => a - b)`);
  assert.equal(durs[0] + durs[1], dur, "the two parts make the whole");
  assert.ok(Math.abs(durs[0] - dur * 0.4) < dur * 0.06, `cut where tapped: ${durs} of ${dur}`);
  await click(page, "#board-undo");
  await page.waitFor(`${board}.items().length === 1`);
  // 음 편집 on the board card: move 도 up two steps.
  await click(page, ".card.song");
  await click(page, "#card-notes");
  await page.waitFor(`document.querySelectorAll("#roll-grid .rnote").length === 5`);
  await settled(page);
  const at = await page.eval(`(() => { const n = document.querySelector('#roll-grid .rnote[data-p="60"]'); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 3, y: r.top + r.height / 2, h: r.height + 2 }; })()`);
  await page.press(at.x, at.y);
  for (let i = 1; i <= 6; i++) await page.moveTo(at.x, at.y - (at.h * 2 * i) / 6);
  await page.release(at.x, at.y - at.h * 2);
  await page.waitFor(`${board}.items()[0].data.notes[0][2] === 62`);
  await page.key("Escape");
  await page.waitFor(`document.querySelector(".card.song .note").textContent === "레"`);
  // 복사: the card is on the device clipboard, as a song clip.
  await click(page, ".card.song");
  await click(page, "#card-copy");
  assert.equal(await page.eval(`window.__app.store.get("clipboard", null)?.kind`), "song-clip");
  // 소리 넣기: a file straight onto the board.
  await click(page, "#board-add-sound");
  await page.waitFor(q("#board-add-file"));
  await page.setFiles("#board-file", [fixtures.doremi]);
  await page.waitFor(`${board}.items().length === 2`, 20000);
  const fresh = await page.eval(`${board}.items()[1]`);
  assert.equal(fresh.kind, "song");
  assert.deepEqual(fresh.data.notes.map((n) => n[2]), [60, 62, 64, 65, 67], "its notes were found");
});

scenario("playing made simple: tap a card and its menu is by it; ▶ 듣기 plays just that one, which glows with a moving line; in the song room the same for a clip", async ({ open, fixtures }) => {
  const page = await open();
  await songThenBoard(page, fixtures);
  await click(page, "#mode-song");
  await click(page, "#my-songs");
  await page.waitFor(`document.querySelector("#song-drawer .song-pick")`, 8000);
  await click(page, "#song-drawer .song-pick");
  await page.waitFor(`document.querySelectorAll(".card.song").length === 1 && !document.getElementById("song-drawer")`);
  await click(page, ".card.song");
  await page.waitFor(q("#card-menu #card-play"));
  const near = await page.eval(`(() => { const m = document.getElementById("card-menu").getBoundingClientRect(); const c = document.querySelector(".card.song").getBoundingClientRect(); return { gap: Math.min(Math.abs(m.bottom - c.top), Math.abs(m.top - c.bottom)), overlapX: Math.min(m.right, c.right) - Math.max(m.left, c.left) }; })()`);
  assert.ok(near.gap < 20 && near.overlapX > 0, "the menu stands by the card: " + JSON.stringify(near));
  assert.ok(!(await page.eval(q("#board-rail #card-cut"))), "the side keeps only the mode's tools");
  await click(page, "#card-play");
  await page.waitFor(`document.querySelector(".card.song.playing .card-line")`, 4000);
  const l1 = await page.eval(`parseFloat(document.querySelector(".card-line").style.left)`);
  await page.waitFor(`parseFloat(document.querySelector(".card-line")?.style.left) > ${l1 + 5}`, 4000);
  assert.equal(await text(page, "#card-play"), "■ 멈춤");
  await click(page, "#card-play");
  await page.waitFor(`!document.querySelector(".card.playing") && !document.querySelector(".card-line")`);
  // The song room: ▶ 듣기 in the clip's menu, and what sounds glows.
  await click(page, "#back");
  await page.waitFor(q('[data-side="creative"] .room-row'));
  await click(page, '.room-row[data-room-kind="creative-song"]');
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 1`, 8000);
  await choose(page, ".clip[data-id]");
  await click(page, "#clip-play");
  await page.waitFor(`document.querySelector(".clip[data-id].playing") && ${q("#clip-play")}.textContent === "■ 멈춤"`, 4000);
  await click(page, "#clip-play");
  await page.waitFor(`!document.querySelector(".clip.playing")`);
  await click(page, "#to-start");
  await click(page, "#play");
  await page.waitFor(`document.querySelector(".clip[data-id].playing")`, 4000);
  await click(page, "#play");
  await page.waitFor(`!document.querySelector(".clip.playing")`);
});

scenario("whiteboard 올가미: a loop drawn round one card with a finger closes itself; its ▶ plays only that card; dragged over the other it plays that one; ✕ takes it off; undo; a second finger draws nothing", async ({ open, out, fixtures }) => {
  const page = await open();
  await songThenBoard(page, fixtures);
  await click(page, "#mode-song");
  for (let n = 1; n <= 2; n++) {
    await click(page, "#my-songs");
    await page.waitFor(`document.querySelector("#song-drawer .song-pick")`, 8000);
    await click(page, "#song-drawer .song-pick");
    await page.waitFor(`document.querySelectorAll(".card.song").length === ${n} && !document.getElementById("song-drawer")`);
  }
  const board = `window.__app.session.doc("board")`;
  // 올가미 is its own mode, next to 노래.
  await click(page, "#mode-lasso");
  await page.waitFor(`${q("#mode-lasso")}.getAttribute("aria-pressed") === "true" && ${q("#board-hint")}.textContent.includes("둘러")`);
  assert.ok(!(await page.eval(q("#lasso-tool"))), "not a tool inside 노래 any more");
  const first = await cardBox(page, 0);
  const second = await cardBox(page, 1);
  // One finger round the first card, the end stopping short of the start.
  const ring = (c, pad, upto) => {
    const pts = [];
    for (let i = 0; i <= 24 * upto; i++) {
      const a = -Math.PI / 2 + (i / 24) * Math.PI * 2;
      pts.push([c.cx + Math.cos(a) * (c.w / 2 + pad), c.cy + Math.sin(a) * (c.h / 2 + pad)]);
    }
    return pts;
  };
  const stroke = ring(first, 14, 0.86);
  const placed = await page.eval(`${board}.items().map((i) => [i.x, i.y])`);
  await page.touch("start", [stroke[0]]);
  for (const pt of stroke.slice(1)) await page.touch("move", [pt]);
  await page.touch("end");
  await page.waitFor(`${board}.lassos().length === 1`);
  const loopId = await page.eval(`${board}.lassos()[0].id`);
  const play = `[id="lasso-play-${loopId}"]`;
  await page.waitFor(`${q(play)}?.textContent === "▶ 1곡"`);
  assert.deepEqual(await page.eval(`${board}.items().map((i) => [i.x, i.y])`), placed, "drawing over a card did not move it");
  assert.ok(!(await page.eval(q("#card-menu"))), "nor choose it");
  await settled(page);
  await page.shot(out("board-lasso.png"));
  // ▶ on the loop: the first card sounds, the second never does.
  await page.eval(`(() => { window.__played = []; new MutationObserver(() => { for (const c of document.querySelectorAll(".card.song.playing")) if (!window.__played.includes(c.dataset.id)) window.__played.push(c.dataset.id); }).observe(document.getElementById("board-content"), { subtree: true, attributes: true, attributeFilter: ["class"] }); return true; })()`);
  await click(page, play);
  await page.waitFor(`${q(play)}.textContent === "■ 멈춤" && document.querySelector(".card.song.playing")`, 4000);
  await page.waitFor(`${q(play)}.textContent === "▶ 1곡"`, 15000);
  assert.deepEqual(await page.eval(`window.__played`), [first.id], "only the card inside played");
  // Dragged by its chip over the second card, the loop holds that one instead.
  const chip = await page.eval(`(() => { const r = ${q(play)}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const dx = second.cx - first.cx;
  const dy = second.cy - first.cy;
  await page.touch("start", [[chip.x, chip.y]]);
  for (let i = 1; i <= 8; i++) await page.touch("move", [[chip.x + (dx * i) / 8, chip.y + (dy * i) / 8]]);
  await page.touch("end");
  await page.waitFor(`${board}.lassos()[0].x !== 0 || ${board}.lassos()[0].y !== 0`);
  const holds = (c) => page.eval(`(() => { const r = document.querySelector('.board-loops path[data-lasso]').getBoundingClientRect(); return r.left < ${c.cx} && r.right > ${c.cx} && r.top < ${c.cy} && r.bottom > ${c.cy}; })()`);
  assert.ok(await holds(second) && !(await holds(first)), "the loop moved over the second card");
  await page.waitFor(`${q(play)}.textContent === "▶ 1곡"`);
  await page.eval(`(window.__played = [], true)`);
  await click(page, play);
  await page.waitFor(`document.querySelector(".card.song.playing")`, 4000);
  await click(page, play);
  assert.deepEqual(await page.eval(`window.__played`), [second.id], "now the second card plays");
  // Undo puts the loop back; ✕ takes it off; undo brings it again.
  await click(page, "#board-undo");
  await page.waitFor(`${board}.lassos()[0].x === 0 && ${board}.lassos()[0].y === 0`);
  await click(page, `[id="lasso-remove-${loopId}"]`);
  await page.waitFor(`${board}.lassos().length === 0 && !document.querySelector(".lasso-chip")`);
  await click(page, "#board-undo");
  await page.waitFor(`${board}.lassos().length === 1 && document.querySelector(".lasso-chip")`);
  // A second finger while drawing means zoom: no loop is made.
  const other = ring(second, 14, 0.5);
  await page.touch("start", [other[0]]);
  for (const pt of other.slice(1, 6)) await page.touch("move", [pt]);
  await page.touch("start", [other[5], [other[5][0] + 80, other[5][1] + 40]]);
  await page.touch("move", [other[5], [other[5][0] + 120, other[5][1] + 60]]);
  await page.touch("end");
  await frames(page);
  assert.equal(await page.eval(`${board}.lassos().length`), 1, "a pinch draws no loop");
  // A tap with the tool on still chooses a card; with the tool off a drag moves the board, not a loop.
  // (The pinch moved the board: tap the part of the card still in view.)
  const now = await cardBox(page, 0);
  const seen = await page.eval(`(() => { const b = document.getElementById("board").getBoundingClientRect(); const r = document.getElementById("board-rail").getBoundingClientRect(); return { l: b.left + 8, r: r.left - 8, t: b.top + 8, b: b.bottom - 8 }; })()`);
  const tapAt = [(Math.max(now.x, seen.l) + Math.min(now.x + now.w, seen.r)) / 2, Math.min(Math.max(now.cy, seen.t + 20), seen.b - 20)];
  assert.ok(tapAt[0] > seen.l && tapAt[0] < seen.r, "part of the card is in view: " + JSON.stringify({ now, seen }));
  await page.touch("start", [tapAt]);
  await page.touch("end");
  await page.waitFor(q("#card-menu #card-play"));
  // A drag inside the loop moves the loop and the card in it together (one undo step).
  const inside = await page.eval(`(() => { const c = document.querySelector('.card[data-id="${first.id}"]').getBoundingClientRect(); return [c.left + c.width / 2, c.top + c.height * 0.7]; })()`);
  const before = await page.eval(`[${board}.item(${JSON.stringify(first.id)}).y, ${board}.lassos()[0].y]`);
  await page.touch("start", [inside]);
  for (let i = 1; i <= 6; i++) await page.touch("move", [[inside[0], inside[1] + i * 10]]);
  await page.touch("end");
  await page.waitFor(`${board}.item(${JSON.stringify(first.id)}).y !== ${before[0]}`);
  const after = await page.eval(`[${board}.item(${JSON.stringify(first.id)}).y, ${board}.lassos()[0].y]`);
  assert.ok(Math.abs((after[0] - before[0]) - (after[1] - before[1])) < 1 && after[0] - before[0] > 30, "card and loop moved together: " + JSON.stringify({ before, after }));
  await click(page, "#board-undo");
  await page.waitFor(`${board}.item(${JSON.stringify(first.id)}).y === ${before[0]} && ${board}.lassos()[0].y === ${before[1]}`);
  // Out of 올가미, a drag moves the board, not a loop.
  await click(page, "#mode-song");
  await page.waitFor(`${q("#mode-lasso")}.getAttribute("aria-pressed") === "false"`);
  const pan0 = await page.eval(`getComputedStyle(document.getElementById("board-content")).transform`);
  const empty = await page.eval(`(() => { const b = document.getElementById("board"); const r = document.getElementById("room-body").getBoundingClientRect(); for (let y = r.bottom - 30; y > r.top + 30; y -= 20) for (let x = r.left + 150; x < r.right - 90; x += 20) { const e = document.elementFromPoint(x, y); if (e === b || e?.id === "board-content") return [x, y]; } return null; })()`);
  assert.ok(empty, "an empty spot on the board");
  await page.touch("start", [empty]);
  for (let i = 1; i <= 6; i++) await page.touch("move", [[empty[0] - i * 20, empty[1]]]);
  await page.touch("end");
  await frames(page);
  assert.notEqual(await page.eval(`getComputedStyle(document.getElementById("board-content")).transform`), pan0, "the board moved");
  assert.equal(await page.eval(`${board}.lassos().length`), 1, "and no loop was drawn");
});

scenario("toolbars say what each button does: captions under every icon in the text room, the song room and the whiteboard; the bars fit 360 and 320 wide; the board's ▶ is 전체 재생", async ({ open, fixtures }) => {
  for (const width of [360, 320]) {
    const page = await open({ width, height: 760 });
    const caps = (sel) => page.eval(`[...document.querySelectorAll(${JSON.stringify(sel + " .icon-btn")})].map((b) => getComputedStyle(b, "::after").content.replace(/"/g, ""))`);
    const fits = (sel) => page.eval(`(() => { const r = ${q(sel)}.getBoundingClientRect(); const buttons = [...document.querySelectorAll(${JSON.stringify(sel + " .icon-btn")})].map((b) => b.getBoundingClientRect()); return r.left >= 0 && r.right <= innerWidth && buttons.every((b, i, all) => i === 0 || b.left >= all[i - 1].right - 0.5); })()`);
    await createRoom(page, { room: "글 방" });
    assert.deepEqual(await caps(".toolbar"), ["되돌리기", "다시하기", "사람 색", "그리기", "사진"]);
    assert.ok(await fits(".toolbar"), "the text room's bar fits " + width);
    await click(page, "#back");
    await createSongRoom(page);
    assert.deepEqual(await caps("#song-tools"), ["처음", "재생", "녹음", "넣기", "되돌리기", "다시하기", "빠르기", "음색"]);
    assert.ok(await fits("#song-tools"), "the song room's eight buttons fit " + width);
    await click(page, "#back");
    await createBoard(page);
    assert.deepEqual(await caps("#board-tools"), ["전체 재생", "그리기", "되돌리기", "다시하기", "지우기"]);
    assert.ok(await fits("#board-tools"));
    assert.match(await page.eval(`${q("#board-play")}.getAttribute("aria-label")`), /전체 재생/);
  }
  void fixtures;
});

scenario("whiteboard: each song card has its own ▶ - one tap plays just that card (it glows), again stops; the board's 전체 재생 plays all from the left", async ({ open, fixtures }) => {
  const page = await open();
  await songThenBoard(page, fixtures);
  await click(page, "#mode-song");
  for (let n = 1; n <= 2; n++) {
    await click(page, "#my-songs");
    await page.waitFor(`document.querySelector("#song-drawer .song-pick")`, 8000);
    await click(page, "#song-drawer .song-pick");
    await page.waitFor(`document.querySelectorAll(".card.song").length === ${n} && !document.getElementById("song-drawer")`);
  }
  const second = await cardBox(page, 1);
  await page.eval(`(() => { window.__played = []; new MutationObserver(() => { for (const c of document.querySelectorAll(".card.song.playing")) if (!window.__played.includes(c.dataset.id)) window.__played.push(c.dataset.id); }).observe(document.getElementById("board-content"), { subtree: true, attributes: true, attributeFilter: ["class"] }); return true; })()`);
  const playOf = `.card[data-id="${second.id}"] .card-play`;
  // (A card just placed is chosen, with its menu; a tap on the empty board puts that away first.)
  const empty = await page.eval(`(() => { const b = document.getElementById("board"); const r = document.getElementById("room-body").getBoundingClientRect(); for (let y = r.bottom - 30; y > r.top + 30; y -= 20) for (let x = r.left + 20; x < r.right - 90; x += 20) { const e = document.elementFromPoint(x, y); if (e === b || e?.id === "board-content") return [x, y]; } return null; })()`);
  await page.tap(empty[0], empty[1]);
  await page.waitFor(`!${q("#card-menu")}`);
  await click(page, playOf);
  await page.waitFor(`document.querySelector('.card[data-id="${second.id}"]').classList.contains("playing") && ${q(playOf)}.dataset.icon === "stop"`, 4000);
  assert.ok(!(await page.eval(q("#card-menu"))), "no menu needed to hear a card");
  await click(page, playOf);
  await page.waitFor(`!document.querySelector(".card.playing") && ${q(playOf)}.dataset.icon === "play"`);
  assert.deepEqual(await page.eval(`window.__played`), [second.id], "only that card sounded");
  // 전체 재생: the first card from the left sounds first.
  await page.eval(`(window.__played = [], true)`);
  await click(page, "#board-play");
  await page.waitFor(`window.__played.length >= 1`, 4000);
  const first = await cardBox(page, 0);
  const leftmost = await page.eval(`window.__app.session.doc("board").items().filter((i) => i.kind === "song").sort((a, b) => a.x - b.x || a.y - b.y)[0].id`);
  assert.equal(await page.eval(`window.__played[0]`), leftmost);
  await click(page, "#board-play");
  void first;
});

scenario("menus: with a card's menu open, a tap on another card only puts the menu away (nothing there is chosen or played); the next tap chooses it; the room's bars still work", async ({ open }) => {
  const page = await open({ width: 600, height: 800 });
  await createBoard(page);
  for (const memo of ["하나", "둘"]) {
    await click(page, "#add-note");
    await writeMemo(page, memo);
    await page.waitFor(`[...document.querySelectorAll(".card.memo .card-text")].some((t) => t.textContent === ${JSON.stringify(memo)})`);
  }
  const ids = await page.eval(`window.__app.session.doc("board").items().map((i) => i.id)`);
  // Written in place, nothing stays chosen; a tap chooses the second, with its menu.
  assert.ok(!(await page.eval(`document.querySelector(".card.chosen")`)), "writing leaves nothing chosen");
  await click(page, `.card[data-id="${ids[1]}"]`);
  await page.waitFor(`${q("#card-menu")} && document.querySelector('.card[data-id="${ids[1]}"]').classList.contains("chosen")`);
  // A tap on the other card: the menu goes, and the other card is not chosen.
  await click(page, `.card[data-id="${ids[0]}"]`);
  await page.waitFor(`!${q("#card-menu")}`);
  assert.ok(!(await page.eval(`document.querySelector(".card.chosen")`)), "nothing chosen by the tap that closed the menu");
  // The next tap chooses it.
  await click(page, `.card[data-id="${ids[0]}"]`);
  await page.waitFor(`${q("#card-menu")} && document.querySelector('.card[data-id="${ids[0]}"]').classList.contains("chosen")`);
  // The room's own bars still work while a menu is open.
  await click(page, "#mode-move");
  await page.waitFor(`${q("#mode-move")}.getAttribute("aria-pressed") === "true"`);
});

scenario("whiteboard: text is plain text with a colour and a size; the 올가미's ⋯ copies, sends to 레퍼런스 and removes the cards inside; another board pastes them as they stood", async ({ open, fixtures }) => {
  const page = await open({ width: 600, height: 800 });
  await songThenBoard(page, fixtures);
  const board = `window.__app.session.doc("board")`;
  await click(page, "#add-note");
  await writeMemo(page, "가사 첫 줄");
  // Written in place, then chosen with a tap: its menu has the colours and sizes.
  await click(page, ".card.memo");
  await page.waitFor(`${q("#card-menu")} && ${q("#card-menu #card-color")}`);
  await click(page, "#card-color");
  await page.waitFor(q('#card-menu [data-text-color="blue"]'));
  await click(page, '#card-menu [data-text-color="blue"]');
  await page.waitFor(`${board}.items().find((i) => i.kind === "note").color === "blue"`);
  await click(page, "#card-size");
  await page.waitFor(`${board}.items().find((i) => i.kind === "note").size === 3`);
  const look = await page.eval(`(() => { const c = document.querySelector(".card.memo"); const t = c.querySelector(".card-text"); return { bg: getComputedStyle(c).backgroundColor, border: getComputedStyle(c).borderTopColor, size: parseFloat(getComputedStyle(t).fontSize), color: getComputedStyle(t).color }; })()`);
  assert.equal(look.bg, "rgba(0, 0, 0, 0)", "no box");
  assert.ok(look.size > 20, "large: " + look.size);
  // A song card next to it, then a loop round both.
  await click(page, "#mode-song");
  await click(page, "#my-songs");
  await page.waitFor(`document.querySelector("#song-drawer .song-pick")`, 8000);
  await click(page, "#song-drawer .song-pick");
  await page.waitFor(`document.querySelectorAll(".card.song").length === 1 && !document.getElementById("song-drawer")`);
  await click(page, "#mode-lasso");
  // Round both cards, inside the board (not on its rounded corners) and clear of the tools on the right.
  const box = await page.eval(`(() => { const rs = [...document.querySelectorAll(".card")].map((c) => c.getBoundingClientRect()); const b = document.getElementById("board").getBoundingClientRect(); const rail = document.getElementById("board-rail").getBoundingClientRect(); return { l: Math.max(b.left + 24, Math.min(...rs.map((r) => r.left)) - 12), t: Math.max(b.top + 24, Math.min(...rs.map((r) => r.top)) - 12), r: Math.min(rail.left - 6, Math.max(...rs.map((r) => r.right)) + 12), b: Math.min(b.bottom - 24, Math.max(...rs.map((r) => r.bottom)) + 12) }; })()`);
  const pts = [[box.l, box.t], [box.r, box.t], [box.r, box.b], [box.l, box.b], [box.l, box.t + 20]];
  await page.touch("start", [pts[0]]);
  for (let k = 1; k < pts.length; k++) for (let i = 1; i <= 6; i++) await page.touch("move", [[pts[k - 1][0] + ((pts[k][0] - pts[k - 1][0]) * i) / 6, pts[k - 1][1] + ((pts[k][1] - pts[k - 1][1]) * i) / 6]]);
  await page.touch("end");
  await page.waitFor(`${board}.lassos().length === 1`);
  const loopId = await page.eval(`${board}.lassos()[0].id`);
  const more = `[id="lasso-more-${loopId}"]`;
  await click(page, more);
  await click(page, "#lasso-copy");
  assert.equal(await page.eval(`window.__app.store.get("clipboard", null)?.items?.length`), 2);
  await click(page, more);
  await click(page, "#lasso-ref");
  assert.ok(await page.eval(`window.__app.store.get("reference-notes", []).some((n) => n.text === "가사 첫 줄") || JSON.stringify(window.__app.store.get("reference", [])).includes("가사 첫 줄")`), "the text is a 레퍼런스 note");
  assert.equal(await page.eval(`window.__app.store.get("reference-sounds", []).length`), 1, "the song is a 레퍼런스 recording");
  await click(page, more);
  await click(page, "#lasso-delete");
  await page.waitFor(`${board}.items().length === 0`);
  await click(page, "#board-undo");
  await page.waitFor(`${board}.items().length === 2`);
  // Another board pastes the two as they stood, the text still blue and large.
  await click(page, "#back");
  await createBoard(page, { room: "두 번째 보드" });
  await click(page, "#add-song");
  await page.waitFor(`${board}.items().length === 2`);
  const pasted = await page.eval(`${board}.items().find((i) => i.kind === "note")`);
  assert.deepEqual([pasted.text, pasted.color, pasted.size], ["가사 첫 줄", "blue", 3]);
});

// The owner: "한 개에 여러 개를 잇는 거는… 뒤늦게 한 거가 2번으로" and "겹치는 게 있을 때 녹음이 뭐가 먼저 되고".
scenario("whiteboard 잇기 branches: tap A then B, tap A again and C: two lines out of A, the later one numbered 2; it plays A, B, C; a card already following another is not taken twice", async ({ open, fixtures }) => {
  const page = await open({ width: 600, height: 800 });
  await songThenBoard(page, fixtures);
  await click(page, "#mode-song");
  for (let n = 1; n <= 3; n++) {
    await click(page, "#my-songs");
    await page.waitFor(`document.querySelector("#song-drawer .song-pick")`, 8000);
    await click(page, "#song-drawer .song-pick");
    await page.waitFor(`document.querySelectorAll(".card.song").length === ${n} && !document.getElementById("song-drawer")`);
  }
  const board = `window.__app.session.doc("board")`;
  await click(page, "#mode-link");
  const ids = await page.eval(`${board}.items().map((i) => i.id)`);
  const tapCard = async (id) => { const r = await page.eval(`(() => { const c = document.querySelector('.card[data-id="${id}"] .card-notes').getBoundingClientRect(); return [c.left + c.width / 2, c.top + c.height / 2]; })()`); await page.tap(r[0], r[1]); await frames(page); };
  await tapCard(ids[0]);
  await tapCard(ids[1]);
  await page.waitFor(`${board}.links().length === 1`);
  await tapCard(ids[0]); // a step back: A becomes where the next line starts
  await tapCard(ids[2]);
  await page.waitFor(`${board}.links().length === 2`);
  assert.deepEqual(await page.eval(`${board}.links().map((l) => [l.a, l.b, l.n])`), [[ids[0], ids[1], 1], [ids[0], ids[2], 2]], "two lines out of A; the later one is 2");
  assert.deepEqual(await page.eval(`window.__app.session.doc("board").view().order.map((i) => i.id)`), [ids[0], ids[1], ids[2]]);
  // C already follows A: a line from B into C is not made.
  await tapCard(ids[1]);
  await tapCard(ids[2]);
  await frames(page);
  assert.equal(await page.eval(`${board}.links().length`), 2);
});

scenario("whiteboard 잇기: the order is saved in slot 1, the lines cleared, and slot 1 brings them back", async ({ open }) => {
  const page = await open({ width: 600, height: 800 });
  await createBoard(page);
  for (const memo of ["하나", "둘", "셋"]) {
    await click(page, "#add-note");
    await writeMemo(page, memo);
    await page.waitFor(`[...document.querySelectorAll(".card.memo .card-text")].some((t) => t.textContent === ${JSON.stringify(memo)})`);
  }
  const board = `window.__app.session.doc("board")`;
  const ids = await page.eval(`${board}.items().sort((a, b) => a.x - b.x).map((i) => i.id)`);
  await click(page, "#mode-link");
  for (const id of ids) await click(page, `.card[data-id="${id}"]`);
  await page.waitFor(`${board}.links().length === 2`);
  await click(page, "#order-slots");
  await page.waitFor(q("#slot-save-1"));
  await click(page, "#slot-save-1");
  await page.waitFor(`${board}.slots().length === 1`);
  await click(page, "#unlink-all");
  await page.waitFor(`${board}.links().length === 0`);
  await click(page, "#order-slots");
  await page.waitFor(q("#slot-use-1"));
  await click(page, "#slot-use-1");
  await page.waitFor(`${board}.links().length === 2`);
  assert.deepEqual(await page.eval(`${board}.links().map((l) => [l.a, l.b])`), [[ids[0], ids[1]], [ids[1], ids[2]]]);
  await click(page, "#board-undo");
  await page.waitFor(`${board}.links().length === 0`);
});

scenario("whiteboard 잇기 by a line: a finger drawn from card to card chains them in that order (one undo step); lines are 무지개, 파스텔 or 내 색; a photo card goes on, moves and comes off", async ({ open, out, fixtures }) => {
  const page = await open({ width: 600, height: 800 });
  await createBoard(page);
  for (const memo of ["하나", "둘", "셋"]) {
    await click(page, "#add-note");
    await writeMemo(page, memo);
    await page.waitFor(`[...document.querySelectorAll(".card.memo .card-text")].some((t) => t.textContent === ${JSON.stringify(memo)})`);
  }
  const board = `window.__app.session.doc("board")`;
  // A memo's words read on its yellow (the small note bars inside clips are another thing).
  // (Text on the board is plain text now: its words read on the board itself.)
  const memoInk = await page.eval(`(() => { const t = document.querySelector(".card.memo .card-text"); return t && [getComputedStyle(t).color, getComputedStyle(document.getElementById("board")).backgroundColor, getComputedStyle(t).fontWeight]; })()`);
  assert.ok(memoInk, "memo cards are .card.memo");
  assert.ok(contrast(hex(memoInk[0]), hex(memoInk[1])) >= 4.5, "memo text contrast: " + JSON.stringify(memoInk));
  const centre = (id) => page.eval(`(() => { const r = document.querySelector('.card[data-id="${id}"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const ids = await page.eval(`${board}.items().sort((a, b) => a.x - b.x || a.y - b.y).map((i) => i.id)`);
  // Drawn third → first → second: the order is the order the line passes them.
  const order = [ids[2], ids[0], ids[1]];
  await click(page, "#mode-link");
  const pts = [];
  for (const id of order) pts.push(await centre(id));
  const path = [pts[0]];
  for (let k = 1; k < pts.length; k++) for (let i = 1; i <= 8; i++) path.push([pts[k - 1][0] + ((pts[k][0] - pts[k - 1][0]) * i) / 8, pts[k - 1][1] + ((pts[k][1] - pts[k - 1][1]) * i) / 8]);
  // The cards the line passes, in the order it first reaches them (it may cross one on the way).
  const passed = await page.eval(`(() => { const seen = []; for (const [x, y] of ${JSON.stringify(path)}) { const id = document.elementFromPoint(x, y)?.closest(".card")?.dataset.id; if (id && !seen.includes(id)) seen.push(id); } return seen; })()`);
  assert.equal(passed.length, 3);
  assert.equal(passed[0], order[0]);
  await page.touch("start", [path[0]]);
  for (const pt of path.slice(1)) await page.touch("move", [pt]);
  await page.touch("end");
  await page.waitFor(`${board}.links().length === 2`);
  assert.deepEqual(await page.eval(`${board}.links().map((l) => [l.a, l.b])`), [[passed[0], passed[1]], [passed[1], passed[2]]]);
  assert.ok(!(await page.eval(`document.querySelector(".card[data-chain]") || document.querySelector(".chain-line")`)), "the drawing marks are gone");
  assert.equal(await page.eval(`${board}.items().filter((i) => i.x !== undefined).length`), 3);
  // Line colours: 무지개, then 파스텔, then the person's own colour; the numbers stay readable.
  const firstStroke = () => page.eval(`document.querySelector(".board-lines path").getAttribute("stroke")`);
  assert.equal(await firstStroke(), "#e5484d");
  await click(page, "#line-colors");
  await page.waitFor(`document.querySelector(".board-lines path").getAttribute("stroke") === "#f4a3a6"`);
  assert.equal(await page.eval(`document.querySelector(".board-lines .badge text").style.fill`), "rgb(29, 36, 51)", "dark numbers on pastel");
  await click(page, "#line-colors");
  await page.waitFor(`document.querySelector(".board-lines path").getAttribute("stroke") !== "#f4a3a6"`);
  const strokes = await page.eval(`[...document.querySelectorAll(".board-lines path")].map((p) => p.getAttribute("stroke"))`);
  assert.equal(new Set(strokes).size, 1, "one colour of my own");
  assert.equal(await text(page, "#line-colors .rail-cap"), "내 색");
  await page.shot(out("board-line-colors.png"));
  // One undo takes the whole line away.
  await click(page, "#board-undo");
  await page.waitFor(`${board}.links().length === 0`);
  // A photo card.
  await click(page, "#mode-all");
  await page.interceptChooser(true);
  await click(page, "#add-photo");
  await page.setFiles("#board-photo-file", [fixtures.photo]);
  await page.waitFor(`document.querySelector(".card.photo img")?.complete && document.querySelector(".card.photo img").naturalWidth > 0`, 8000);
  const photo = await page.eval(`${board}.items().find((i) => i.kind === "photo")`);
  assert.ok(photo.data.src.startsWith("data:image/jpeg;base64,") && photo.data.src.length <= 60000, "a small JPEG: " + photo.data.src.length);
  assert.equal(photo.data.w / photo.data.h, 800 / 600);
  await frames(page); // (the menu moves the frame after the picture is in)
  const [px, py] = await centre(photo.id);
  assert.ok(await page.eval(`!!document.elementFromPoint(${px}, ${py})?.closest(".card.photo")`), "the menu stands clear of the picture");
  await page.press(px, py);
  for (let i = 1; i <= 6; i++) await page.moveTo(px + i * 10, py + i * 6);
  await page.release(px + 60, py + 36);
  await page.waitFor(`${board}.item(${JSON.stringify(photo.id)}).x !== ${photo.x}`);
  await click(page, `.card[data-id="${photo.id}"]`);
  await page.waitFor(`${q("#card-menu #card-delete")} && !${q("#card-menu #card-edit")}`);
  await click(page, "#card-menu #card-delete");
  await page.waitFor(`!document.querySelector(".card.photo")`);
});

scenario("whiteboard: two fingers zoom the board; they never move a card or start an order line", async ({ open }) => {
  const page = await open({ width: 600, height: 800 });
  await createBoard(page);
  for (const memo of ["첫 메모", "둘째 메모"]) {
    await click(page, "#add-note");
    await writeMemo(page, memo);
    await page.waitFor(`[...document.querySelectorAll(".card.memo .card-text")].some((t) => t.textContent === ${JSON.stringify(memo)})`);
  }
  const items = () => page.eval(`JSON.stringify(window.__app.session.doc("board").items().map((i) => [i.id, i.x, i.y]).sort())`);
  const card = (n) => page.eval(`(() => { const c = [...document.querySelectorAll(".card.memo")].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[${n}]; const r = c.getBoundingClientRect(); return { id: c.dataset.id, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
  const links = () => page.eval(`window.__app.session.doc("board").links().length`);
  const i0 = await items();
  // 잇기 mode, a finger on each card, spreading: that is a pinch, not two taps.
  await click(page, "#mode-link");
  const a = await card(0);
  const b = await card(1);
  await page.pinch([[a.x, a.y], [b.x, b.y]], [[a.x - 20, a.y], [b.x + 20, b.y]]);
  await frames(page);
  assert.equal(await links(), 0, "no order line from a pinch");
  assert.equal(await page.eval(`document.querySelectorAll(".card.link-from").length`), 0, "no card left waiting to be joined");
  // Finger taps still join, first card then second (on each card's left side: the tools stand over the board's right edge).
  for (const n of [0, 1]) {
    const c = await card(n);
    await page.touch("start", [[c.x - c.w * 0.3, c.y]]);
    await page.touch("end");
  }
  await page.waitFor(`window.__app.session.doc("board").links().length === 1`);
  // Both fingers on one card in 전체: the board zooms in and the card stays where it is.
  await click(page, "#mode-all");
  const c = await card(0);
  assert.ok(c.w > 60, "room for two fingers on the card: " + JSON.stringify(c));
  await page.pinch([[c.x - 20, c.y], [c.x + 20, c.y]], [[c.x - 60, c.y], [c.x + 60, c.y]]);
  await frames(page);
  assert.equal(await items(), i0, "no card moved");
  assert.ok((await card(0)).w > c.w * 1.8, "the board zoomed in");
});

// ---- 레퍼런스 -----------------------------------------------------------------------------------------

scenario("레퍼런스 녹음: a file and an in-app take are kept on this device, heard, and put into a song room as a clip and onto a whiteboard as a card", async ({ open, fixtures }) => {
  const page = await open();
  await page.waitFor(q("#home"));
  await click(page, "#home-reference");
  await page.waitFor(q("#ref-tab-sounds"));
  await click(page, "#ref-tab-sounds");
  await page.waitFor(q("#ref-ways"));
  // The first look at an empty list puts the example take in (a sung 도레미파솔미도).
  await page.waitFor(`document.querySelectorAll(".ref-sound").length === 1`, 20000);
  await page.setFiles("#ref-file", [fixtures.doremi]);
  await page.waitFor(`document.querySelectorAll(".ref-sound").length === 2`, 20000);
  assert.equal(await text(page, ".ref-sound .pick-name"), "doremi.wav");
  assert.equal(await page.eval(`document.querySelectorAll(".ref-sound")[0].querySelectorAll(".note").length`), 5, "its notes were found");
  // Recorded in the app (the test browser has a microphone).
  await click(page, "#ref-record");
  await page.waitFor(q("#ref-stop"));
  await pause(2500);
  await click(page, "#ref-stop");
  await page.waitFor(`document.querySelectorAll(".ref-sound").length === 3`, 20000);
  const id = await page.eval(`[...document.querySelectorAll(".ref-sound")].find((r) => r.querySelector(".pick-name").textContent === "doremi.wav").dataset.id`);
  await click(page, `#ref-play-${id}`);
  await page.waitFor(`${q(`#ref-play-${id}`)}.textContent === "■ 멈춤"`);
  await click(page, `#ref-play-${id}`);
  await page.waitFor(`${q(`#ref-play-${id}`)}.textContent === "▶ 듣기"`);
  await page.key("Escape");
  // Into a song room: a clip with its notes.
  await createSongRoom(page);
  await click(page, "#room-reference");
  await page.waitFor(q("#ref-tab-sounds"));
  await click(page, "#ref-tab-sounds");
  await page.waitFor(q(`[data-put-sound="${id}"]`));
  await click(page, `[data-put-sound="${id}"]`);
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 1`);
  assert.deepEqual(await noteNames(page), ["도", "레", "미", "파", "솔"]);
  // Onto a whiteboard: a song card.
  await click(page, "#back");
  await createBoard(page);
  await click(page, "#room-reference");
  await page.waitFor(q("#ref-tab-sounds"));
  await click(page, "#ref-tab-sounds");
  await page.waitFor(q(`[data-put-sound="${id}"]`));
  await click(page, `[data-put-sound="${id}"]`);
  await page.waitFor(`document.querySelectorAll(".card.song").length === 1`);
});

// The owner: "처음에 홈화면 UI에 녹음 기능… 녹음하고서 어떤 방에 보낼 수 있게… 쌓아 두거나 모아 둘 수… 레퍼런스에서도 보기가 가능"
// and "너가 예시로 한번 아티팩트에 녹음 있는 걸 넣어 볼래".
scenario("home 녹음: the button opens the kept recordings with an example take to try (heard, seven notes); 보내기 puts a take into a song room as a clip and onto a whiteboard as a card; the book button opens and closes 레퍼런스", async ({ open }) => {
  const page = await open();
  await createSongRoom(page, { room: "보낼 노래 방" });
  await click(page, "#back");
  await createBoard(page, { room: "보낼 보드" });
  await click(page, "#back");
  await page.waitFor(q("#home-record"));
  await click(page, "#home-record");
  await page.waitFor(`document.getElementById("reference") && !document.getElementById("ref-sounds-part").hidden`);
  await page.waitFor(`[...document.querySelectorAll(".ref-sound .pick-name")].some((n) => n.textContent.startsWith("예시 녹음"))`, 20000);
  assert.equal(await page.eval(`document.querySelector(".ref-sound").querySelectorAll(".note").length`), 7, "the example sings seven notes");
  const id = await page.eval(`document.querySelector(".ref-sound").dataset.id`);
  await click(page, `#ref-play-${id}`);
  await page.waitFor(`${q(`#ref-play-${id}`)}.textContent === "■ 멈춤"`);
  await click(page, `#ref-play-${id}`);
  await page.waitFor(`${q(`#ref-play-${id}`)}.textContent === "▶ 듣기"`);
  const sendTo = async (name) => {
    await click(page, `[data-send-sound="${id}"]`);
    await page.waitFor(q("#send-rooms"));
    const room = await page.eval(`[...document.querySelectorAll("#send-rooms [data-send-to]")].find((b) => b.textContent.includes(${JSON.stringify(name)})).dataset.sendTo`);
    await click(page, `[data-send-to="${room}"]`);
    await page.waitFor(`document.querySelector(".toast")?.textContent.includes("보냈어요")`, 8000);
    return room;
  };
  const songRoom = await sendTo("보낼 노래 방");
  const boardRoom = await sendTo("보낼 보드");
  // The book button closes 레퍼런스, and opens it again.
  await click(page, "#home-reference");
  await page.waitFor(`!document.getElementById("reference")`);
  await click(page, "#home-reference");
  await page.waitFor(`!!document.getElementById("reference")`);
  await click(page, "#home-reference");
  await page.waitFor(`!document.getElementById("reference")`);
  // The rooms hold what was sent.
  await click(page, `.room-row[data-id="${songRoom}"]`);
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 1`, 8000);
  assert.deepEqual(await noteNames(page), ["도", "레", "미", "파", "솔", "미", "도"]);
  await click(page, "#back");
  await click(page, `.room-row[data-id="${boardRoom}"]`);
  await page.waitFor(`document.querySelectorAll(".card.song").length === 1`, 8000);
});

scenario("레퍼런스 floats over the room (no dark around it), moves by its head and opens there again; 내 방 shows my other rooms, and 가져오기 brings their words and clips into this room", async ({ open, fixtures }) => {
  const page = await open();
  await createRoom(page, { room: "글 방" });
  await focusEnd(page);
  await page.type("오늘의 가사 한 줄");
  await page.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text() === "오늘의 가사 한 줄"`);
  await click(page, "#back");
  await createSongRoom(page, { room: "흥얼 방" });
  await importSound(page, fixtures.doremi);
  await click(page, "#back");
  await createBoard(page, { room: "모으는 보드" });
  await click(page, "#room-reference");
  await page.waitFor(q("#reference"));
  await settled(page);
  assert.ok(!(await page.eval(q(".scrim"))), "no dark around it");
  const at = await page.eval(`(() => { const r = document.getElementById("reference").getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  assert.ok(at.x < 40 && at.y < 120, "top left at first: " + JSON.stringify(at));
  // Moved by its head; it opens there next time.
  const head = await page.eval(`(() => { const r = document.querySelector("#reference .float-head").getBoundingClientRect(); return [r.left + 30, r.top + r.height / 2]; })()`);
  await page.press(head[0], head[1]);
  for (let i = 1; i <= 6; i++) await page.moveTo(head[0] + i * 4, head[1] + i * 25);
  await page.release(head[0] + 24, head[1] + 150);
  const moved = await page.eval(`(() => { const r = document.getElementById("reference").getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  assert.ok(moved.y > at.y + 100, "it moved: " + JSON.stringify(moved));
  await click(page, "#reference-close");
  await page.waitFor(`!${q("#reference")}`);
  await click(page, "#room-reference");
  await page.waitFor(q("#reference"));
  await settled(page);
  assert.equal(Math.round(await page.eval(`document.getElementById("reference").getBoundingClientRect().top`)), Math.round(moved.y), "it opens where it was left");
  // 내 방: the text room's words and the song room's clip come into the board.
  await click(page, "#ref-tab-rooms");
  const textRoom = await page.eval(`window.__app.store.get("rooms", []).find((r) => r.name === "글 방").id`);
  const songRoom = await page.eval(`window.__app.store.get("rooms", []).find((r) => r.name === "흥얼 방").id`);
  await click(page, `[id="ref-open-${textRoom}"]`);
  await page.waitFor(`[...document.querySelectorAll('[data-room="${textRoom}"] .ref-item p')].some((p) => p.textContent === "오늘의 가사 한 줄")`, 8000);
  await click(page, `[data-room="${textRoom}"] [data-take="0"]`);
  await page.waitFor(`window.__app.session.doc("board").items().some((i) => i.kind === "note" && i.text === "오늘의 가사 한 줄")`);
  await click(page, `[id="ref-open-${songRoom}"]`);
  await page.waitFor(q(`[data-room="${songRoom}"] [data-take="0"]`), 8000);
  await click(page, `[data-room="${songRoom}"] [data-take="0"]`);
  await page.waitFor(`window.__app.session.doc("board").items().some((i) => i.kind === "song" && i.data.notes.length === 5)`);
});

scenario("레퍼런스: private notes from home and from a room; put into the room only when asked; the switch hides it", async ({ open }) => {
  const [a, b] = await together(open);
  await click(a, "#room-reference");
  await a.waitFor(q("#ref-text"));
  await fill(a, "#ref-text", "후렴: 같이 걷던 길");
  await click(a, "#ref-add");
  await a.waitFor(`document.querySelector("#ref-list .ref-body")?.textContent === "후렴: 같이 걷던 길"`);
  // Private: nothing reached the room yet, so the other device has nothing.
  const day = await a.eval(`${TODAY}.dataset.day`);
  assert.equal(await b.eval(`window.__app.session.sheet("${day}").text()`), "");
  await click(a, "#ref-list [data-put]");
  await b.waitFor(`window.__app.session.sheet("${day}").text().includes("후렴: 같이 걷던 길")`);
  // Turned off in settings: gone from the room bar.
  await click(a, "#room-settings");
  await a.waitFor(q("#set-reference"));
  await a.eval(`(() => { const t = document.getElementById("set-reference"); t.click(); return true; })()`);
  assert.equal(await a.eval(`window.__app.store.get("settings", {}).reference`), false);
  await a.key("Escape");
  await click(a, "#back");
  await a.waitFor(q("#home"));
  assert.equal(await a.eval(`!!document.getElementById("home-reference")`), false);
});
