// The scenarios. Each gets `open({dev, hash, width, height, dark})` → page.
// `dev` is a pretend device: its own storage for "who am I", shared room data.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
    // What is there now (a menu may have been drawn again while it came to rest).
    const now = ${q(sel)} || el;
    now.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = now.getBoundingClientRect();
    if (!r.width || !r.height) throw new Error("${name} has no size on screen");
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === now || now.contains(hit))) {
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

// The owner: "아이콘 그거를 … 무슨 모드인지 … 동그라미 하나 원형으로 해가지고 거기에 아이콘만 있게 … 안에 있는 거
// 좀 보여주는 거를 안에 위 왼쪽에다가".
scenario("home: each room says what kind it is as a round logo with only its icon, on the corner of what it holds at the card's top left; nothing flashes blue; corners take the glass colour, the middle colours stay in dark", async ({ open, out }) => {
  const page = await open();
  await createSongRoom(page, { room: "노래 방" });
  await click(page, "#back");
  await createBoard(page, { room: "보드 방" });
  await click(page, "#back");
  await createRoom(page, { room: "글 방" });
  await click(page, "#back");
  await page.waitFor(`document.querySelectorAll(".room-row").length === 3`);
  const rows = await page.eval(`[...document.querySelectorAll(".room-row")].map((r) => { const logo = r.querySelector(".room-logo"); return [r.querySelector(".room-name").textContent, logo?.getAttribute("aria-label") ?? "", !!logo?.querySelector("svg"), (logo?.textContent || "").trim(), getComputedStyle(logo).borderRadius]; }).sort()`);
  assert.deepEqual(rows.map((r) => r.slice(0, 4)), [["글 방", "텍스트", true, ""], ["노래 방", "노래 만들기", true, ""], ["보드 방", "화이트보드", true, ""]], "an icon only, its kind said to readers");
  assert.ok(rows.every((r) => r[4] === "50%"), "round: " + JSON.stringify(rows));
  // The name at the very top; the box of what it holds under it, the round logo inside it at its top left.
  const place = await page.eval(`[...document.querySelectorAll(".room-row")].map((r) => { const a = r.getBoundingClientRect(), t = r.querySelector(".room-thumb").getBoundingClientRect(), n = r.querySelector(".room-name").getBoundingClientRect(), l = r.querySelector(".room-logo").getBoundingClientRect(); return { nameTop: n.top - a.top, nameAbove: n.bottom <= t.top + 1, logoInside: l.left >= t.left && l.top >= t.top && l.right <= t.right && l.bottom <= t.bottom, logoCorner: [l.left - t.left, l.top - t.top] }; })`);
  assert.ok(place.every((p) => p.nameTop < 20 && p.nameAbove && p.logoInside && p.logoCorner[0] < 12 && p.logoCorner[1] < 12), "name on top, the logo in the box's top left corner: " + JSON.stringify(place));
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

scenario("home 미리보기: a room's row shows what it holds as it was left - a text room its last line, a song room its notes as bars, a whiteboard a tiny map of its cards", async ({ open, out, fixtures }) => {
  const page = await open();
  await createRoom(page, { room: "글 방" });
  await focusEnd(page);
  await page.type("첫 줄");
  await page.key("Enter");
  await page.type("오늘 마지막 줄");
  await page.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text() === "첫 줄\\n오늘 마지막 줄"`);
  await click(page, "#back");
  await page.waitFor(q('.room-row[data-room-kind="daily-text"] .room-preview-text'));
  assert.equal(await text(page, '.room-row[data-room-kind="daily-text"] .room-preview-text'), "오늘 마지막 줄");
  await createSongRoom(page, { room: "노래 방" });
  await importSound(page, fixtures.doremi);
  await click(page, "#back");
  await page.waitFor(q('.room-row[data-room-kind="creative-song"] .room-preview-song .pv-note'));
  const bars = await page.eval(`[...document.querySelectorAll('.room-row[data-room-kind="creative-song"] .pv-note')].map((n) => n.getBoundingClientRect().top)`);
  assert.ok(bars.length >= 5, "the notes as bars: " + bars.length);
  assert.ok(new Set(bars.map(Math.round)).size >= 3, "at their heights: " + bars);
  await createBoard(page, { room: "보드" });
  await click(page, "#add-note");
  await writeMemo(page, "메모 하나");
  await click(page, "#back");
  await page.waitFor(q('.room-row[data-room-kind="creative-board"] .room-preview-board .pv-n'));
  await page.shot(out("home-previews.png"));
  // Taken off the list from inside the room, it does not come back when the room closes.
  await click(page, '.room-row[data-room-kind="daily-text"]');
  await page.waitFor(q("#room-title"));
  await click(page, "#room-settings");
  await click(page, "#leave");
  await page.waitFor(`location.hash === "" || location.hash === "#"`);
  await page.waitFor(q(".room-row"));
  assert.ok(!(await page.eval(`window.__app.store.get("rooms", []).some((r) => r.kind === "daily-text")`)), "the text room stays off my list");
});

// The owner: "방을 만들 때 그 날짜 같은 거는 꾹 눌러가지고 … 처음 시작한 날짜, 그리고 현재 지금 수정한 날짜
// 가장 최근에, 그리고 방에 누가 언제 들어갔는지".
scenario("home: a long press shows the room's 역사 first - when it began and who made it, its latest change, who came in when, what each made by day", async ({ open }) => {
  const page = await open();
  await createRoom(page, { room: "역사 방" });
  await focusEnd(page);
  await page.type("오늘 쓴 한 줄");
  await page.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text() === "오늘 쓴 한 줄"`);
  // What was made is written down soon after the first change.
  await page.waitFor(`window.__app.session.room.history().days.length === 1`, 8000);
  await click(page, "#back");
  await page.waitFor(q('.room-row[data-room-kind="daily-text"]'));
  const at = await page.eval(`(() => { const r = ${q('.room-row[data-room-kind="daily-text"]')}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await page.touch("start", [at]);
  await pause(700);
  await page.touch("end");
  await page.waitFor(q("#room-history .hist-line"), 8000);
  const story = await page.eval(`[...document.querySelectorAll("#room-history .hist-line")].map((l) => l.textContent)`);
  assert.ok(story[0].startsWith("시작") && story[0].includes("오늘") && story[0].includes("만듦"), "when it began, by whom: " + story[0]);
  assert.ok(story[1].startsWith("최근 수정") && story[1].includes("오늘"), "the latest change: " + story[1]);
  const people = await page.eval(`[...document.querySelectorAll("#hist-people li")].map((l) => l.textContent)`);
  assert.equal(people.length, 1);
  assert.ok(people[0].includes("오늘"), "who came in when: " + people[0]);
  const days = await page.eval(`[...document.querySelectorAll("#hist-days li")].map((l) => l.textContent)`);
  assert.ok(days.length === 1 && days[0].includes("글"), "what was made by day: " + JSON.stringify(days));
  assert.ok(await page.eval(q("#room-actions #room-open")), "the actions are still there below");
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
  assert.deepEqual(kinds, [["creative-song", false, ""], ["creative-writing", true, "준비 중"], ["creative-board", false, ""], ["creative-draw", false, ""], ["creative-anim", false, ""]]);
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
  // 띠리링 and a swirl when the colours mix (the owner); counted where the sound is made.
  await a.eval(`(() => { const real = AudioContext.prototype.createOscillator; window.__bells = 0; AudioContext.prototype.createOscillator = function () { window.__bells++; return real.call(this); }; return true; })()`);
  await a.front();
  await a.dblTap(x, y);
  await expect("seep", 1);
  await a.waitFor(`window.__bells >= 4`, 3000);
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

// The owner: "꽉 채워졌으면", "텍스트를 담고 있는 그것까지 옆으로 늘어나야".
scenario("wide screen: lying down or on a computer the app and the writing take the whole width", async ({ open, out }) => {
  const page = await open({ width: 1280, height: 800 });
  await createRoom(page);
  await focusEnd(page);
  await page.type("넓은 화면에서도 가운데 종이 한 장");
  const r = await page.eval(`(() => { const b = document.querySelector("#app").getBoundingClientRect(); const s = document.querySelector(".sheets").getBoundingClientRect(); return { orient: document.documentElement.dataset.orient, width: b.width, height: b.height, sheetLeft: s.left, sheetWidth: s.width, scroll: document.documentElement.scrollWidth, font: parseFloat(getComputedStyle(${TODAY}.querySelector(".draw")).fontSize), rem: parseFloat(getComputedStyle(document.documentElement).fontSize) }; })()`);
  assert.equal(r.orient, "landscape");
  assert.ok(r.width === 1280 && r.height === 800 && r.scroll <= 1280, JSON.stringify(r));
  assert.ok(Math.abs(r.rem - 19.2) < 0.01 && Math.abs(r.font - 19.2) < 0.1, "scaled by the height: " + JSON.stringify(r));
  assert.ok(r.sheetWidth >= 1280 - 4 * r.rem, "the writing takes the width: " + JSON.stringify(r));
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

// 이 날 전체 잠그기 (the first description's 잠금, 5.8): the day's name opens its menu; a locked day takes
// nothing from anyone, says who locked it, and only its locker (or the room's maker) frees it.
scenario("이 날 전체 잠그기: the day's name locks the whole day; the friend can neither write nor remove anything on it and sees who locked it; freed, writing goes on", async ({ open, out }) => {
  const [a, b] = await together(open);
  await focusEnd(a);
  await a.type("오늘은 잠글 날");
  await sameOnAll([a, b], "오늘은 잠글 날");
  const day = await a.eval(`${TODAY}.dataset.day`);
  const sheet = (page) => `window.__app.session.sheet(${JSON.stringify(day)})`;
  await a.front();
  await click(a, ".sheet.today h2.day");
  await a.waitFor(q("#day-lock"));
  await click(a, "#day-lock");
  await a.waitFor(`${sheet(a)}.dayLock() !== null`);
  await b.waitFor(`${sheet(b)}.dayLock() !== null && !${TODAY}.querySelector(".day-lock").hidden`);
  assert.match(await b.eval(`${TODAY}.querySelector(".day-lock").textContent`), /가람 님이 잠근 날/);
  await b.shot(out("day-locked.png"));
  // The friend: neither a letter at the end nor removing one.
  await b.front();
  await focusEnd(b);
  await b.type("더");
  await b.waitFor(`document.querySelector(".toast")?.textContent.includes("잠긴 날")`);
  await b.key("Backspace");
  await pause(200);
  assert.equal(await b.eval(`${sheet(b)}.text()`), "오늘은 잠글 날");
  assert.equal(await b.eval(`${TODAY}.querySelector("textarea").value`), "오늘은 잠글 날");
  // Not theirs to free: the menu only says who locked it.
  await click(b, ".sheet.today h2.day");
  await b.waitFor(q("#day-menu"));
  assert.ok(!(await b.eval(`!!document.getElementById("day-unlock")`)), "only the locker or the room's maker frees it");
  await b.key("Escape");
  // Its locker frees it; writing goes on.
  await a.front();
  await click(a, ".sheet.today h2.day");
  await a.waitFor(q("#day-unlock"));
  await click(a, "#day-unlock");
  await b.waitFor(`${sheet(b)}.dayLock() === null && ${TODAY}.querySelector(".day-lock").hidden`);
  await b.front();
  await focusEnd(b);
  await b.type("!");
  await sameOnAll([a, b], "오늘은 잠글 날!");
});

// 사람 색 직접 고르기 (roadmap 7): beside the palette's eight, a colour of my own; the friend sees my words
// in it, its lightness set so they read (4.5:1) on their paper; back to a palette colour with one tap.
scenario("내 색 직접 고르기: a colour of my own in the room's settings; my words take it on the friend's screen, readable on the paper; a palette colour again with one tap", async ({ open }) => {
  const [a, b] = await together(open);
  await focusEnd(a);
  await a.type("내 색으로");
  await sameOnAll([a, b], "내 색으로");
  await a.front();
  await click(a, "#room-settings");
  await a.waitFor(q("#my-own-color"));
  // The browser's own colour picker cannot be driven; its answer is given as the picker gives it.
  await a.eval(`(() => { const w = document.getElementById("my-own-color"); w.value = "#ff7a00"; w.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await a.waitFor(`window.__app.session.room.member(window.__app.session.memberId).hex === "#ff7a00"`);
  const me = await a.eval(`window.__app.session.memberId`);
  await b.waitFor(`window.__app.session.room.member(${JSON.stringify(me)})?.hex === "#ff7a00"`);
  const seen = await b.eval(`(() => {
    const w = [...${TODAY}.querySelectorAll(".draw .w")].find((el) => el.textContent.includes("내"));
    return { color: getComputedStyle(w).color, want: null };
  })()`);
  const want = await b.eval(`(async () => { const { personColor } = await import("./src/core/paint.js"); const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light"; return personColor({ hex: "#ff7a00" }, theme); })()`).catch(() => null);
  const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
  if (want) assert.equal(seen.color, rgb(want), "my words in my own colour on the friend's screen");
  else assert.notEqual(seen.color, "rgb(0, 0, 0)");
  // Back to a palette colour.
  await click(a, '#my-colors [data-color="3"]');
  await a.waitFor(`window.__app.session.room.member(window.__app.session.memberId).hex === null`);
  await b.waitFor(`window.__app.session.room.member(${JSON.stringify(me)})?.hex === null`);
});

// Writing that runs past the screen: the line being written stays in view as it goes down.
scenario("text room: writing that runs past the bottom of the screen keeps the line being written in view", async ({ open }) => {
  const page = await open({ width: 390, height: 600 });
  await createRoom(page, { room: "긴 일기" });
  await focusEnd(page);
  for (let i = 1; i <= 30; i++) {
    await page.type("오늘 " + i + "번째 줄");
    await page.key("Enter");
  }
  await page.type("마지막 줄");
  await page.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text().includes("마지막 줄")`);
  await pause(300);
  const at = await page.eval(`(() => {
    const list = document.getElementById("sheets");
    const box = list.getBoundingClientRect();
    const caret = ${TODAY}.querySelector(".caret.mine")?.getBoundingClientRect();
    return { caret: caret && { top: caret.top, bottom: caret.bottom }, top: Math.max(0, box.top), bottom: Math.min(innerHeight, box.bottom), scrolled: list.scrollTop };
  })()`);
  assert.ok(at.caret, "my caret is drawn");
  assert.ok(at.caret.top >= at.top - 1 && at.caret.bottom <= at.bottom + 1, "the line being written is in view: " + JSON.stringify(at));
});

// The owner: "텍스트 방에서 글자를 고르고 무언가 할 때 툭툭 끊기지 않게". Moving the chosen words (a
// handle dragged) on a day of 10,000 characters: each move costs little, and the row of tools for
// chosen words is brought up to date, not made again.
scenario("speed: choosing words on a sheet of 10,000 characters stays quick, and the row for chosen words is not made again as the words move", async ({ open }) => {
  const [a] = await together(open, []);
  await writeAt(a, "가나다라 마바사 아자차카 타파하 ".repeat(588) + "\n".repeat(8), Date.now());
  await a.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text().length >= 10000 && ${TODAY}.querySelector("textarea").value.length >= 10000`);
  await focusEnd(a);
  const r = await a.eval(`(async () => {
    const ta = ${TODAY}.querySelector("textarea");
    ta.focus();
    ta.setSelectionRange(5000, 5004);
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const row = document.querySelector("#sel-tools .sel-row");
    const times = [];
    for (let i = 0; i < 30; i++) {
      ta.setSelectionRange(5000, 5005 + i);
      const t0 = performance.now();
      document.dispatchEvent(new Event("selectionchange"));
      await new Promise((r) => setTimeout(r, 0));
      times.push(performance.now() - t0);
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    times.sort((x, y) => x - y);
    return { median: times[15], same: !!row && row === document.querySelector("#sel-tools .sel-row"), shown: !document.getElementById("sel-tools").hidden };
  })()`);
  console.log("     median selection change " + r.median.toFixed(1) + " ms");
  assert.ok(r.shown, "the row for chosen words is out");
  assert.ok(r.same, "the row was brought up to date, not made again");
  assert.ok(r.median < 8, "median selection change took " + r.median.toFixed(1) + " ms");
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
  await a.waitFor(`document.querySelector(".scrim") === null`);
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
/** A tap on an empty spot of the rows (below the clips): nothing is chosen afterwards. */
async function tapEmptyRow(page) {
  const at = await page.eval(`(() => {
    const tl = document.getElementById("timeline").getBoundingClientRect();
    const lanes = document.querySelector(".lanes").getBoundingClientRect();
    // Below the clips and below an open clip menu.
    const rows = [...document.querySelectorAll(".clip[data-id], #clip-menu")].map((c) => c.getBoundingClientRect().bottom);
    const y = Math.min(tl.bottom - 12, Math.max(lanes.top, ...rows) + 30);
    return { x: tl.left + tl.width * 0.75, y };
  })()`);
  // With a clip's menu open, the first tap only puts the menu away.
  for (let i = 0; i < 2 && (await page.eval(`!!document.querySelector(".clip.selected")`)); i++) {
    await page.tap(at.x, at.y);
    await pause(120);
  }
}

async function tapTime(page, ms) {
  const at = await page.eval(`(() => {
    const tl = document.getElementById("timeline");
    const r = document.getElementById("ruler").getBoundingClientRect();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return { x: r.left + Number(tl.dataset.pad) + ${ms} / 1000 * Number(tl.dataset.pps), y: r.top + r.height / 2 };
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

// Rows below the screen (the owner on an iPad: rows piled up past the screen): a file or a take
// that lands on a row below what is shown comes into view, and so does the row being sung into.
scenario("song: a clip that lands on a row below the screen comes into view, and so does the row being sung into", async ({ open, fixtures }) => {
  const page = await open({ width: 390, height: 600 });
  await createSongRoom(page);
  const inView = (sel) => page.eval(`(() => { const t = document.getElementById("timeline").getBoundingClientRect(); const ruler = document.getElementById("ruler").getBoundingClientRect(); const c = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return !!c && c.top >= ruler.bottom - 1 && c.bottom <= t.bottom + 1 && c.right > t.left && c.left < t.right; })()`);
  for (let n = 1; n <= 6; n++) {
    await page.setFiles("#song-file", [fixtures.doremi]);
    await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === ${n} && ${q("#song-status")}.hidden`, 20000);
    const last = await page.eval(`window.__app.session.doc("song").layout().sort((a, b) => b.lane - a.lane)[0].id`);
    await page.waitFor(`(() => { const t = document.getElementById("timeline"); return t.scrollTop + t.clientHeight >= document.querySelector('.clip[data-id="${last}"]').offsetTop; })()`, 3000).catch(() => {});
    await pause(450);
    assert.ok(await inView(`.clip[data-id="${last}"]`), "the clip on row " + n + " is in view");
  }
  const scrolled = await page.eval(`document.getElementById("timeline").scrollTop`);
  assert.ok(scrolled > 0, "the rows went past the screen and it moved down: " + scrolled);
  // Back to the top, then a take: the row it is sung into (below) comes into view.
  await page.eval(`(document.getElementById("timeline").scrollTop = 0, true)`);
  await click(page, "#record");
  await page.waitFor(q("#rec-clip"), 8000);
  await pause(600);
  assert.ok(await inView("#rec-clip"), "the row being sung into is in view");
  await click(page, "#record");
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 7`, 15000);
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
  assert.ok(!(await a.eval(q("#clip-tint-none"))), "no 기본 while it is the recorder's colour");
  // Whose it is: the maker's name by their colour; a dot that is someone's here carries their first letter.
  assert.match(await text(a, "#clip-owner"), /의 녹음$/);
  // No letters on the dots (the owner took them for a bug); whose colour a dot is stays in its label.
  assert.equal(await a.eval(`[...document.querySelectorAll("#clip-menu .menu-dot")].filter((d) => d.textContent).length`), 0, "the dots are plain colours");
  assert.ok((await a.eval(`[...document.querySelectorAll("#clip-menu .menu-dot")].filter((d) => /의 색$/.test(d.getAttribute("aria-label") || "")).length`)) >= 2, "the two people's colours are named in the labels");
  assert.ok(!(await a.eval(`document.getElementById("clip-menu").textContent.includes("false")`)), "no stray words");
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
    return { x: r.left + Number(tl.dataset.pad) + ${first.start + 800} / 1000 * Number(tl.dataset.pps), y: c.top + c.height / 2 };
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
  // A quick finger drag on a clip that is not chosen: the timeline scrolls, the clip stays.
  await tapEmptyRow(page);
  await page.waitFor(`!document.querySelector(".clip.selected")`);
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
  // A quick drag on a clip that is not chosen: the timeline scrolls, the clip stays.
  await tapEmptyRow(page);
  await page.waitFor(`!document.querySelector(".clip.selected")`);
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

// The owner: "한 번 터치하고 다시 터치한 다음에… 옮기면 딱 그 위치로 가야", "가로에서는 겹칠 수 없지만",
// "아래로… 스크롤이 걔를 이동시키는".
scenario("song: a chosen clip follows the finger at once (no holding); over its neighbour it lies against it; at the bottom edge the rows run on below", async ({ open, fixtures }) => {
  const page = await open({ width: 390, height: 640 });
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  const song = `window.__app.session.doc("song")`;
  // The next take goes where the playhead stands: just after the first.
  await page.eval(`document.getElementById("timeline").scrollLeft = 0`);
  const firstEnd = await page.eval(`(() => { const c = ${song}.layout()[0]; return c.start + c.length; })()`);
  // A tap on the first row just right of the take: nothing chosen, that row picked.
  const right = await page.eval(`(() => { const r = document.querySelector(".clip[data-id]").getBoundingClientRect(); return { x: r.right + 30, y: r.top + r.height / 2 }; })()`);
  for (let i = 0; i < 2 && (await page.eval(`!!document.querySelector(".clip.selected")`)); i++) {
    await page.tap(right.x, right.y);
    await pause(120);
  }
  await page.waitFor(`!document.querySelector(".clip.selected")`);
  await tapTime(page, firstEnd + 5);
  await importSound(page, fixtures.doremi, 2);
  const [a, b] = await page.eval(`${song}.layout().map((c) => ({ id: c.id, start: c.start, lane: c.lane, end: c.start + c.length }))`);
  assert.ok(Math.abs(b.start - a.end) <= 40 && b.lane === 0, "the second take came right after the first, on the same row: " + JSON.stringify([a, b]));
  const box = (id) => page.eval(`(() => { const r = document.querySelector('.clip[data-id="${id}"]').getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 }; })()`);
  const pps = await page.eval(`Number(document.getElementById("timeline").dataset.pps)`);
  const drag = async (id, dx, dy, { hold = 0 } = {}) => {
    const at = await box(id);
    await page.touch("start", [[at.x, at.y]]);
    for (let i = 1; i <= 8; i++) await page.touch("move", [[at.x + (dx * i) / 8, at.y + (dy * i) / 8]]);
    if (hold) await pause(hold);
    await page.touch("end");
  };
  const now = (id) => page.eval(`(() => { const c = ${song}.layout().find((c) => c.id === "${id}"); return { start: c.start, lane: c.lane }; })()`);
  // The second take is the chosen one (it just came in): a plain drag moves it.
  await page.waitFor(`document.querySelector('.clip.selected')?.dataset.id === "${b.id}"`);
  await drag(b.id, pps, 0);
  await page.waitFor(`${song}.layout().find((c) => c.id === "${b.id}").start !== ${b.start}`);
  let got = await now(b.id);
  assert.ok(Math.abs(got.start - (b.start + 1000)) <= 30 && got.lane === 0, "a second later on the same row: " + JSON.stringify(got));
  // Over its neighbour: it stops against the end of the first one.
  await drag(b.id, -2 * pps, 0);
  await page.waitFor(`${song}.layout().find((c) => c.id === "${b.id}").start === ${a.end}`);
  assert.equal((await now(b.id)).lane, 0, "still on its row");
  // Down to the bottom edge and held there: the rows run on below and it lands lower than the screen showed.
  await page.front(); // frames run only for the page in front
  const tl = await page.eval(`(() => { const r = document.getElementById("timeline").getBoundingClientRect(); return { bottom: r.bottom }; })()`);
  const at = await box(b.id);
  await drag(b.id, 0, tl.bottom - 10 - at.y, { hold: 1200 });
  await page.waitFor(`${song}.layout().find((c) => c.id === "${b.id}").lane >= 5`, 4000);
  assert.ok((await page.eval(`document.getElementById("timeline").scrollTop`)) > 0, "the rows scrolled while it was held at the edge");
  await click(page, "#undo");
  await page.waitFor(`${song}.layout().find((c) => c.id === "${b.id}").lane === 0`);
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
  await page.waitFor(`!document.querySelector("#add-sound")`, 2000); // the sheet closed by itself (it slides away first)
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

// The owner, on an iPad: "폰 녹음 앱으로 녹음하기 누르면 비디오가 나와서 녹음되는데 그거는 또 사용할 수 없다".
scenario("song: a camera video (.mov, what an iPad gives for 'record a sound') brings its sound in, also where the browser reads no sound from a video (Safari)", async ({ open, fixtures }) => {
  if (!fixtures.mov) return console.log("     (skipped: ffmpeg could not make a .mov here)");
  const page = await open();
  // Like Safari: a file that holds a picture track gives no sound.
  await page.eval(`(() => {
    const real = AudioContext.prototype.decodeAudioData;
    window.__refusedVideos = 0;
    AudioContext.prototype.decodeAudioData = function (bytes, ok, fail) {
      const text = new TextDecoder("latin1").decode(new Uint8Array(bytes));
      if (text.includes("vide")) {
        window.__refusedVideos++;
        const err = new DOMException("Decoding failed", "EncodingError");
        if (fail) fail(err);
        return Promise.reject(err);
      }
      return real.call(this, bytes, ok, fail);
    };
    return true;
  })()`);
  await createSongRoom(page);
  await importSound(page, fixtures.mov);
  assert.ok((await page.eval("window.__refusedVideos")) >= 1, "the whole video was refused first");
  assert.deepEqual(await noteNames(page), ["도", "레", "미", "파", "솔"]);
});

scenario("song: a take recorded far from the phone (34 dB soft) still gives every note, and is made loud enough to hear", async ({ open, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.quiet);
  assert.deepEqual(await noteNames(page), ["도", "레", "미", "파", "솔"]);
  // The kept recording is louder than the file was (its loudest sample near the top).
  const top = await page.eval(`(async () => {
    const song = window.__app.session.doc("song");
    const src = song.source(song.layout()[0].src);
    const kept = await window.__app.blobs.get(src.blob);
    const v = new DataView(kept.data);
    let top = 0;
    for (let i = 44; i + 1 < kept.data.byteLength; i += 2) top = Math.max(top, Math.abs(v.getInt16(i, true)));
    return top / 32768;
  })()`);
  const file = readFileSync(fixtures.quiet);
  let was = 0;
  for (let i = 44; i + 1 < file.length; i += 2) was = Math.max(was, Math.abs(file.readInt16LE(i)));
  assert.ok(top >= (was / 32768) * 12, `made louder: ${top} from ${was / 32768}`);
});

scenario("song: every take is also kept in 레퍼런스 녹음, with the room it went into", async ({ open, fixtures }) => {
  const page = await open();
  await createSongRoom(page, { room: "흥얼 방" });
  await importSound(page, fixtures.doremi);
  await click(page, "#room-reference");
  await page.waitFor(q("#ref-tab-sounds"));
  await click(page, "#ref-tab-sounds");
  await page.waitFor(`[...document.querySelectorAll(".ref-sound .ref-from")].some((p) => p.textContent === "'흥얼 방'에서")`);
});

// The owner: "마이크를 브라우저에서 허용해주세요 뜨는데… 바로 허용하시겠습니까? 그런 거 뜨게 해줘".
scenario("song: when the mic is refused, a sheet's one button asks the browser again (from the tap) and recording starts once allowed; a blocked site gets the steps", async ({ open }) => {
  const page = await open();
  await createSongRoom(page);
  // The browser says no until the sheet's button is pressed.
  await page.eval(`(() => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__micAsks = 0;
    window.__micAllowed = false;
    navigator.mediaDevices.getUserMedia = (c) => {
      window.__micAsks++;
      return window.__micAllowed ? real(c) : Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    };
    return true;
  })()`);
  await click(page, "#record");
  await page.waitFor(q("#mic-allow"));
  // Blocked: the button's answer is an immediate no, so the steps show.
  await click(page, "#mic-allow");
  await page.waitFor(`!${q("#mic-steps")}.hidden`);
  assert.match(await text(page, "#mic-steps"), /마이크/);
  // Allowed now: the button asks again, the sheet goes, and the take starts.
  await page.eval("window.__micAllowed = true");
  await click(page, "#mic-allow");
  await page.waitFor(`!${q("#mic-allow")} && document.querySelector(".clip.rec")`, 8000);
  await page.waitFor("false", 1500).catch(() => {});
  await click(page, "#record");
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 1`, 15000);
});

// The owner: "다른 기기에서 올린 거는 다른 기기에서 못 보게 원본이 여기 없다고 뜨는데… 고쳐줘".
scenario("song: a friend's device shows the same clips, plays them as piano, and gets the take's own sound through the room (원본 plays there too)", async ({ open, fixtures }) => {
  const a = await open({ dev: "a" });
  const id = await createSongRoom(a, { room: "같이 부르는 방" });
  await importSound(a, fixtures.doremi);
  const b = await open({ dev: "b" });
  await b.goto(await localLink(a, "b", id));
  await b.waitFor("window.__app && window.__app.booted");
  await joinNew(b, { name: "나래" });
  await b.waitFor(`document.querySelectorAll(".clip[data-id] .note").length === 5`);
  assert.deepEqual(await noteNames(b), ["도", "레", "미", "파", "솔"]);
  // The take's own sound came through the room's files under the take's key: 원본 has it here.
  const blob = await a.eval(`[...window.__app.session.doc("song").sources.values()][0].blob`);
  await b.waitFor(`!!window.__app.session.doc("files").named(${JSON.stringify(blob)})`, 15000);
  assert.equal(await b.eval(`window.__app.blobs.get(${JSON.stringify(blob)}).then((k) => !!k)`), false, "the friend's device has no copy of its own");
  await click(b, "#mode-original");
  await b.waitFor(`!document.querySelector(".clip[data-id] .clip-note")`);
  await click(b, "#play");
  await b.waitFor(`window.__app.player?.playing && !!window.__app.player.audioFor([...window.__app.session.doc("song").sources.keys()][0])`, 8000);
  const heard = await b.eval(`(() => { const buf = window.__app.player.audioFor([...window.__app.session.doc("song").sources.keys()][0]); const x = buf.getChannelData(0); let e = 0; for (const v of x) e += v * v; return { seconds: buf.duration, rms: Math.sqrt(e / x.length) }; })()`);
  assert.ok(heard.seconds > 2 && heard.rms > 0.01, "the voice itself, whole: " + JSON.stringify(heard));
  await click(b, "#play");
  // Sent once: opening the room again on the maker's device does not send it again.
  const parts = await a.eval(`window.__app.session.doc("files").files.size`);
  assert.equal(parts, 1, "one file for the one take");
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
  const presets = await page.eval(`[...document.querySelectorAll(".swatch[data-key]:not([data-key='clear'])")].map((b) => [b.dataset.key, b.dataset.accent, b.getAttribute("aria-label")])`);
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
    // 투명 (the owner: "투명 색깔도"): clear glass, no colour of its own.
    await click(page, '[data-key="clear"]');
    const clear = await page.eval(`(() => ({ glass: document.documentElement.dataset.glass, bar: getComputedStyle(document.querySelector(".room > .bar")).backgroundImage, pressed: document.querySelector('[data-key="clear"]').getAttribute("aria-pressed") }))()`);
    assert.equal(clear.glass, "clear");
    assert.equal(clear.pressed, "true");
    assert.ok(!tinted(clear.bar) || tinted(clear.bar).every((v, _, a) => Math.abs(v - a[0]) < 0.02), `${theme}: the clear glass is colourless: ${clear.bar}`);
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
  const shown = (sel) => `(${q(sel)} && !${q(sel)}.hidden)`;
  await a.waitFor(`!${q("#sel-tools")}.hidden && ${shown("#sel-lock")} && ${q('#sel-tools [data-hl="yellow"]')}`);
  await click(a, '#sel-tools [data-hl="yellow"]');
  await a.waitFor(`${sheet(a)}.marks().length === 1`);
  await b.waitFor(`[...${TODAY}.querySelectorAll('.w.hl[data-hl="yellow"]')].map((w) => w.textContent).join("") === "노을이"`);
  await click(a, "#sel-lock");
  await a.waitFor(`${sheet(a)}.locks().length === 1 && ${shown("#sel-unlock")} && !${shown("#sel-lock")}`);
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
  await a.waitFor(shown("#sel-unlock"));
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
    return { pps: Number(tl.dataset.pps), x: (left + right) / 2, seen: right - left, y: c.top + c.height / 2, h: c.height, zero: r.left + Number(tl.dataset.pad),
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
scenario("whiteboard zoom: zoomed far in, cards stay beneath the bars; far out (to a twentieth); zoom moves nothing against anything else; 노래 stretches only the card stretched; order lines follow a card while it is dragged; loop chips shrink when zoomed out", async ({ open, fixtures }) => {
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
  // 노래 stretches only the card stretched (the owner: "이 녹음된 것만 늘리려고 했는데 다른 것까지
  // 다 늘려주면"): the other stays as it was, where it was.
  await click(page, "#mode-all");
  const plain = await cardBox(page, 1);
  const other = await cardBox(page, 0);
  await click(page, "#mode-song");
  await page.tap(plain.cx, plain.cy + 20);
  await page.waitFor(`document.querySelector(".card.chosen")?.dataset.id === ${JSON.stringify(plain.id)}`);
  await click(page, "#stretch-in");
  await click(page, "#stretch-in");
  await frames(page);
  const stretched = await cardBox(page, 1);
  assert.ok(stretched.w > plain.w * 1.8, "stretched in 노래: " + plain.w + " → " + stretched.w);
  const still = await cardBox(page, 0);
  assert.ok(Math.abs(still.w - other.w) < 1 && Math.abs(still.x - other.x) < 1, "the other card did not change: " + JSON.stringify({ other, still }));
  await page.waitFor(`${board}.item(${JSON.stringify(plain.id)}).w > ${Math.round(plain.w * 1.8)}`, 3000);
  await click(page, "#mode-all");
  // Zoom moves nothing against anything else: the gap between two cards grows exactly as they do.
  const before = [await cardBox(page, 0), await cardBox(page, 1)];
  const mid = await page.eval(`(() => { const r = document.getElementById("room-body").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  for (let i = 0; i < 3; i++) await page.wheel(mid[0], mid[1], -200);
  await frames(page);
  const after = [await cardBox(page, 0), await cardBox(page, 1)];
  const k = after[0].w / before[0].w;
  assert.ok(Math.abs(after[1].w / before[1].w - k) < 0.02 && Math.abs((after[1].x - after[0].x) / (before[1].x - before[0].x) - k) < 0.02, "zoom scales every card and gap alike: " + JSON.stringify({ before, after }));
  for (let i = 0; i < 3; i++) await page.wheel(mid[0], mid[1], 200);
  await frames(page);
  // Zoomed far in, nothing of the cards shows over the bars.
  const v = await page.eval(`(() => { const r = document.getElementById("room-body").getBoundingClientRect(); return [r.left + r.width / 2, r.top + 40]; })()`);
  for (let i = 0; i < 16; i++) await page.wheel(v[0], v[1], -200);
  await frames(page);
  const over = await page.eval(`(() => { const out = []; for (const el of document.querySelectorAll("#room-top button, .room > .bar button")) { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (hit && hit.closest(".board")) out.push(el.id || el.textContent); } return out; })()`);
  assert.deepEqual(over, [], "the bars stay on top of the board");
  // Zoomed out far: to a twentieth (the owner: "축소를 완전 많이").
  for (let i = 0; i < 60; i++) await page.wheel(v[0], v[1] + 200, 200);
  await frames(page);
  const far = await page.eval(`(() => { const m = /scale\\(([0-9.]+)\\)/.exec(document.getElementById("board-content").style.transform); return m ? Number(m[1]) : 1; })()`);
  assert.ok(far <= 0.06, "zoomed out to " + far);
  for (let i = 0; i < 20; i++) await page.wheel(v[0], v[1] + 200, -200);
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
scenario("whiteboard 올가미 closing and kinds: drawn, its line is neon and what it goes round lights up; brought back to its start it closes before the lift as the plain loop; a second finger's tap and a right click close it too; 곡·글·그림·전체 decide what 지우기 and a drag take (drawings move with it); 붙여넣기 puts what was copied inside; in 노래 only its part plays", async ({ open, out, fixtures }) => {
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
  // Round everything. While it is drawn the line is neon (the line only); nearly closed, what it goes
  // round lights up with it; brought right back to the start it closes before the finger lifts, and is
  // the plain loop again ("원래 하던 대로").
  const box = { l: v.l - 16, t: v.t - 16, r: Math.min(v.r + 16, 520), b: v.b + 60 };
  const ring = [[box.l, box.t], [box.r, box.t], [box.r, box.b], [box.l, box.b]];
  await page.touch("start", [ring[0]]);
  for (let k = 1; k < ring.length; k++) for (let i = 1; i <= 8; i++) await page.touch("move", [[ring[k - 1][0] + ((ring[k][0] - ring[k - 1][0]) * i) / 8, ring[k - 1][1] + ((ring[k][1] - ring[k - 1][1]) * i) / 8]]);
  const line = await page.eval(`(() => { const p = document.querySelector(".board-loops path.drawing"); const cs = getComputedStyle(p); return { fill: cs.fill, glow: cs.filter }; })()`);
  assert.ok(line.fill === "none" && line.glow.includes("drop-shadow"), "a neon line, nothing filled: " + JSON.stringify(line));
  for (const y of [box.t + 90, box.t + 60, box.t + 30]) await page.touch("move", [[box.l, y]]);
  await page.waitFor(`document.querySelector(".board-loops path.drawing.near") && document.querySelectorAll(".card.lasso-glow").length === 2`);
  await page.shot(out("board-lasso-neon.png"));
  await page.touch("move", [[box.l, box.t + 6]]);
  await page.waitFor(`${board}.lassos().length === 1`);
  const closed = await page.eval(`(() => { const p = document.querySelector(".board-loops path[data-lasso]"); return { drawing: !!document.querySelector(".board-loops path.drawing"), dash: getComputedStyle(p).strokeDasharray, glowing: document.querySelectorAll(".card.lasso-glow").length }; })()`);
  assert.ok(!closed.drawing && closed.dash !== "none" && closed.glowing === 0, "closed: the plain dashed loop, nothing glowing: " + JSON.stringify(closed));
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
  // (One 올가미 at a time: each new one takes the place of the one before.)
  const before1 = await page.eval(`${board}.lassos()[0].id`);
  await page.touch("start", [empty]);
  for (const pt of arc) await page.touch("move", [pt]);
  const last = arc[arc.length - 1];
  await page.touch("start", [last, [last[0] + 120, last[1] - 80]]);
  await page.touchIds("end", [[1, last[0] + 120, last[1] - 80]]); // the second finger lifts where it came down; the first stays
  await page.waitFor(`${board}.lassos().length === 1 && ${board}.lassos()[0].id !== ${JSON.stringify(before1)}`, 3000);
  await page.touch("end");
  // A right click while the left button is held closes one too.
  const before2 = await page.eval(`${board}.lassos()[0].id`);
  const m0 = [empty[0] + 220, empty[1]];
  await page.press(m0[0], m0[1]);
  for (let i = 1; i <= 8; i++) await page.moveTo(m0[0] + i * 12, m0[1] - (i <= 4 ? i * 14 : (8 - i) * 14));
  await page.rightWhileLeft(m0[0] + 96, m0[1]);
  await page.waitFor(`${board}.lassos().length === 1 && ${board}.lassos()[0].id !== ${JSON.stringify(before2)}`, 3000);
  await page.release(m0[0] + 96, m0[1]);
});

// The owner: "두번째나 두번 이상인 것들은 내가 터치한 그 부분의 초로 가게 돼… 세로선이… 거기서 재생하면 거기서부터… 분할을 누르면 분할".
scenario("whiteboard song card: the first tap shows its menu (▶ first); a second tap puts a line with its time where tapped; ▶ plays from there and the menu stays; 분할 cuts there", async ({ open, out, fixtures }) => {
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
  await page.front();
  await page.shot(out("board-cursor.png"));
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
scenario("whiteboard 올가미 more: a card's own 색; ⋯ 색 first asks what (곡·글·그림·전체), then colours those and the loop, never a person's colour; one 올가미 at a time; 순서 정리 lays them in one row inside a new loop; 잇기 joins the songs from the left; 음소거 and 소리 켜기; 반복 marks its ▶; undo", async ({ open, out, fixtures }) => {
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
  // 색 (the owner: "올가미에서 선택 영역을 했으면 거기서 무슨 색을 할거냐", 곡·텍스트·그림·전체;
  // "내 고유색을 바꾸는게 아니라 그냥 거기 색깔을"): first what, then the colour.
  const myDot = () => page.eval(`getComputedStyle(document.querySelector("#people .dot")).backgroundColor`);
  const mine = await myDot();
  await click(page, `[id="lasso-more-${first}"]`);
  await click(page, "#lasso-tint");
  await page.waitFor(q("#lasso-tint-kinds"));
  assert.deepEqual(await page.eval(`[...document.querySelectorAll("#lasso-tint-kinds button")].map((b) => [b.textContent, b.getAttribute("aria-pressed")])`),
    [["곡 2", "false"], ["글 1", "false"], ["그림 0", "false"], ["전체 3", "true"]]);
  await click(page, '#lasso-tint-kinds [data-tint-kind="song"]');
  await page.waitFor(`${q('#lasso-tint-kinds [data-tint-kind="song"]')}?.getAttribute("aria-pressed") === "true"`);
  await click(page, '#lasso-menu [data-tint="5"]');
  await page.waitFor(`${board}.lassos()[0].tint === 5 && ${board}.items().filter((i) => i.kind === "song").every((i) => i.tint === 5)`);
  assert.equal(await page.eval(`${board}.items().find((i) => i.kind === "note").tint ?? null`), null, "the words were not chosen: they keep theirs");
  assert.ok(await page.eval(`document.querySelector('.board-loops path[data-lasso="${first}"]').getAttribute("style")?.includes("--lc")`), "the loop is drawn in its colour");
  // Now the words: 글, then a colour.
  await click(page, `[id="lasso-more-${first}"]`);
  await click(page, "#lasso-tint");
  await click(page, '#lasso-tint-kinds [data-tint-kind="note"]');
  await page.waitFor(`${q('#lasso-tint-kinds [data-tint-kind="note"]')}?.getAttribute("aria-pressed") === "true"`);
  await click(page, '#lasso-menu [data-tint="3"]');
  await page.waitFor(`${board}.items().find((i) => i.kind === "note").tint === 3`);
  assert.deepEqual(await page.eval(`${board}.items().filter((i) => i.kind === "song").map((i) => i.tint)`), [5, 5], "the songs keep the colour they took");
  assert.equal(await myDot(), mine, "my own colour never changed");
  await click(page, "#board-undo");
  await page.waitFor(`(${board}.items().find((i) => i.kind === "note").tint ?? null) === null`);
  // Back to 전체 for what follows.
  await click(page, `[id="lasso-more-${first}"]`);
  await click(page, "#lasso-tint");
  await click(page, '#lasso-tint-kinds [data-tint-kind="all"]');
  await page.key("Escape").catch(() => {});
  await click(page, "#mode-lasso");
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
  await frames(page);
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
  // One 올가미 at a time (the owner: "올가미 툴은 하나만"): a new one takes the old one's place; undo brings the old one back.
  // (Drawn on an empty part of the board, away from the loop: a drag that starts inside a loop moves it.)
  const spot = await page.eval(`(() => { const r = document.getElementById("room-body").getBoundingClientRect(); return { cx: r.left + r.width * 0.4, cy: r.bottom - 170, w: 90, h: 70 }; })()`);
  const again = ring(spot, 14, 0.86);
  await page.touch("start", [again[0]]);
  for (const pt of again.slice(1)) await page.touch("move", [pt]);
  await page.touch("end");
  await page.waitFor(`${board}.lassos().length === 1 && ${board}.lassos()[0].id !== ${JSON.stringify(loopId)}`);
  assert.equal(await page.eval(`document.querySelectorAll(".lasso-chip").length`), 1);
  await click(page, "#board-undo");
  await page.waitFor(`${board}.lassos().length === 1 && ${board}.lassos()[0].id === ${JSON.stringify(loopId)}`);
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
scenario("home 녹음: the button opens the kept recordings with an example take to try (heard, seven notes); 보내기 puts a take into a song room as a clip and onto a whiteboard as a card; the book button opens and closes 레퍼런스", async ({ open, out }) => {
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
  await page.front();
  await page.shot(out("home-record.png"));
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

// The owner: "아직도 원본 녹음 파일도 공유 가능이여야되는데. 안돼. 공유가 내그거에 그게 없다고 떠". A take sent
// from home's 녹음 into a room went in as notes only: its original waited until the room was opened
// again on the sending device.
scenario("home 녹음 → 보내기: the take's original goes into the room right away, so a friend's device plays the voice itself without the sender ever opening the room", async ({ open }) => {
  const a = await open({ dev: "a" });
  const id = await createSongRoom(a, { room: "원본 가는 방" });
  await click(a, "#back");
  await a.waitFor(q("#home-record"));
  await click(a, "#home-record");
  await a.waitFor(`[...document.querySelectorAll(".ref-sound .pick-name")].some((n) => n.textContent.startsWith("예시 녹음"))`, 20000);
  const take = await a.eval(`document.querySelector(".ref-sound").dataset.id`);
  await click(a, `[data-send-sound="${take}"]`);
  await a.waitFor(q("#send-rooms"));
  const room = await a.eval(`[...document.querySelectorAll("#send-rooms [data-send-to]")].find((b) => b.textContent.includes("원본 가는 방")).dataset.sendTo`);
  await click(a, `[data-send-to="${room}"]`);
  await a.waitFor(`document.querySelector(".toast")?.textContent.includes("보냈어요")`, 15000);
  // A friend opens the room; the sender stays on home.
  const b = await open({ dev: "b" });
  await b.goto(await localLink(a, "b", id));
  await b.waitFor("window.__app && window.__app.booted");
  await joinNew(b, { name: "나래" });
  await b.waitFor(`document.querySelectorAll(".clip[data-id]").length === 1`, 10000);
  const blob = await b.eval(`[...window.__app.session.doc("song").sources.values()][0].blob`);
  assert.ok(blob, "the clip knows its recording");
  await b.waitFor(`!!window.__app.session.doc("files").named(${JSON.stringify(blob)})`, 15000);
  await click(b, "#mode-original");
  await b.waitFor(`!document.querySelector(".clip[data-id] .clip-note")`, 8000);
  assert.ok(await a.eval(`!!document.getElementById("home") || !!document.querySelector(".home")`), "the sender never opened the room");
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

// The owner: "녹음 한것그 직사각형들 마다 옆에… 배속 다르게도 할수도 있으면".
scenario("song: each recording has its own 빠르기: the menu steps 1× 1.5× 2× 3× 0.5×, the rectangle is as long as it sounds with its speed in the corner, a friend sees it, copy keeps it, undo", async ({ open, fixtures }) => {
  const a = await open({ dev: "a" });
  const id = await createSongRoom(a);
  await importSound(a, fixtures.doremi);
  const b = await open({ dev: "b", hash: "r-" + id });
  await joinNew(b, { name: "나래" });
  await b.waitFor(`window.__app.session.doc("song").layout().length === 1`);
  const song = `window.__app.session.doc("song")`;
  const width = () => a.eval(`document.querySelector(".clip[data-id]").getBoundingClientRect().width`);
  const w1 = await width();
  assert.ok(!(await a.eval(`document.querySelector(".clip[data-id] .speed-badge:not([hidden])")`)), "no badge at 1×");
  await choose(a, ".clip[data-id]");
  assert.equal(await text(a, "#clip-speed"), "빠르기 1×");
  await click(a, "#clip-speed");
  await a.waitFor(`${song}.layout()[0].speed === 1.5`);
  await choose(a, ".clip[data-id]");
  await click(a, "#clip-speed");
  await a.waitFor(`${song}.layout()[0].speed === 2`);
  await a.waitFor(`document.querySelector(".clip[data-id] .speed-badge")?.textContent === "2×"`);
  const w2 = await width();
  assert.ok(Math.abs(w2 - w1 / 2) < 3, `half as long at 2×: ${w1} → ${w2}`);
  await b.waitFor(`${song}.layout()[0].speed === 2 && document.querySelector(".clip[data-id] .speed-badge")?.textContent === "2×"`);
  // Copy and paste: the copy is at 2× too.
  await choose(a, ".clip[data-id]");
  await click(a, "#clip-copy");
  await choose(a, ".clip[data-id]");
  await click(a, "#clip-paste");
  await a.waitFor(`${song}.layout().length === 2`);
  assert.deepEqual(await a.eval(`${song}.layout().map((c) => c.speed || 1)`), [2, 2], "the copy keeps its speed");
  await click(a, "#undo");
  await a.waitFor(`${song}.layout().length === 1`);
  await click(a, "#undo");
  await a.waitFor(`${song}.layout()[0].speed === 1.5`);
  await click(a, "#undo");
  await a.waitFor(`(${song}.layout()[0].speed || 1) === 1 && !document.querySelector(".clip[data-id] .speed-badge:not([hidden])")`);
});

// The owner: "빠르기를 설정하는데 화이트보드에서 왜 크기까지 녹음 직사각형이 바뀌는지" - the card keeps its size at any speed.
scenario("whiteboard: a song card has its own 빠르기 too: it keeps its size at any speed, its length and speed in its head; 분할 keeps the speed in both halves", async ({ open, fixtures }) => {
  const page = await open({ width: 600, height: 800 });
  await songThenBoard(page, fixtures);
  await click(page, "#mode-song");
  await click(page, "#my-songs");
  await page.waitFor(`document.querySelector("#song-drawer .song-pick")`, 8000);
  await click(page, "#song-drawer .song-pick");
  await page.waitFor(`document.querySelectorAll(".card.song").length === 1 && !document.getElementById("song-drawer")`);
  await click(page, "#mode-all");
  const board = `window.__app.session.doc("board")`;
  const dur = await page.eval(`${board}.items()[0].data.dur`);
  const before = await page.eval(`${board}.items()[0].w`);
  const card = await cardBox(page, 0);
  await page.tap(card.x + 30, card.y + card.h - 14);
  await page.waitFor(q("#card-menu #card-speed"));
  assert.equal(await text(page, "#card-menu #card-speed"), "빠르기 1×");
  await click(page, "#card-menu #card-speed");
  await page.waitFor(`${board}.items()[0].speed === 1.5`);
  await page.waitFor(`document.querySelector(".card.song .speed-badge")?.textContent === "1.5×"`);
  const after = await page.eval(`${board}.items()[0].w`);
  assert.equal(after, before, `the card is as wide at 1.5× as it was: ${before} → ${after}`);
  assert.ok(Math.abs((await cardBox(page, 0)).w - card.w) < 1, "and as wide on screen");
  assert.equal(await text(page, ".card.song .card-len"), (dur / 1.5 / 1000).toFixed(1) + "초", "its length as it sounds");
  // A line in the middle, then 분할: both halves at 1.5×.
  await page.waitFor(q("#card-menu"));
  const notesBox = await page.eval(`(() => { const r = document.querySelector(".card.song .card-notes").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  await page.tap(notesBox.x + notesBox.w * 0.5, notesBox.y + notesBox.h / 2);
  await page.waitFor(q(".card.song .card-cursor"));
  await click(page, "#card-menu #card-cut");
  await page.waitFor(`${board}.items().filter((i) => i.kind === "song").length === 2`);
  assert.deepEqual(await page.eval(`${board}.items().map((i) => i.speed)`), [1.5, 1.5]);
});

scenario("whiteboard 화음: a voice over piano put straight onto the board is a card with the tune and, lighter, the chords' notes; 화음 끄기 leaves them out (seen and played), 화음 켜기 brings them back; the colour dots are plain colours", async ({ open, fixtures }) => {
  const page = await open({ width: 600, height: 800 });
  await createBoard(page);
  await click(page, "#mode-song");
  await page.setFiles("#board-file", [fixtures.duet]);
  await page.waitFor(`document.querySelectorAll(".card.song").length === 1`, 20000);
  const board = `window.__app.session.doc("board")`;
  const harmony = await page.eval(`${board}.items()[0].data.notes.filter((n) => n[4] === 1).length`);
  assert.ok(harmony >= 2, "the card keeps which notes are harmony: " + harmony);
  await page.waitFor(`document.querySelectorAll(".card.song .note.harmony").length === ${harmony}`);
  assert.equal(await page.eval(`document.querySelectorAll(".card.song .note:not(.harmony)").length`), 4);
  const card = await cardBox(page, 0);
  await page.tap(card.x + 30, card.y + card.h - 14);
  await page.waitFor(q("#card-menu #card-chords"));
  assert.equal(await text(page, "#card-menu #card-chords"), "화음 끄기");
  await click(page, "#card-menu #card-chords");
  await page.waitFor(`${board}.items()[0].chords === false && document.querySelectorAll(".card.song .note.harmony").length === 0`);
  await page.waitFor(`${q("#card-menu #card-chords")}?.textContent === "화음 켜기"`);
  await click(page, "#card-menu #card-chords");
  await page.waitFor(`document.querySelectorAll(".card.song .note.harmony").length === ${harmony}`);
  // 색: plain dots, no letters on them (the owner took the letters for a bug).
  await click(page, "#card-menu #card-tint");
  await page.waitFor(q("#card-menu .menu-dot"));
  assert.equal(await page.eval(`[...document.querySelectorAll("#card-menu .menu-dot")].filter((d) => d.textContent).length`), 0);
  assert.match(await text(page, "#card-owner"), /넣었어요$/);
});

// The owner (two screenshots): scrolled down, what is inside 레퍼런스 stuck out of its rounded glass.
scenario("레퍼런스: what is inside stays inside its rounded glass; scrolled to the end, the last recording sits clear of the edge", async ({ open }) => {
  const page = await open({ width: 390, height: 700 });
  await page.waitFor(q("#home-record"));
  await click(page, "#home-record");
  await page.waitFor(`document.querySelectorAll("#reference .ref-sound").length >= 1`, 15000);
  const box = await page.eval(`(() => {
    const panel = document.getElementById("reference");
    const body = panel.querySelector(".float-body");
    body.scrollTop = body.scrollHeight;
    const p = panel.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    const cards = [...panel.querySelectorAll(".ref-sound")];
    const last = cards[cards.length - 1].getBoundingClientRect();
    return { overflow: getComputedStyle(panel).overflow, p: [p.top, p.bottom, p.left, p.right], b: [b.top, b.bottom], last: [last.top, last.bottom, last.left, last.right], scrolls: body.scrollHeight > body.clientHeight };
  })()`);
  assert.equal(box.overflow, "hidden", "the glass clips what is inside to its rounded corners");
  assert.ok(box.b[1] <= box.p[1] + 0.5, "the scrolling part ends inside the glass: " + JSON.stringify(box));
  assert.ok(box.last[2] >= box.p[2] && box.last[3] <= box.p[3], "the recording is no wider than the glass: " + JSON.stringify(box));
  if (box.scrolls) assert.ok(box.last[1] <= box.p[1] - 12, "at the end the last recording is clear of the bottom edge: " + JSON.stringify(box));
});


// The owner: "한 번 누르면 안 나가지고", "조금이라도 아래로 스크롤 된 상태이면… 한 번 더 아래로 내리면 내려가는 식".
scenario("sheets: one tap on its close button closes it; pulled down from the top it goes, but content scrolled down scrolls up first", async ({ open }) => {
  const page = await open({ width: 390, height: 560 });
  await page.waitFor(q("#home-settings"));
  await click(page, "#home-settings");
  await page.waitFor(q(".panel .sheet-close"));
  await click(page, ".panel .sheet-close");
  await page.waitFor(`!document.querySelector(".scrim")`, 2000);
  // Pulled from the top: it follows and goes.
  await click(page, "#home-settings");
  await page.waitFor(q(".panel h2"));
  await page.front();
  // Where it rests (a page that is not in front may not run its slide-in at all).
  const top = await page.eval(`(() => { for (const a of document.querySelector(".panel").getAnimations()) a.finish(); const r = document.querySelector(".panel h2").getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; })()`);
  await page.touch("start", [top]);
  for (let i = 1; i <= 8; i++) await page.touch("move", [[top[0], top[1] + i * 30]]);
  await page.touch("end");
  await page.waitFor(`!document.querySelector(".scrim")`, 2000);
  // Scrolled down a little: the first pull only brings the content back up; the next one closes.
  await click(page, "#home-settings");
  await page.waitFor(q(".panel h2"));
  await page.eval(`(() => { for (const a of document.querySelector(".panel").getAnimations()) a.finish(); return true; })()`);
  const scrolls = await page.eval(`(() => { const p = document.querySelector(".panel"); p.scrollTop = 60; return p.scrollHeight > p.clientHeight; })()`);
  if (scrolls) {
    const mid = await page.eval(`(() => { const r = document.querySelector(".panel").getBoundingClientRect(); return [r.left + 30, r.top + 120]; })()`);
    await page.touch("start", [mid]);
    for (let i = 1; i <= 6; i++) await page.touch("move", [[mid[0], mid[1] + i * 25]]);
    await page.touch("end");
    await frames(page);
    assert.ok(await page.eval(`!!document.querySelector(".scrim:not(.closing)")`), "a pull that began scrolled down does not close it");
  }
});

// The owner's iPad screenshots: drawing selected the bar's words (blue handles, 복사하기·찾아보기) and broke strokes.
scenario("drawing with a pen never selects text: the bars, the board and the tools take no selection; a long fast stroke stays one stroke", async ({ open }) => {
  const page = await open({ width: 820, height: 1180 });
  await createBoard(page);
  const app = await page.eval(`(() => ({ app: document.getElementById("app").getBoundingClientRect().width, view: innerWidth }))()`);
  assert.equal(app.app, app.view, "the app fills an iPad's width (no black sides)");
  assert.deepEqual(await page.eval(`[".room > .bar", "#room-title", ".board-modes", "#board", ".toolbar"].map((s) => getComputedStyle(document.querySelector(s)).webkitUserSelect || getComputedStyle(document.querySelector(s)).userSelect)`), ["none", "none", "none", "none", "none"]);
  await click(page, "#board-pen");
  await page.waitFor(`document.querySelector("#board canvas.ink.on")`);
  const r = await page.eval(`(() => { const b = document.getElementById("room-body").getBoundingClientRect(); return { x: b.left + 80, y: b.top + 160 }; })()`);
  await page.front();
  await page.stylus("down", r.x, r.y);
  for (let i = 1; i <= 60; i++) await page.stylus("move", r.x + i * 9, r.y + Math.sin(i / 5) * 60);
  await page.stylus("up", r.x + 540, r.y);
  await page.waitFor(`window.__app.session.doc("k:board").strokes().length === 1`);
  assert.equal(await page.eval(`String(getSelection())`), "", "nothing got selected");
  // A long press on the title with a finger selects nothing either.
  const t = await page.eval(`(() => { const r = document.getElementById("room-title").getBoundingClientRect(); return [r.left + 10, r.top + r.height / 2]; })()`);
  await page.touch("start", [t]);
  await pause(900);
  await page.touch("end");
  assert.equal(await page.eval(`String(getSelection())`), "");
});

// The first description's 노래 잇기 창 ("순서를 내 마음대로 바꿀 수 있어… 순서의 이어짐을 저장… 왔다 갔다 하면서 들어볼 수").
scenario("순서 목록: the order as a row of chips; a chip dragged to the front plays first; saved with a name, renamed, heard; sent to a song room the cards come in that order on one row", async ({ open, fixtures }) => {
  const page = await open({ width: 600, height: 860 });
  await songThenBoard(page, fixtures);
  await click(page, "#mode-song");
  for (let n = 1; n <= 3; n++) {
    await click(page, "#my-songs");
    await page.waitFor(`document.querySelector("#song-drawer .song-pick")`, 8000);
    await click(page, "#song-drawer .song-pick");
    await page.waitFor(`document.querySelectorAll(".card.song").length === ${n} && !document.getElementById("song-drawer")`);
  }
  const board = `window.__app.session.doc("board")`;
  const before = await page.eval(`window.__app.session.doc("board").view().order.filter((i) => i.kind === "song").map((i) => i.id)`);
  await click(page, "#order-list");
  await page.waitFor(`document.querySelectorAll("#order-strip .order-chip").length === 3`);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll("#order-strip .order-chip")].map((c) => c.dataset.id)`), before);
  await page.eval(`(() => { for (const a of document.querySelector(".panel").getAnimations()) a.finish(); return true; })()`);
  // The last chip, held and moved to the front.
  const [first, , last] = await page.eval(`[...document.querySelectorAll("#order-strip .order-chip")].map((c) => { const r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })`);
  await page.front();
  await page.touch("start", [last]);
  for (let i = 1; i <= 8; i++) await page.touch("move", [[last[0] + ((first[0] - 20 - last[0]) * i) / 8, last[1] + ((first[1] - last[1]) * i) / 8]]);
  await page.touch("end");
  const want = [before[2], before[0], before[1]];
  await page.waitFor(`JSON.stringify(window.__app.session.doc("board").view().order.filter((i) => i.kind === "song").map((i) => i.id)) === ${JSON.stringify(JSON.stringify(want))}`);
  await page.waitFor(`[...document.querySelectorAll("#order-strip .order-chip")].map((c) => c.dataset.id).join() === ${JSON.stringify(want.join())}`);
  // Saved, renamed.
  await click(page, "#order-save");
  await page.waitFor(`${board}.slots().length === 1 && ${board}.slots()[0].name === "순서 1"`);
  await click(page, "#order-rename-1");
  await page.waitFor(q("#order-name-input"));
  await page.eval(`(() => { const i = document.getElementById("order-name-input"); i.value = "끝곡 먼저"; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);
  await page.waitFor(`${board}.slots()[0].name === "끝곡 먼저"`);
  // Heard (the order plays).
  await click(page, "#order-play-1");
  await page.waitFor(`window.__app.player?.playing || document.querySelector(".card.song.playing")`, 4000);
  await click(page, "#order-play-1");
  // Sent to the song room: three clips after what it held, in this order, on one row.
  await click(page, "#order-send-1");
  await page.waitFor(q("#send-song-rooms [data-song-room]"), 8000);
  const songRoom = await page.eval(`document.querySelector("#send-song-rooms [data-song-room]").dataset.songRoom`);
  await click(page, `#send-song-rooms [data-song-room="${songRoom}"]`);
  await page.waitFor(`document.querySelector(".toast")?.textContent.includes("순서대로 보냈어요")`, 10000);
  await page.goto((await page.eval(`location.href.split("#")[0]`)) + "#r-" + songRoom);
  await page.waitFor(`window.__app?.session?.roomId === ${JSON.stringify(songRoom)} && window.__app.session.doc("song").layout().length === 4`, 10000);
  const clips = await page.eval(`window.__app.session.doc("song").layout().map((c) => [c.start, c.lane]).sort((a, b) => a[0] - b[0])`);
  assert.equal(new Set(clips.slice(1).map((c) => c[1])).size, 1, "the three came on one row: " + JSON.stringify(clips));
  assert.ok(clips[1][0] < clips[2][0] && clips[2][0] < clips[3][0], "one after another: " + JSON.stringify(clips));
});

// The owner: "홈화면에서 꾹 누르면 보내기… 거기 보내기 누르면 뭘 보내고".
scenario("home: a long press on a whiteboard → 보내기 says what goes and lists where; its songs go to a song room in their order", async ({ open, fixtures }) => {
  const page = await open({ width: 600, height: 860 });
  await songThenBoard(page, fixtures);
  await click(page, "#mode-song");
  for (let n = 1; n <= 2; n++) {
    await click(page, "#my-songs");
    await page.waitFor(`document.querySelector("#song-drawer .song-pick")`, 8000);
    await click(page, "#song-drawer .song-pick");
    await page.waitFor(`document.querySelectorAll(".card.song").length === ${n} && !document.getElementById("song-drawer")`);
  }
  await click(page, "#back");
  await page.waitFor(q('.room-row[data-room-kind="creative-board"]'));
  const at = await page.eval(`(() => { const r = ${q('.room-row[data-room-kind="creative-board"]')}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await page.touch("start", [at]);
  await pause(700);
  await page.touch("end");
  await page.waitFor(q("#room-send"));
  await click(page, "#room-send");
  await page.waitFor(q("#send-what"));
  assert.match(await text(page, "#send-what"), /노래 카드를 순서대로/);
  const song = await page.eval(`window.__app.store.get("rooms", []).find((r) => r.kind === "creative-song").id`);
  await click(page, `#room-actions [data-send-to="${song}"]`);
  await page.waitFor(`document.querySelector(".toast")?.textContent.includes("2개를 보냈어요")`, 10000);
});

// The owner: "노래 만들기에서도 여기 그 올가미 기능도 있어야… 센스 있게".
scenario("song 올가미: drawn round two clips it gathers them; together they mute, speed up, move by one drag (one undo each), play alone, copy and go", async ({ open, fixtures }) => {
  const page = await open({ width: 420, height: 760 });
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  const song = `window.__app.session.doc("song")`;
  const firstEnd = await page.eval(`(() => { const c = ${song}.layout()[0]; return c.start + c.length; })()`);
  const right = await page.eval(`(() => { const r = document.querySelector(".clip[data-id]").getBoundingClientRect(); return { x: r.right + 30, y: r.top + r.height / 2 }; })()`);
  for (let i = 0; i < 2 && (await page.eval(`!!document.querySelector(".clip.selected")`)); i++) { await page.tap(right.x, right.y); await pause(120); }
  await tapTime(page, firstEnd + 5);
  await importSound(page, fixtures.doremi, 2);
  await page.eval(`document.getElementById("timeline").scrollLeft = 0`);
  await click(page, "#song-lasso");
  await page.waitFor(`document.getElementById("timeline").classList.contains("lassoing")`);
  const box = await page.eval(`(() => { const rs = [...document.querySelectorAll(".clip[data-id]")].map((c) => c.getBoundingClientRect()); const tl = document.getElementById("timeline").getBoundingClientRect(); return { l: Math.max(tl.left + 4, Math.min(...rs.map((r) => r.left)) - 10), t: Math.min(...rs.map((r) => r.top)) - 10, r: Math.min(tl.right - 4, Math.max(...rs.map((r) => r.right)) + 10), b: Math.max(...rs.map((r) => r.bottom)) + 10 }; })()`);
  const pts = [[box.l, box.t], [box.r, box.t], [box.r, box.b], [box.l, box.b], [box.l, box.t + 8]];
  await page.front();
  await page.touch("start", [pts[0]]);
  for (let k = 1; k < pts.length; k++) for (let i = 1; i <= 6; i++) await page.touch("move", [[pts[k - 1][0] + ((pts[k][0] - pts[k - 1][0]) * i) / 6, pts[k - 1][1] + ((pts[k][1] - pts[k - 1][1]) * i) / 6]]);
  await page.touch("end");
  await page.waitFor(`document.querySelectorAll(".clip.grouped").length === 2 && ${q("#group-menu")}`);
  assert.equal(await text(page, "#group-menu .group-count"), "클립 2개");
  assert.ok(!(await page.eval(`document.getElementById("timeline").classList.contains("lassoing")`)), "the 올가미 puts itself away once it has gathered");
  // Together: mute, then speed.
  await click(page, "#group-mute");
  await page.waitFor(`${song}.layout().every((c) => c.muted)`);
  await click(page, "#group-speed");
  await page.waitFor(`${song}.layout().every((c) => c.speed === 1.5)`);
  await click(page, "#undo");
  await page.waitFor(`${song}.layout().every((c) => (c.speed || 1) === 1)`);
  // One held and dragged a second later: both go by a second.
  const before = await page.eval(`${song}.layout().map((c) => c.start)`);
  const pps = await page.eval(`Number(document.getElementById("timeline").dataset.pps)`);
  const at = await page.eval(`(() => { const r = document.querySelector(".clip.grouped").getBoundingClientRect(); return [r.left + 30, r.top + r.height / 2]; })()`);
  await page.touch("start", [at]);
  await pause(600);
  await page.waitFor(`document.querySelector(".clip.lifted")`);
  for (let i = 1; i <= 8; i++) await page.touch("move", [[at[0] + (pps * i) / 8, at[1]]]);
  await page.touch("end");
  await page.waitFor(`${song}.layout().map((c) => c.start).join() !== ${JSON.stringify(before.join())}`);
  const after = await page.eval(`${song}.layout().map((c) => c.start)`);
  after.forEach((s, i) => assert.ok(Math.abs(s - before[i] - 1000) <= 30, `both moved a second: ${before} → ${after}`));
  await click(page, "#undo");
  await page.waitFor(`${song}.layout().map((c) => c.start).join() === ${JSON.stringify(before.join())}`);
  // Alone: ▶ plays just them.
  await click(page, "#group-play");
  await page.waitFor(`${q("#group-play")}?.textContent === "■ 멈춤"`);
  await click(page, "#group-play");
  // Copy, then 지우기, then ✕.
  await click(page, "#group-copy");
  await page.waitFor(`window.__app.store.get("clipboard")?.kind === "song-clips" || JSON.stringify(window.__app.store.get("clipboard") || "").includes("song-clips")`);
  await click(page, "#group-delete");
  await page.waitFor(`${song}.layout().length === 0 && !document.getElementById("group-menu")`);
  await click(page, "#undo");
  await page.waitFor(`${song}.layout().length === 2`);
});

scenario("settings: 효과음 and 진동 can be turned off (and the chime then stays quiet)", async ({ open }) => {
  const [a, b] = await together(open);
  await click(a, "#room-settings");
  await a.waitFor(q("#set-sounds"));
  assert.ok(await a.eval(q("#set-haptics")));
  await a.eval(`(() => { document.getElementById("set-sounds").click(); return true; })()`);
  assert.equal(await a.eval(`window.__app.store.get("settings", {}).soundEffects`), false);
});

// Accepted from the UI review: "모드 막대 옮기기", "막대 꾸미기", "오른쪽 도구도 직접 옮기기", "그릴 때 막대 옅어지기".
scenario("song 화음: a voice over piano chords comes in as the tune with the chords' notes under it, drawn lighter; 화음 끄기 leaves them out (seen and heard) for everyone and 화음 켜기 brings them back; in 음 편집 a harmony note is made tune, and 화음 모두 지우기 takes the rest out in one undo step", async ({ open, out, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.duet);
  const song = `window.__app.session.doc("song")`;
  const src = await page.eval(`${song}.layout()[0].src`);
  const notes = await page.eval(`${song}.notesOf(${JSON.stringify(src)}).map((n) => [n.p, !!n.h])`);
  const tune = notes.filter(([, h]) => !h).map(([p]) => p);
  const harmony = notes.filter(([, h]) => h).map(([p]) => p);
  assert.deepEqual(tune, [64, 67, 69, 67], "the voice is the tune: " + JSON.stringify(notes));
  assert.ok(harmony.length >= 2 && harmony.every((p) => [0, 5, 7, 9].includes(p % 12)), "the chords' notes are the harmony: " + harmony);
  // Drawn lighter under the tune.
  await page.waitFor(`document.querySelectorAll(".clip[data-id] .note.harmony").length === ${harmony.length}`);
  assert.equal(await page.eval(`document.querySelectorAll(".clip[data-id] .note:not(.harmony)").length`), 4);
  await page.shot(out("song-harmony.png"));
  // 화음 끄기: gone from the clip and from what plays; 화음 켜기 brings them back.
  await choose(page, ".clip[data-id]");
  assert.equal(await text(page, "#clip-chords"), "화음 끄기");
  await click(page, "#clip-chords");
  await page.waitFor(`document.querySelectorAll(".clip[data-id] .note.harmony").length === 0 && ${song}.layout()[0].chords === false`);
  assert.deepEqual(await page.eval(`${song}.noteEvents(0, 60000).map((e) => e.p)`), [64, 67, 69, 67], "only the tune plays");
  await choose(page, ".clip[data-id]");
  assert.equal(await text(page, "#clip-chords"), "화음 켜기");
  await click(page, "#clip-chords");
  await page.waitFor(`document.querySelectorAll(".clip[data-id] .note.harmony").length === ${harmony.length}`);
  // 음 편집: a harmony note made part of the tune; the rest cleared at once; one undo brings them back.
  await choose(page, ".clip[data-id]");
  await click(page, "#clip-notes");
  await page.waitFor(q("#roll .rnote.harmony"));
  assert.equal(await page.eval(`document.querySelectorAll("#roll .rnote.harmony").length`), harmony.length);
  await click(page, "#roll .rnote.harmony");
  await page.waitFor(`${q("#note-part")}.textContent === "멜로디로" && !${q("#note-part")}.hidden`);
  await click(page, "#note-part");
  await page.waitFor(`document.querySelectorAll("#roll .rnote.harmony").length === ${harmony.length - 1}`);
  await click(page, "#harmony-clear");
  await page.waitFor(`document.querySelectorAll("#roll .rnote.harmony").length === 0 && ${q("#harmony-clear")}.hidden`);
  assert.equal(await page.eval(`${song}.notesOf(${JSON.stringify(src)}).length`), 5, "the tune and the one made tune stay");
  await page.key("Escape");
  await page.waitFor(`!document.querySelector(".scrim")`, 2000);
  await click(page, "#undo");
  await page.waitFor(`${song}.notesOf(${JSON.stringify(src)}).length === ${notes.length}`);
});

scenario("song 줄 머리: each row has a head at the left edge - who sang on it (their colour), 음소거 for the whole row (one undo step) and 혼자 듣기 (only that row plays; the others step back); time starts right of the heads, so they cover nothing at the start", async ({ open, out, fixtures }) => {
  const page = await open();
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  await tapEmptyRow(page);
  await tapTime(page, 0);
  await importSound(page, fixtures.doremi, 2);
  const song = `window.__app.session.doc("song")`;
  const lanes = await page.eval(`${song}.layout().map((c) => c.lane).sort()`);
  assert.deepEqual(lanes, [0, 1], "two rows");
  await tapEmptyRow(page);
  // The heads: my colour on both rows, buttons on the rows with clips only.
  await page.waitFor(q('.row-head[data-row="1"] .row-who .dot'));
  const look = await page.eval(`(() => {
    const head = document.querySelector('.row-head[data-row="0"]').getBoundingClientRect();
    const clip = document.querySelector(".clip[data-id]").getBoundingClientRect();
    const empty = document.querySelector('.row-head[data-row="2"]');
    return { headRight: head.right, clipLeft: clip.left, emptyButtons: empty ? [...empty.querySelectorAll(".row-btn")].filter((b) => !b.hidden).length : -1,
      dot: getComputedStyle(document.querySelector('.row-head[data-row="0"] .row-who .dot')).backgroundColor };
  })()`);
  assert.ok(look.clipLeft >= look.headRight - 1, "the clip at 0 starts right of the head: " + JSON.stringify(look));
  assert.equal(look.emptyButtons, 0, "the empty row has no buttons");
  // 음소거: the whole first row, for everyone; undo brings it back in one step.
  await click(page, "#row-mute-0");
  await page.waitFor(`${song}.layout().filter((c) => c.lane === 0).every((c) => c.muted) && ${q("#row-mute-0")}.getAttribute("aria-pressed") === "true"`);
  assert.ok(await page.eval(`${song}.layout().filter((c) => c.lane === 1).every((c) => !c.muted)`), "the other row still sounds");
  await click(page, "#undo");
  await page.waitFor(`${song}.layout().every((c) => !c.muted)`);
  // 혼자 듣기: only the second row plays; the first steps back; again, all rows.
  await click(page, "#row-solo-1");
  await page.waitFor(`${q("#row-solo-1")}.getAttribute("aria-pressed") === "true" && document.querySelectorAll(".clip.quiet").length === 1`);
  await click(page, "#play");
  await page.waitFor(`window.__app.player?.playing`);
  assert.deepEqual(await page.eval(`window.__app.player.song().layout().map((c) => c.lane)`), [1], "only the second row is heard");
  await click(page, "#play");
  await page.shot(out("song-row-heads.png"));
  await click(page, "#row-solo-1");
  await page.waitFor(`${q("#row-solo-1")}.getAttribute("aria-pressed") === "false" && !document.querySelector(".clip.quiet")`);
  assert.equal(await page.eval(`window.__app.player.song().layout().length`), 2, "all rows again");
});

scenario("song 옆 패널: on a wide screen lying down the chosen clip's name and actions stand at the side, the timeline keeps the rest; another clip is chosen with one tap; with nothing chosen the side says what the song is", async ({ open, out, fixtures }) => {
  const page = await open({ width: 1180, height: 820 });
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  await tapEmptyRow(page);
  await tapTime(page, 0);
  await importSound(page, fixtures.doremi, 2);
  await page.waitFor(q("#song-side #clip-menu"));
  const m = await page.eval(`(() => { const t = document.getElementById("timeline").getBoundingClientRect(), s = document.getElementById("song-side").getBoundingClientRect(); return { tRight: t.right, sLeft: s.left, info: document.getElementById("clip-info")?.textContent || "" }; })()`);
  assert.ok(m.tRight <= m.sLeft, "the timeline ends before the side panel: " + JSON.stringify(m));
  assert.match(m.info, /doremi/, "the clip's name: " + m.info);
  const ids = await page.eval(`window.__app.session.doc("song").layout().map((c) => c.id)`);
  const chosen = () => page.eval(`document.querySelector(".clip.selected")?.dataset.id || null`);
  const other = (await chosen()) === ids[0] ? ids[1] : ids[0];
  await click(page, `.clip[data-id="${other}"]`);
  await page.waitFor(`document.querySelector(".clip.selected")?.dataset.id === ${JSON.stringify(other)}`);
  await page.shot(out("song-side.png"));
  await tapEmptyRow(page);
  await page.waitFor(`!document.querySelector(".clip.selected") && ${q("#side-summary")}`);
  assert.match(await text(page, "#side-summary"), /클립 2개/);
});

// The owner on an iPad: "폴드폰처럼… 크기를 줄였다", "손을 기대고 하는데… 잠금 기능으로 위에다가 아이콘
// 검정으로 조그마낳게… 아무것도 안눌리게", "잠시 옆에 숨기기로 안 나오게", "너무 나열식… 버튼 형식으로다가
// 설명은 아래에".
scenario("song 옆 패널 again: the actions are a grid of buttons with the word under the icon; its inner edge drags it wider (remembered); the small lock makes a resting hand press nothing; it hides to a tab and comes back", async ({ open, out, fixtures }) => {
  const page = await open({ width: 1180, height: 820 });
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  await page.waitFor(q("#song-side #clip-menu .side-btn"));
  const grid = await page.eval(`[...document.querySelectorAll("#song-side .side-btn")].map((b) => ({ id: b.id, icon: !!b.querySelector("svg, .menu-swatch"), word: b.querySelector(".side-btn-word")?.textContent || "", w: b.getBoundingClientRect().width }))`);
  assert.ok(grid.length >= 8 && grid.every((b) => b.icon && b.word), "icon and word on each: " + JSON.stringify(grid));
  assert.ok(grid.find((b) => b.id === "clip-play")?.word === "듣기" && grid.find((b) => b.id === "clip-delete")?.word === "삭제");
  const rowOf = await page.eval(`(() => { const ys = [...document.querySelectorAll("#song-side .side-btn")].map((b) => Math.round(b.getBoundingClientRect().top)); return new Set(ys).size < ys.length; })()`);
  assert.ok(rowOf, "several buttons side by side in a row (a grid, not a list)");
  await page.shot(out("song-side-grid.png"));
  // Wider by its inner edge.
  const before = await page.eval(`document.getElementById("song-side").getBoundingClientRect().width`);
  const edge = await page.eval(`(() => { const r = document.getElementById("side-edge").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await page.press(edge[0], edge[1]);
  for (let i = 1; i <= 8; i++) await page.moveTo(edge[0] - i * 10, edge[1]);
  await page.release(edge[0] - 80, edge[1]);
  await page.waitFor(`document.getElementById("song-side").getBoundingClientRect().width > ${before} + 60`);
  const saved = await page.eval(`window.__app.store.get("settings", {}).songSide?.w`);
  assert.ok(saved > 15 && saved < 26, "the width is remembered: " + saved);
  const tl = await page.eval(`(() => { const t = document.getElementById("timeline").getBoundingClientRect(), s = document.getElementById("song-side").getBoundingClientRect(); return t.right <= s.left + 1; })()`);
  assert.ok(tl, "the timeline still ends before it");
  // The lock: a resting hand on the panel presses nothing; the lock itself still answers.
  await click(page, "#side-lock");
  await page.waitFor(`${q("#side-lock")}.getAttribute("aria-pressed") === "true"`);
  const muteAt = await page.eval(`(() => { const r = document.getElementById("clip-mute").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await page.tap(muteAt[0], muteAt[1]);
  await pause(300);
  assert.equal(await page.eval(`window.__app.session.doc("song").layout()[0].muted || false`), false, "locked: the tap did nothing");
  await page.shot(out("song-side-locked.png"));
  await click(page, "#side-lock");
  await page.waitFor(`${q("#side-lock")}.getAttribute("aria-pressed") === "false"`);
  await click(page, "#clip-mute");
  await page.waitFor(`window.__app.session.doc("song").layout()[0].muted === true`);
  // Hidden to a tab at the edge; the timeline takes the width; back again.
  await click(page, "#side-hide");
  await page.waitFor(`getComputedStyle(document.getElementById("song-side")).display === "none" && ${q("#side-tab")}.getBoundingClientRect().width > 0`);
  const wide = await page.eval(`document.getElementById("timeline").getBoundingClientRect().right > innerWidth - 80`);
  assert.ok(wide, "the timeline takes the width while it is hidden");
  await page.shot(out("song-side-hidden.png"));
  await click(page, "#side-tab");
  await page.waitFor(`getComputedStyle(document.getElementById("song-side")).display !== "none"`);
  assert.equal(await page.eval(`window.__app.store.get("settings", {}).songSide?.hidden`), false);
});

// The owner: "노래 모드랑 어디 모드로 갈 때 그냥 단지 그 모드로 가는 게 아니라… 물처럼 작아졌다가 거기까지 가는".
scenario("motion: the chosen mark runs like a drop of water from one mode to the next - smaller on the way, the same size as the new choice where it settles; in the song room 원본/피아노 too", async ({ open, fixtures }) => {
  const page = await open();
  await createBoard(page);
  const box = (sel) => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  await page.waitFor(`document.querySelector(".board-modes").classList.contains("has-pill")`);
  const start = await box(".board-modes .seg-pill");
  const all = await box("#mode-all");
  assert.ok(Math.abs(start.x - all.x) < 1 && Math.abs(start.w - all.w) < 1, "it stands on 전체: " + JSON.stringify([start, all]));
  const clear = await page.eval(`(() => { const s = getComputedStyle(document.getElementById("mode-all")); return s.backgroundImage === "none" && s.backgroundColor === "rgba(0, 0, 0, 0)"; })()`);
  assert.ok(clear, "the chosen button itself is clear: the mark is the drop");
  await page.front();
  await click(page, "#mode-song");
  // On its way: smaller than either end (a drop), and moving.
  let smallest = Infinity;
  for (let i = 0; i < 12; i++) {
    const w = await page.eval(`document.querySelector(".board-modes .seg-pill").getBoundingClientRect().width`);
    smallest = Math.min(smallest, w);
    await pause(25);
  }
  const song = await box("#mode-song");
  assert.ok(smallest < Math.min(all.w, song.w) * 0.9, `it gathers into a drop on the way: ${smallest} < ${Math.min(all.w, song.w)}`);
  await page.waitFor(`!document.querySelector(".board-modes .seg-pill").getAnimations().length`, 2000);
  const end = await box(".board-modes .seg-pill");
  assert.ok(Math.abs(end.x - song.x) < 1 && Math.abs(end.w - song.w) < 1, "it settles on 노래, its size: " + JSON.stringify([end, song]));
  // The song room's 원본/피아노 flows the same way.
  await click(page, "#back");
  await createSongRoom(page);
  await importSound(page, fixtures.doremi);
  await page.waitFor(`document.querySelector(".mode-switch").classList.contains("has-pill")`);
  await click(page, "#mode-original");
  // The mark moves on the next frame after the choice, then runs: wait until it has settled there.
  await page.waitFor(`(() => { const p = document.querySelector(".mode-switch .seg-pill"), b = document.getElementById("mode-original"); if (p.getAnimations().length) return false; const a = p.getBoundingClientRect(), c = b.getBoundingClientRect(); return Math.abs(a.left - c.left) < 1 && Math.abs(a.width - c.width) < 1; })()`, 2000);
  const pill = await box(".mode-switch .seg-pill");
  const orig = await box("#mode-original");
  assert.ok(Math.abs(pill.x - orig.x) < 1 && Math.abs(pill.w - orig.w) < 1, "on 원본 now: " + JSON.stringify([pill, orig]));
});

scenario("whiteboard bar: a long press opens 막대 꾸미기 (icons only, a mode hidden, 노래 first, large); held and dragged to the left edge it stands there upright, the tools on the right; the tools held and let go on the left half stand on the left and the hint says so; while drawing the bars step back; 처음대로", async ({ open, out }) => {
  const page = await open({ width: 700, height: 900 });
  await createBoard(page);
  const room = `document.querySelector(".room")`;
  const hold = async (sel, to = null) => {
    // A page in the back gets its timers and frames late (a long press would end before it counts,
    // and what is placed on the next frame would move after it was measured): to the front first.
    await page.front();
    await pause(80);
    const at = await page.eval(`(() => { const r = ${q(sel)}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await page.touch("start", [at]);
    await pause(650);
    if (to) for (let i = 1; i <= 10; i++) await page.touch("move", [[at[0] + ((to[0] - at[0]) * i) / 10, at[1] + ((to[1] - at[1]) * i) / 10]]);
    await page.touch("end");
  };
  await hold("#mode-all");
  await page.waitFor(q("#bar-settings"));
  assert.equal(await page.eval(`${q("#mode-all")}.getAttribute("aria-pressed")`), "true", "the long press chose no mode");
  await click(page, "#bar-icons");
  await page.waitFor(`${room}.dataset.modesIcons === "true" && !!document.querySelector("#mode-song svg")`);
  assert.equal(await page.eval(`${q("#mode-song")}.getAttribute("aria-label")`), "노래");
  await click(page, "#bar-show-link");
  await page.waitFor(`!document.getElementById("mode-link")`);
  for (let i = 0; i < 4; i++) await click(page, "#bar-up-song");
  await page.waitFor(`document.querySelector(".board-modes button").id === "mode-song"`);
  await click(page, "#bar-size-3");
  await page.waitFor(`${room}.dataset.barSize === "3"`);
  await page.key("Escape");
  await page.waitFor(`!document.querySelector(".scrim")`, 2000);
  // Dragged to the left edge: it stands there upright, the tools go right.
  await page.front();
  const r = await page.eval(`(() => { const b = ${room}.getBoundingClientRect(); return [b.left + 8, b.top + b.height / 2]; })()`);
  await hold("#mode-all", r);
  await page.waitFor(`${room}.dataset.modesAt === "left"`);
  const bar = await page.eval(`(() => { const b = document.querySelector(".board-modes").getBoundingClientRect(); return { w: b.width, h: b.height, left: b.left }; })()`);
  assert.ok(bar.h > bar.w && bar.left < 40, "upright on the left: " + JSON.stringify(bar));
  assert.equal(await page.eval(`${room}.dataset.railAt`), "right");
  // The tools are held and let go on the left half: they stand on the left, beside the bar; the long
  // press added nothing.
  await click(page, "#mode-all");
  const cards = await page.eval(`document.querySelectorAll(".card").length`);
  const mid = await page.eval(`(() => { const b = ${room}.getBoundingClientRect(); return [b.left + b.width * 0.3, b.top + b.height / 2]; })()`);
  await hold("#add-note", mid);
  await page.waitFor(`${room}.dataset.railAt === "left"`);
  const side = await page.eval(`(() => { const t = document.getElementById("board-rail").getBoundingClientRect(), m = document.querySelector(".board-modes").getBoundingClientRect(), b = ${room}.getBoundingClientRect(); return { left: t.left, barRight: m.right, mid: b.left + b.width / 2 }; })()`);
  assert.ok(side.left >= side.barRight - 1 && side.left < side.mid, "the tools stand on the left, past the bar: " + JSON.stringify(side));
  assert.equal(await page.eval(`document.querySelectorAll(".card").length`), cards, "the long press added no note");
  assert.ok(!(await page.eval(`!!document.querySelector(".scrim:not(.closing)")`)), "no sheet opened by the drop");
  assert.match(await page.eval(`document.querySelector(".board-hint")?.textContent || ""`), /왼쪽 아이콘으로/, "the hint names the side");
  await page.front();
  await page.shot(out("board-bar-left.png"));
  // Drawing: the bars step back while the pen is down.
  await click(page, "#board-pen");
  const p = await page.eval(`(() => { const b = document.getElementById("room-body").getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
  await page.stylus("down", p[0], p[1]);
  await page.stylus("move", p[0] + 30, p[1] + 10);
  assert.ok(await page.eval(`${room}.classList.contains("inking-now")`), "stepped back while drawing");
  await page.stylus("up", p[0] + 60, p[1] + 20);
  await page.waitFor(`!${room}.classList.contains("inking-now")`);
  // 처음대로.
  await click(page, "#board-pen");
  await hold(".board-modes button");
  await page.waitFor(q("#bar-reset"));
  await click(page, "#bar-reset");
  await page.waitFor(`${room}.dataset.modesAt === "top" && !!document.getElementById("mode-link") && document.querySelector(".board-modes button").id === "mode-all"`);
});

// The owner (17 November): "화이트보드에서 재생 노래 눌렀을때 재생이 안 되고 그 노래가 안 나와". A card that
// glows is not enough: the sound itself must be booked to start at once (a card's ▶, its menu's
// ▶ 듣기 and the toolbar's 전체 재생), as piano and as 원본.
scenario("whiteboard sound: ▶ on a card, ▶ 듣기 and 전체 재생 really start the sound within a moment, as piano and as 원본", async ({ open, fixtures }) => {
  const page = await open({ width: 600, height: 800 });
  await createBoard(page);
  await click(page, "#mode-song");
  await page.setFiles("#board-file", [fixtures.doremi]);
  await page.waitFor(`document.querySelectorAll(".card.song").length === 1`, 20000);
  await page.eval(`(() => {
    window.__starts = [];
    // A buffer source has its own start (an oscillator uses the shared one): watch both.
    for (const proto of [AudioBufferSourceNode.prototype, AudioScheduledSourceNode.prototype]) {
      const start = proto.start;
      proto.start = function (when = 0, ...rest) {
        window.__starts.push({ lead: when ? when - this.context.currentTime : 0, len: this.buffer ? this.buffer.duration : null, state: this.context.state });
        return start.call(this, when, ...rest);
      };
    }
    return true;
  })()`);
  const soundSoon = async (how) => {
    await page.waitFor(`window.__starts.some((s) => s.lead < 0.8 && s.state === "running")`, 4000).catch(() => {});
    const starts = await page.eval(`window.__starts`);
    assert.ok(starts.some((s) => s.lead < 0.8 && s.state === "running"), how + ": sound starts at once: " + JSON.stringify(starts.slice(0, 6)));
  };
  const stop = async () => {
    await page.eval(`(window.__starts = [], true)`);
  };
  await page.front();
  // The card's own ▶.
  await click(page, ".card.song .card-play");
  await soundSoon("the card's ▶ (piano)");
  await click(page, ".card.song .card-play");
  await stop();
  // 전체 재생.
  await click(page, "#board-play");
  await soundSoon("전체 재생 (piano)");
  await click(page, "#board-play");
  await stop();
  // The same as 원본 (the recording itself).
  await page.eval(`(() => { const s = window.__app.store; const v = s.get("settings", {}); s.set("settings", { ...v, songMode: "original" }); return true; })()`);
  await click(page, ".card.song .card-play");
  await soundSoon("the card's ▶ (원본)");
  const long = await page.eval(`window.__starts.some((s) => s.len > 2)`);
  assert.ok(long, "원본 plays the recording itself (a long buffer)");
  await click(page, ".card.song .card-play");
  await stop();
  // Where the device's file store never answers (some app views), ▶ still sounds at once: as
  // piano, and in 원본 too (a recording that is not ready yet plays as piano).
  await page.eval(`(() => { window.__app.blobs.memory.clear(); window.__app.blobs.get = () => new Promise(() => {}); return true; })()`);
  await page.eval(`(() => { const s = window.__app.store; const v = s.get("settings", {}); s.set("settings", { ...v, songMode: "piano" }); return true; })()`);
  await click(page, "#board-play");
  await soundSoon("전체 재생 with a file store that never answers (piano)");
  await click(page, "#board-play");
  await stop();
  await page.eval(`(() => { const s = window.__app.store; const v = s.get("settings", {}); s.set("settings", { ...v, songMode: "original" }); return true; })()`);
  await click(page, ".card.song .card-play");
  await soundSoon("the card's ▶ with a file store that never answers (원본 → piano)");
});

// The owner (17 November): "노래 잇기 막 그런 UI를 옮기는데 아래로 옮기면 아예 사라지는… 그래서 안 떠". Held
// and dragged down, the mode bar stands at the bottom in full view, over the tools and pressable;
// after a reload too; on a phone-sized screen too.
scenario("whiteboard bar at the bottom: dragged down it stays in view and pressable, above the tools, also after a reload and on a phone", async ({ open, out }) => {
  for (const size of [{ width: 700, height: 900 }, { width: 390, height: 760 }]) {
    const page = await open(size);
    await createBoard(page);
    const room = `document.querySelector(".room")`;
    const at = await page.eval(`(() => { const r = ${q("#mode-all")}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    const to = await page.eval(`(() => { const b = ${room}.getBoundingClientRect(); return [b.left + b.width / 2, b.bottom - 6]; })()`);
    await page.front();
    await page.touch("start", [at]);
    await pause(650);
    for (let i = 1; i <= 10; i++) await page.touch("move", [[at[0] + ((to[0] - at[0]) * i) / 10, at[1] + ((to[1] - at[1]) * i) / 10]]);
    await page.touch("end");
    await page.waitFor(`${room}.dataset.modesAt === "bottom"`);
    if (await page.eval(`!!document.querySelector(".scrim:not(.closing)")`)) {
      await page.key("Escape");
      await page.waitFor(`!document.querySelector(".scrim:not(.closing)")`, 2000);
    }
    const seen = async (when) => {
      const view = await page.eval(`(() => {
        const bar = document.querySelector(".board-modes");
        if (!bar) return { none: true };
        const r = bar.getBoundingClientRect();
        const s = getComputedStyle(bar);
        const buttons = [...bar.querySelectorAll("button")].map((b) => { const k = b.getBoundingClientRect(); const hit = document.elementFromPoint(k.left + k.width / 2, k.top + k.height / 2); return !!hit && b.contains(hit); });
        return { top: r.top, bottom: r.bottom, h: r.height, vh: innerHeight, hidden: bar.hidden, display: s.display, opacity: s.opacity, visibility: s.visibility, buttons };
      })()`);
      assert.ok(!view.none && !view.hidden && view.display !== "none" && view.visibility !== "hidden" && Number(view.opacity) > 0.5, when + ": the bar shows: " + JSON.stringify(view));
      assert.ok(view.h > 20 && view.top >= 0 && view.bottom <= view.vh, when + ": the bar is inside the screen: " + JSON.stringify(view));
      assert.ok(view.buttons.length >= 4 && view.buttons.every(Boolean), when + ": every mode can be pressed (nothing covers it): " + JSON.stringify(view));
    };
    await seen(`${size.width}: dropped at the bottom`);
    await click(page, "#mode-song");
    await page.waitFor(`${q("#mode-song")}.getAttribute("aria-pressed") === "true"`);
    await seen(`${size.width}: in 노래`);
    await page.reload();
    await page.waitFor(`${room} && ${room}.dataset.modesAt === "bottom" && ${q(".board-modes")}`, 8000);
    await seen(`${size.width}: after a reload`);
    await page.shot(out(`board-bar-bottom-${size.width}.png`));
  }
});

// The owner: brushes like Procreate, GoodNotes and Adobe (pressure, smoothing, taper, textures,
// shapes). Each brush shows a little line of itself; a 붓펜 line comes to a point; a stylus's
// pressure makes it thick and thin; a line held still a moment becomes a straight line or a circle
// (모양 잡기) and the friend sees exactly that; with 모양 잡기 off it stays as drawn.
scenario("brushes: each brush shows itself; 붓펜, 만년필 and 에어브러시 go to the friend as drawn; a stylus presses thick and thin; held still a line or a circle becomes exact (모양 잡기), and not when it is off", async ({ open, out }) => {
  const [a, b] = await together(open, ["나래"], { width: 430, height: 1300 });
  const box = await a.eval(`(() => { const r = ${TODAY}.querySelector(".paper").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  await click(a, "#pen");
  await a.waitFor(`!${q("#ink-tools")}.hidden`);
  const toolsTop = await a.eval(`${q("#ink-tools")}.getBoundingClientRect().top`);
  assert.ok(toolsTop > box.y + 860, "room to draw above the tools: " + toolsTop);
  // Every brush in the tools, each with a painted little line and its name.
  const shown = await a.eval(`[...document.querySelectorAll("#ink-tools .ink-brush")].map((b) => { const c = b.querySelector("canvas"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return [b.dataset.brush, b.textContent, n]; })`);
  assert.deepEqual(shown.map((s) => s[0]), ["pen", "fountain", "brushpen", "pencil", "sketch", "crayon", "marker", "airbrush", "highlighter"]);
  assert.deepEqual(shown.map((s) => s[1]), ["펜", "만년필", "붓펜", "연필", "스케치", "크레용", "마커", "에어브러시", "형광펜"]);
  assert.ok(shown.every((s) => s[2] > 40), "each little line is painted: " + JSON.stringify(shown));
  const day = await a.eval(`${TODAY}.dataset.day`);
  const strokes = (page) => page.eval(`window.__app.session.doc("k:${day}").strokes().map((s) => ({ b: s.b, s: s.s || null, q: s.q || 0, n: s.pts.length / 3, pts: s.pts }))`);
  const drag = async (path, holdMs = 0) => {
    await a.press(path[0][0], path[0][1]);
    for (const [x, y] of path.slice(1)) await a.moveTo(x, y);
    if (holdMs) await pause(holdMs);
    const [x, y] = path[path.length - 1];
    await a.release(x, y);
  };
  const across = (y, from = 0.15, to = 0.85, n = 12) => Array.from({ length: n + 1 }, (_, i) => [box.x + box.w * (from + ((to - from) * i) / n), y + Math.sin(i * 1.3) * 4]);
  // 붓펜.
  await click(a, '[data-brush="brushpen"]');
  await drag(across(box.y + 120));
  await a.waitFor(`window.__app.session.doc("k:${day}").strokes().length === 1`);
  // 만년필 and 에어브러시.
  await click(a, '[data-brush="fountain"]');
  await drag(across(box.y + 200));
  await click(a, '[data-brush="airbrush"]');
  await click(a, '[data-ink="violet"]');
  await drag(across(box.y + 280));
  await a.waitFor(`window.__app.session.doc("k:${day}").strokes().length === 3`);
  const three = await strokes(a);
  assert.deepEqual(three.map((s) => [s.b, s.s]), [["pen", "brushpen"], ["pen", "fountain"], ["highlighter", "airbrush"]], "new brushes go as a style beside a brush every device knows");
  await b.waitFor(`window.__app.session.doc("k:${day}").strokes().length === 3`);
  assert.deepEqual((await strokes(b)).map((s) => s.s), ["brushpen", "fountain", "airbrush"], "the friend has them as drawn");
  // A stylus: pressure rises and falls along the line, and is kept.
  await click(a, '[data-brush="pen"]');
  await click(a, '[data-ink="blue"]');
  const sy = box.y + 360;
  await a.front();
  await a.stylus("down", box.x + box.w * 0.15, sy, 0.15);
  for (let i = 1; i <= 12; i++) await a.stylus("move", box.x + box.w * (0.15 + 0.06 * i), sy, i <= 6 ? 0.15 + i * 0.13 : 0.93 - (i - 6) * 0.13);
  await a.stylus("up", box.x + box.w * 0.87, sy, 0.1);
  await a.waitFor(`window.__app.session.doc("k:${day}").strokes().length === 4`);
  const pressed = (await strokes(a))[3].pts.filter((_, i) => i % 3 === 2);
  assert.ok(Math.max(...pressed) - Math.min(...pressed) > 40, "the pen's pressure is kept: " + pressed.join(","));
  // 모양 잡기: a shaky line held still becomes a straight one.
  await click(a, '[data-brush="marker"]');
  const ly = box.y + 450;
  await drag(across(ly, 0.15, 0.85, 14).map(([x, y], i) => [x, y + (i % 2 ? 5 : -5)]), 900);
  await a.waitFor(`window.__app.session.doc("k:${day}").strokes().length === 5`);
  const straight = (await strokes(a))[4];
  assert.equal(straight.q, 1, "it became a shape");
  const lys = straight.pts.filter((_, i) => i % 3 === 1);
  assert.ok(Math.max(...lys) - Math.min(...lys) < 30, "and it is straight: " + lys.join(","));
  // A rough circle held still becomes a circle.
  const cx = box.x + box.w / 2;
  const cy = box.y + 600;
  const ring = Array.from({ length: 29 }, (_, i) => { const t = (i / 28) * Math.PI * 2; return [cx + Math.cos(t) * (90 + (i % 3) * 3), cy + Math.sin(t) * (90 - (i % 2) * 4)]; });
  await drag(ring, 900);
  await a.waitFor(`window.__app.session.doc("k:${day}").strokes().length === 6`);
  const round = (await strokes(a))[5];
  assert.equal(round.q, 1);
  await b.waitFor(`window.__app.session.doc("k:${day}").strokes().filter((s) => s.q === 1).length === 2`);
  // Quickly lifted, a line stays as drawn; and with 모양 잡기 off, holding changes nothing.
  await drag(across(box.y + 760, 0.2, 0.6, 8));
  await click(a, "#ink-shapes");
  assert.equal(await a.eval(`window.__app.store.get("settings", {}).inkShapes`), false);
  await drag(across(box.y + 800, 0.2, 0.8, 10), 900);
  await a.waitFor(`window.__app.session.doc("k:${day}").strokes().length === 8`);
  assert.deepEqual((await strokes(a)).slice(6).map((s) => s.q), [0, 0]);
  await a.front();
  await a.shot(out("brushes.png"));
});

// Every tool is in view on a 360-wide phone (the 형광펜 was cut off at the edge and could not be
// tapped). Nine brushes no longer fit in one row there: the brush row slides sideways, fades at its
// end to say so, and every brush can be brought into view and pressed; the rest stays in view.
scenario("brushes fit: on a 360-wide phone the 가리키기, the eraser, the colours, the widths, 모양 잡기 and 보정 are in view; all eleven brushes (채우기 and 문지르기 among them) can be reached and pressed", async ({ open, out }) => {
  const page = await open({ width: 360, height: 760 });
  await createRoom(page, { name: "가람" });
  await page.waitFor(TODAY);
  await click(page, "#pen");
  await page.waitFor(`!${q("#ink-tools")}.hidden`);
  const seen = await page.eval(`(() => {
    const out = [];
    for (const el of document.querySelectorAll("#ink-tools #ink-laser, #ink-tools #eraser, #ink-tools .ink-color, #ink-tools .ink-width, #ink-tools #ink-shapes, #ink-tools #ink-steady")) {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      out.push([el.dataset.ink || el.dataset.width || el.id, r.left >= 0 && r.right <= innerWidth && !!hit && el.contains(hit)]);
    }
    return out;
  })()`);
  assert.ok(seen.length === 1 + 1 + 8 + 3 + 2 && seen.every(([, ok]) => ok), "all in view and pressable: " + JSON.stringify(seen.filter(([, ok]) => !ok)));
  assert.equal(await page.eval(`document.querySelectorAll("#ink-tools .ink-brush").length`), 11);
  assert.ok(await page.eval(`${q("#ink-tools .ink-brushes")}.classList.contains("more")`), "the row says there is more");
  await page.shot(out("brushes-360.png"));
  for (const brush of ["highlighter", "crayon", "sketch", "pen"]) {
    await click(page, `[data-brush="${brush}"]`);
    assert.equal(await page.eval(`${q(`[data-brush="${brush}"]`)}.getAttribute("aria-pressed")`), "true", brush);
  }
});

// The owner (17 November): 별표 rooms at the top; ⋮ at the top right — a tap brings 찾기와 집 up, a
// throw toward an edge lights that edge in my colour and the panel comes out of it; search by
// 초성 and half-typed syllables (names that begin with it first, the rest hidden), and by what
// rooms hold; the last searches; 집 made with a colour, an icon and a name; a room held and
// dropped on a house goes in (and leaves home's list), and comes out again; leaving the app puts
// it all away.
scenario("home 찾기와 집: 별표 to the top; ⋮ opens it (thrown, from that edge, lit); 초성 search ranks and hides; 내용 search; recent searches; a house built; a room dropped into it and taken out; leaving the app puts it away", async ({ open, out }) => {
  const page = await open({ width: 390, height: 800 });
  const roomNames = ["쇼타로 일기", "산책 노트", "우리 쇼핑"];
  for (const room of roomNames) {
    await createRoom(page, { room });
    if (room === "쇼타로 일기") {
      await focusEnd(page);
      await page.type("오늘은 바다에 갔다");
      await page.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text().includes("바다")`);
    }
    await click(page, "#back");
    await page.waitFor(q("#home"));
  }
  const dailyNames = () => page.eval(`[...document.querySelectorAll('.half[data-side="daily"] .rooms .room-name')].map((e) => e.textContent)`);
  assert.deepEqual(await dailyNames(), ["우리 쇼핑", "산책 노트", "쇼타로 일기"], "newest first");
  // 별표: the oldest goes to the top, and stays there.
  const id = await page.eval(`window.__app.store.get("rooms", []).find((r) => r.name === "쇼타로 일기").id`);
  await click(page, `[data-star="${id}"]`);
  await page.waitFor(`document.querySelector('.half[data-side="daily"] .rooms .room-name')?.textContent === "쇼타로 일기"`);
  assert.equal(await page.eval(`${q(`[data-star="${id}"]`)}.getAttribute("aria-pressed")`), "true");
  // ⋮ tapped: from the bottom, the bottom edge lit.
  await click(page, "#home-more");
  await page.waitFor(`!!document.querySelector(".edge-glow[data-edge='bottom']")`, 1500);
  await page.waitFor(`${q("#home-panel")}?.dataset.edge === "bottom"`);
  const hits = () => page.eval(`[...document.querySelectorAll("#search-results .search-hit .hit-name")].map((e) => e.textContent)`);
  await fill(page, "#home-search", "ㅅ");
  await page.waitFor(`document.querySelectorAll("#search-results .search-hit").length === 3`);
  const first = await hits();
  assert.deepEqual(first.slice(0, 2).sort(), ["산책 노트", "쇼타로 일기"].sort(), "those that begin with ㅅ first: " + first);
  assert.equal(first[2], "우리 쇼핑", "then where it comes later");
  await fill(page, "#home-search", "쇼");
  await page.waitFor(`document.querySelectorAll("#search-results .search-hit").length === 2`);
  assert.deepEqual(await hits(), ["쇼타로 일기", "우리 쇼핑"]);
  assert.equal(await page.eval(`${q("#search-results mark")}.textContent`), "쇼");
  // 내용: what the room holds.
  await click(page, "#search-by-words");
  await fill(page, "#home-search", "바다");
  await page.waitFor(`document.querySelectorAll("#search-results .search-hit").length === 1`);
  assert.equal(await page.eval(`${q("#search-results .hit-words mark")}.textContent`), "바다");
  await page.shot(out("home-search.png"));
  // Closed with a search in it, it is remembered; open again, it is there to tap.
  await page.key("Escape");
  await page.waitFor(`!document.getElementById("home-panel")`, 2000);
  await click(page, "#home-more");
  await page.waitFor(q("#recent-searches"));
  assert.ok((await text(page, "#recent-searches")).includes("바다"));
  // 집 짓기.
  await click(page, "#house-new");
  await fill(page, "#house-name", "우리 가족");
  await click(page, '[data-color="green"]');
  await click(page, '[data-icon="heart"]');
  await click(page, "#house-save");
  await page.waitFor(`${q(".house-head-name")}?.textContent === "우리 가족" && ${q("#house-empty")}`);
  await page.key("Escape");
  await page.waitFor(`!document.getElementById("home-panel")`, 2000);
  // A room held and dropped on the house.
  const at = await page.eval(`(() => { const row = [...document.querySelectorAll(".room-row")].find((r) => r.querySelector(".room-name").textContent === "산책 노트"); const b = row.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
  await page.front();
  await page.touch("start", [at]);
  await pause(700);
  await page.waitFor(q("#house-dock .dock-house:not(.dock-new)"));
  const target = await page.eval(`(() => { const b = document.querySelector("#house-dock .dock-house:not(.dock-new)").getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
  for (let i = 1; i <= 12; i++) await page.touch("move", [[at[0] + ((target[0] - at[0]) * i) / 12, at[1] + ((target[1] - at[1]) * i) / 12]]);
  await page.waitFor(q("#house-dock .dock-house.over"));
  await page.touch("end");
  await page.waitFor(`!document.getElementById("house-dock") && ${q("#in-houses-daily")}`, 3000);
  assert.ok(!(await dailyNames()).includes("산책 노트"), "it left home's list");
  assert.match(await text(page, "#in-houses-daily"), /집에 둔 방 1개/);
  // In the house, and out again.
  await click(page, "#in-houses-daily");
  await page.waitFor(q(".house-tile[data-house]"));
  await click(page, ".house-tile[data-house]");
  await page.waitFor(`${q("#house-rooms")}?.textContent.includes("산책 노트")`);
  await page.shot(out("home-house.png"));
  await click(page, "#house-rooms [data-take-out]");
  await page.waitFor(q("#house-empty"));
  await page.key("Escape");
  await page.waitFor(`!document.getElementById("home-panel")`, 2000);
  assert.ok((await dailyNames()).includes("산책 노트"), "back on home");
  // Thrown to the left: the left edge lights, the panel comes from the left.
  const k = await page.eval(`(() => { const b = document.getElementById("home-more").getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
  await page.touch("start", [k]);
  for (let i = 1; i <= 4; i++) await page.touch("move", [[k[0] - i * 40, k[1] + i * 6]]);
  await page.touch("end");
  await page.waitFor(`!!document.querySelector(".edge-glow[data-edge='left']")`, 1500);
  await page.waitFor(`${q("#home-panel")}?.dataset.edge === "left"`);
  await page.shot(out("home-thrown-left.png"));
  // Leaving the app and coming back: put away.
  await page.eval(`(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); delete document.visibilityState; return true; })()`);
  await page.waitFor(`!document.getElementById("home-panel")`, 2000);
});

// The round buttons at home's top right (설정, 레퍼런스, ⋮, 떠 있는 찾기와 집) never lie over 창작's title,
// which stays on one line, on a 390 and a 360 wide phone. The owner (20 November): ⋮ and 레퍼런스
// swap; then "위에 또 아이콘 하나 붙여서 … 오른쪽에는 독단적으로 나오게 하는 거, 그리고 왼쪽에는 그 원래".
scenario("home top: 설정 and 레퍼런스 side by side; under them ⋮ and on its right the floating 찾기와 집; clear of 창작's one-line title, at 390 and 360 wide", async ({ open, out }) => {
  for (const width of [390, 360]) {
    const page = await open({ width, height: 760 });
    await page.waitFor(q("#home-more"));
    const box = await page.eval(`(() => {
      const t = document.querySelector('.half[data-side="creative"] .half-title');
      const r = document.createRange(); r.selectNodeContents(t);
      const words = r.getBoundingClientRect();
      const top = document.querySelector(".home-top").getBoundingClientRect();
      return { right: words.right, lines: r.getClientRects().length, buttons: top.left, h: words.height, lh: parseFloat(getComputedStyle(t).lineHeight) };
    })()`);
    assert.ok(box.right <= box.buttons, width + ": the title ends before the buttons: " + JSON.stringify(box));
    assert.ok(box.h < box.lh * 1.5, width + ": one line: " + JSON.stringify(box));
    // 설정 and 레퍼런스 side by side; under them ⋮ (left) and the floating one (right); none over another, each pressable.
    const at = await page.eval(`(() => {
      const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return { l: b.left, r: b.right, t: b.top, b: b.bottom, cx: b.left + b.width / 2, ok: !!hit && document.getElementById(id).contains(hit) }; };
      return { set: r("home-settings"), more: r("home-more"), ref: r("home-reference"), float: r("home-float") };
    })()`);
    assert.ok(Math.abs(at.set.t - at.ref.t) < 1 && at.set.r <= at.ref.l + 0.5, width + ": 설정 then 레퍼런스 in a row: " + JSON.stringify(at));
    assert.ok(Math.abs(at.more.t - at.float.t) < 1 && at.more.r <= at.float.l + 0.5, width + ": ⋮ then the floating one in a row: " + JSON.stringify(at));
    assert.ok(at.more.t >= at.ref.b - 0.5 && Math.abs(at.set.cx - at.more.cx) < 1 && Math.abs(at.ref.cx - at.float.cx) < 1, width + ": that row under the first: " + JSON.stringify(at));
    assert.ok(at.set.ok && at.more.ok && at.ref.ok && at.float.ok, width + ": each can be pressed: " + JSON.stringify(at));
    await page.shot(out(`home-top-${width}.png`));
  }
});

// The owner: "자기의 ui색유리의 색… 가라데이션 되어있는부분의 끝부분부터 색깔을 줄이면서. 원본 버전이있고…
// 눈안아프게끔. 검정 부분을 더 늘리고싶다거나… 다시 늘릴 수 있고". 색 세기: less of my glass colour in the
// glass and the sky at the corners — more white in 밝게, more black in 어둡게 — and 원래대로 brings it back.
scenario("색 세기: the slider takes my glass colour out of the glass and the corners (white in 밝게, black in 어둡게), 원래대로 puts it back, and it is remembered", async ({ open, out }) => {
  const page = await open({ width: 390, height: 820 });
  await page.waitFor(q("#home-settings"));
  // The corners' colour as plain rgb (a mixed colour reads as "color(srgb …)").
  const skyColour = () => page.eval(`(() => { const el = document.createElement("div"); el.style.color = "var(--sky)"; document.body.append(el); const c = getComputedStyle(el).color; el.remove();
    const m = c.match(/color\\(srgb ([\\d.]+) ([\\d.]+) ([\\d.]+)/); return m ? "rgb(" + [m[1], m[2], m[3]].map((v) => Math.round(v * 255)).join(", ") + ")" : c; })()`);
  const tinted = await skyColour();
  await click(page, "#home-settings");
  await page.waitFor(q("#tint-amount"));
  assert.equal(await page.eval(`${q("#tint-amount")}.value`), "100", "as it was made at first");
  assert.ok(await page.eval(`${q("#tint-amount-back")}.hidden`), "nothing to put back yet");
  // A tap at the far left of the slider: no colour.
  await page.eval(`(${q("#tint-amount")}.scrollIntoView({ block: "center" }), true)`);
  await pause(300);
  const at = await page.eval(`(() => { const r = ${q("#tint-amount")}.getBoundingClientRect(); return [r.left + 2, r.top + r.height / 2]; })()`);
  await page.tap(at[0], at[1]);
  await page.waitFor(`${q("#tint-amount")}.value === "0" && ${q("#tint-amount-text")}.textContent === "0%"`);
  const light = await skyColour();
  assert.notEqual(light, tinted, "the corners lost their colour");
  assert.equal(light, "rgb(255, 255, 255)", "white in 밝게");
  await page.eval(`(document.documentElement.dataset.theme = "dark", true)`);
  assert.equal(await skyColour(), "rgb(0, 0, 0)", "black in 어둡게");
  await page.shot(out("tint-amount-dark.png"));
  await page.eval(`(document.documentElement.dataset.theme = "light", true)`);
  // Remembered.
  assert.equal(await page.eval(`window.__app.store.get("settings", {}).tintAmount`), 0);
  // 원래대로.
  await click(page, "#tint-amount-back");
  await page.waitFor(`${q("#tint-amount")}.value === "100" && ${q("#tint-amount-back")}.hidden`);
  assert.equal(await skyColour(), tinted, "the colour is back");
});

// The owner (17 November): "밝기를 어둡게 모드하고 밝게 모드를 해도 레퍼런스는 지금 안 바뀌거든".
scenario("레퍼런스 follows 밝게/어둡게: switched while it is open, its glass, words and cards turn with the app", async ({ open, out }) => {
  const page = await open({ width: 390, height: 800 });
  await page.waitFor(q("#home-record"));
  await click(page, "#home-record");
  await page.waitFor(`document.querySelectorAll("#reference .ref-sound").length >= 1`, 15000);
  const colours = () => page.eval(`(() => {
    const lum = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
    const panel = document.getElementById("reference");
    const card = panel.querySelector(".ref-sound");
    const title = panel.querySelector(".float-title");
    // What the panel shows: the colour under its middle, read from a picture of the screen is not possible here;
    // its words' colour and the cards' colour tell which way it turned.
    return { title: lum(getComputedStyle(title).color), cardBg: getComputedStyle(card).backgroundColor, card: lum(getComputedStyle(card).backgroundColor.startsWith("rgba(0, 0, 0, 0)") ? "rgb(0,0,0)" : getComputedStyle(card).backgroundColor), name: lum(getComputedStyle(card.querySelector(".pick-name")).color) };
  })()`);
  await page.eval(`(document.documentElement.dataset.theme = "light", true)`);
  const light = await colours();
  await page.shot(out("ref-light.png"));
  await page.eval(`(document.documentElement.dataset.theme = "dark", true)`);
  await pause(200);
  const dark = await colours();
  await page.shot(out("ref-dark.png"));
  assert.ok(light.title < 0.3 && dark.title > 0.7, "the title's words turn light: " + JSON.stringify([light, dark]));
  assert.ok(light.name < 0.3 && dark.name > 0.7, "the cards' words turn light: " + JSON.stringify([light, dark]));
});

// The owner (19 November): "브라우저나 사파리에 들어가 있을 때 이 앱에서 꾹 누르면 이 앱이 텍스트처럼
// 선택되고 파란색이 뜨는 거를 없애줘". Nothing but what one writes in is picked up as text: titles,
// buttons, rows, 찾기와 집, toasts; the writing layer and form fields still select.
scenario("no text selection: titles, buttons, rows, 찾기와 집 and the dock are never selected like text; what one writes in still is", async ({ open }) => {
  const page = await open({ width: 390, height: 800 });
  await createRoom(page, { room: "선택 없는 방" });
  await focusEnd(page);
  await page.type("안녕 하세요");
  await page.waitFor(`window.__app.session.sheet(${TODAY}.dataset.day).text().includes("하세요")`);
  // The writing layer still takes text and its selection (the room's own 선택 도구 reads it).
  assert.equal(await page.eval(`(() => { const t = ${TODAY}.querySelector("textarea"); return getComputedStyle(t).webkitUserSelect || getComputedStyle(t).userSelect; })()`), "text");
  await click(page, "#back");
  await page.waitFor(q("#home"));
  const nothing = async (what, sel) => {
    await page.eval(`(getSelection().removeAllRanges(), true)`);
    const at = await page.eval(`(() => { const r = ${q(sel)}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await page.dblTap(at[0], at[1]);
    await pause(120);
    const picked = await page.eval(`getSelection().toString()`);
    assert.equal(picked, "", what + " is not selected like text");
  };
  // Words that are not buttons: a double tap picks nothing.
  await nothing("home's title", '.half[data-side="daily"] .half-title');
  await nothing("home's note", '.half[data-side="creative"] .half-note');
  await click(page, "#home-more");
  await page.waitFor(q("#home-panel .houses-title"));
  await nothing("찾기와 집's 집", "#home-panel .houses-title");
  await nothing("찾기와 집's help", "#home-panel .houses .help");
  // Buttons and the rest of the page take no selection either (a long press in Safari picks them up otherwise).
  const style = await page.eval(`(() => {
    const s = (el) => getComputedStyle(el).webkitUserSelect || getComputedStyle(el).userSelect;
    const out = {};
    for (const [k, sel] of Object.entries({ body: "body", row: ".room-row", rec: "#home-record", code: "#by-code", more: "#home-more", panel: "#home-panel", tile: "#house-new", field: "#home-search" })) out[k] = s(document.querySelector(sel));
    return out;
  })()`);
  assert.equal(style.field, "text", "the search field still takes text");
  for (const k of ["body", "row", "rec", "code", "more", "panel", "tile"]) assert.equal(style[k], "none", k + " takes no selection: " + JSON.stringify(style));
});

// The owner (19 November): the bar stays where it is let go along its edge ("끝부분에서 그 끝부분 위치도…
// 꾹 눌러서 옮기면 거기에"), and so do each mode's small tools, on any edge.
scenario("whiteboard bar and tools stay where they are let go: the bar low on the left edge, the tools along the bottom near the left; after a reload too; everything still pressable", async ({ open, out }) => {
  const page = await open({ width: 420, height: 860 });
  await createBoard(page);
  const room = `document.querySelector(".room")`;
  const drag = async (sel, to) => {
    const at = await page.eval(`(() => { const r = ${q(sel)}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await page.front();
    await page.touch("start", [at]);
    await pause(600);
    for (let i = 1; i <= 12; i++) await page.touch("move", [[at[0] + ((to[0] - at[0]) * i) / 12, at[1] + ((to[1] - at[1]) * i) / 12]]);
    await page.touch("end");
  };
  const body = await page.eval(`(() => { const b = document.querySelector(".board-body, .room-body, #board-body")?.getBoundingClientRect() || document.querySelector(".room").getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; })()`);
  // The bar, to the left edge, two thirds down.
  const barTo = [8, body.t + body.h * 0.66];
  await drag("#mode-all", barTo);
  await page.waitFor(`${room}.dataset.modesAt === "left"`);
  await pause(300);
  const bar = async () => page.eval(`(() => { const b = document.querySelector(".board-modes").getBoundingClientRect(); return { cy: b.top + b.height / 2, l: b.left, w: b.width, h: b.height }; })()`);
  let b = await bar();
  assert.ok(Math.abs(b.cy - barTo[1]) < 60 || b.cy > body.t + body.h * 0.45, "the bar stands low on the left, where it was let go: " + JSON.stringify([b, barTo]));
  // The tools, to the bottom edge near the left.
  const toolsTo = [body.l + body.w * 0.25, body.t + body.h - 6];
  await drag("#board-rail .rail-btn", toolsTo);
  await page.waitFor(`${room}.dataset.railAt === "bottom"`);
  await pause(300);
  const rail = async () => page.eval(`(() => { const r = document.getElementById("board-rail").getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; })()`);
  let t = await rail();
  assert.ok(t.w > t.h, "the tools lie in a row along the bottom: " + JSON.stringify(t));
  assert.ok(t.l < body.l + body.w * 0.5, "near the left, where they were let go: " + JSON.stringify([t, toolsTo]));
  const pressable = async () => page.eval(`[...document.querySelectorAll("#board-rail .rail-btn, .board-modes button")].every((el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.width > 0 && !!hit && el.contains(hit); })`);
  assert.ok(await pressable(), "every tool and mode can be pressed");
  await page.shot(out("board-placed.png"));
  // After a reload they are where they were.
  await page.reload();
  await page.waitFor(`${room} && ${room}.dataset.railAt === "bottom" && ${room}.dataset.modesAt === "left"`, 8000);
  await pause(400);
  const b2 = await bar();
  const t2 = await rail();
  assert.ok(Math.abs(b2.cy - b.cy) < 4 && Math.abs(t2.l - t.l) < 4, "the same places after a reload: " + JSON.stringify([b, b2, t, t2]));
  assert.ok(await pressable());
});

// The owner: "그림 방도 만들고… 실시간으로 같이 그림 그리는 거", "레이어". One page drawn on together: what
// one draws, the friend sees; layers are added, chosen, hidden, made see-through and blended, for both.
scenario("그림 방: two friends draw on one page; a new layer drawn on, hidden and made see-through shows the same for both; undo takes a layer away", async ({ open, out }) => {
  const a = await open({ dev: "a", width: 420, height: 860 });
  await click(a, "#add-creative");
  await click(a, '[data-kind="creative-draw"]');
  await fill(a, "#room-name", "같이 그림");
  await fill(a, "#my-name", "가람");
  await click(a, "#create-room");
  await a.waitFor(`location.hash.startsWith("#r-") && ${q("#invite-done")}`);
  await click(a, "#invite-done");
  await a.waitFor(`${q("#draw-page")} && window.__app.session.doc("draw").layers().length === 1`);
  const id = await a.eval("location.hash.slice(3)");
  const b = await open({ dev: "b", hash: "r-" + id, width: 420, height: 860 });
  await joinNew(b, { name: "나래" });
  await b.waitFor(`${q("#draw-page")} && window.__app.session.doc("draw").layers().length === 1`);
  const pageBox = async (page) => page.eval(`(() => { const r = document.getElementById("draw-page").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const line = async (page, y) => {
    const p = await pageBox(page);
    await page.press(p.x + p.w * 0.2, p.y + p.h * y);
    for (let i = 1; i <= 8; i++) await page.moveTo(p.x + p.w * (0.2 + 0.07 * i), p.y + p.h * y + Math.sin(i) * 6);
    await page.release(p.x + p.w * 0.76, p.y + p.h * y);
  };
  const strokesOn = (page, n) => page.eval(`(() => { const l = window.__app.session.doc("draw").layers()[${n}]; return l ? window.__app.session.doc("k:L" + l.id).strokes().length : -1; })()`);
  await line(a, 0.3);
  await a.waitFor(`(() => { const l = window.__app.session.doc("draw").layers()[0]; return window.__app.session.doc("k:L" + l.id).strokes().length === 1; })()`);
  await b.waitFor(`(() => { const l = window.__app.session.doc("draw").layers()[0]; return l && window.__app.session.doc("k:L" + l.id).strokes().length === 1; })()`, 4000);
  // A second layer, drawn on.
  await a.front();
  await click(a, "#draw-layers");
  await a.waitFor(q("#layer-add"));
  await click(a, "#layer-add");
  await a.waitFor(`window.__app.session.doc("draw").layers().length === 2`);
  // The panel covers part of the page: a tap on the page only puts it away and draws nothing.
  {
    const p = await pageBox(a);
    await a.tap(p.x + p.w * 0.12, p.y + p.h * 0.85);
    await a.waitFor(`document.getElementById("layers-panel").hidden`);
    await pause(150);
    assert.equal(await strokesOn(a, 1), 0, "the tap that put the panel away drew nothing");
  }
  await line(a, 0.6);
  await a.waitFor(`(() => { const ls = window.__app.session.doc("draw").layers(); return window.__app.session.doc("k:L" + ls[1].id).strokes().length === 1; })()`);
  assert.equal(await strokesOn(a, 0), 1, "the first layer keeps its line");
  // See-through, multiplied, hidden: the friend's page shows the same.
  await click(a, "#draw-layers");
  await a.waitFor(q("#layer-opacity"));
  {
    const r = await a.eval(`(() => { const b = document.getElementById("layer-opacity").getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width }; })()`);
    await a.tap(r.x + r.w * 0.4, r.y);
  }
  await a.waitFor(`(() => { const top = window.__app.session.doc("draw").layers()[1]; return top.opacity > 0.3 && top.opacity < 0.5; })()`);
  const seeThrough = await a.eval(`window.__app.session.doc("draw").layers()[1].opacity`);
  await a.eval(`(() => { const s = document.getElementById("layer-blend"); s.value = "multiply"; s.dispatchEvent(new Event("change")); return true; })()`);
  await b.waitFor(`(() => { const top = window.__app.session.doc("draw").layers()[1]; if (!top) return false; const el = document.querySelector('.draw-layer[data-layer="' + top.id + '"]'); return el && el.style.opacity === String(${seeThrough}) && el.style.mixBlendMode === "multiply"; })()`, 4000);
  await a.shot(out("draw-room.png"));
  const top = await a.eval(`window.__app.session.doc("draw").layers()[1].id`);
  await click(a, `[data-eye="${top}"]`);
  await b.waitFor(`document.querySelector('.draw-layer[data-layer="${top}"]')?.hidden === true`, 4000);
  // Undo: the eye, the blend, the opacity, the line, then the layer itself; the first line stays.
  for (let i = 0; i < 4; i++) await click(a, "#draw-undo");
  await b.waitFor(`(() => { const ls = window.__app.session.doc("draw").layers(); return ls.length === 2 && ls[1].visible && ls[1].opacity === 1 && ls[1].mode === "source-over" && window.__app.session.doc("k:L" + ls[1].id).strokes().length === 0; })()`, 4000);
  await click(a, "#draw-undo");
  await b.waitFor(`window.__app.session.doc("draw").layers().length === 1`, 4000);
  assert.equal(await strokesOn(b, 0), 1, "the first layer's line stays");
});

// The owner: "실시간으로 같이 그림 그리는 거". As in Excalidraw and Figma, a friend's line shows while
// it is being drawn (with their pen and name), not only after the hand lifts; 가리키기 (GoodNotes'
// and Excalidraw's laser) lights the friend's screen and fades, leaving nothing; 손떨림 보정 (lazy-brush)
// steps through 약·중·강·끔 and is remembered.
scenario("같이 그리기: a friend's line shows while it is drawn, with their name at the pen; 가리키기 lights the friend's screen and fades, keeping nothing; 보정 steps 약·중·강·끔", async ({ open, out }) => {
  const a = await open({ dev: "a", width: 420, height: 860 });
  await click(a, "#add-creative");
  await click(a, '[data-kind="creative-draw"]');
  await fill(a, "#room-name", "실시간 그림");
  await fill(a, "#my-name", "가람");
  await click(a, "#create-room");
  await a.waitFor(`location.hash.startsWith("#r-") && ${q("#invite-done")}`);
  await click(a, "#invite-done");
  await a.waitFor(`${q("#draw-page")} && window.__app.session.doc("draw").layers().length === 1`);
  const id = await a.eval("location.hash.slice(3)");
  const b = await open({ dev: "b", hash: "r-" + id, width: 420, height: 860 });
  await joinNew(b, { name: "나래" });
  await b.waitFor(`${q("#draw-page")} && window.__app.session.doc("draw").layers().length === 1`);
  const doc = await a.eval(`"k:L" + window.__app.session.doc("draw").layers()[0].id`);
  const box = await a.eval(`(() => { const r = document.getElementById("draw-page").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy];
  // Drawing, the hand still down: the friend already sees the line, with the drawer's name.
  await a.press(...at(0.2, 0.3));
  for (let i = 1; i <= 10; i++) await a.moveTo(...at(0.2 + 0.05 * i, 0.3 + Math.sin(i / 2) * 0.03));
  await b.waitFor(`(() => { const lines = window.__app.session.liveInk?.linesOn(${JSON.stringify(doc)}) || []; return lines.length === 1 && lines[0].pts.length >= 6 * 3 && lines[0].name === "가람" && lines[0].live; })()`, 5000);
  assert.equal(await b.eval(`window.__app.session.doc(${JSON.stringify(doc)}).strokes().length`), 0, "nothing is kept before the hand lifts");
  await b.front();
  await pause(200);
  await b.shot(out("live-line.png"));
  await a.front();
  await a.release(...at(0.72, 0.3));
  // Lifted: the stroke comes as an op and the live line gives way to it.
  await b.waitFor(`window.__app.session.doc(${JSON.stringify(doc)}).strokes().length === 1 && (window.__app.session.liveInk?.linesOn(${JSON.stringify(doc)}) || []).length === 0`, 5000);
  // 가리키기: a light on the friend's screen that fades; no stroke is made.
  await click(a, "#ink-laser");
  assert.equal(await a.eval(`${q("#ink-laser")}.getAttribute("aria-pressed")`), "true");
  await a.press(...at(0.3, 0.6));
  for (let i = 1; i <= 8; i++) await a.moveTo(...at(0.3 + 0.04 * i, 0.6 - 0.02 * i));
  await b.waitFor(`(() => { const lights = window.__app.session.liveInk?.lightsOn(${JSON.stringify(doc)}) || []; return lights.length === 1 && lights[0].pts.length >= 5 * 3; })()`, 5000);
  await b.front();
  await pause(120);
  await b.shot(out("live-pointer.png"));
  await a.front();
  await a.release(...at(0.62, 0.44));
  await b.waitFor(`(window.__app.session.liveInk?.lightsOn(${JSON.stringify(doc)}) || []).length === 0`, 6000);
  assert.equal(await a.eval(`window.__app.session.doc(${JSON.stringify(doc)}).strokes().length`), 1, "the light kept nothing");
  // 손떨림 보정: 약 → 중 → 강 → 끔 → 약, remembered on this device.
  await click(a, "#ink-laser");
  const steady = () => a.eval(`${q("#ink-steady")}.textContent`);
  assert.equal(await steady(), "보정 약");
  for (const next of ["보정 중", "보정 강", "보정 끔", "보정 약"]) {
    await click(a, "#ink-steady");
    assert.equal(await steady(), next);
  }
  assert.equal(await a.eval(`window.__app.store.get("settings", {}).inkSteady`), 1);
});

// From the reference study (Procreate's gestures, 하던 대로): two fingers tapped together 되돌리기,
// three 다시하기, each saying so for a moment; a finger held still where it lands picks the colour
// under it (스포이트) with a loupe above the finger, and draws nothing.
scenario("drawing gestures: a two-finger tap undoes and a three-finger tap redoes, saying so; a finger held still picks the colour under it (스포이트) and draws nothing", async ({ open, out }) => {
  const a = await open({ dev: "a", width: 420, height: 860 });
  await click(a, "#add-creative");
  await click(a, '[data-kind="creative-draw"]');
  await fill(a, "#room-name", "몸짓 그림");
  await fill(a, "#my-name", "가람");
  await click(a, "#create-room");
  await a.waitFor(`location.hash.startsWith("#r-") && ${q("#invite-done")}`);
  await click(a, "#invite-done");
  await a.waitFor(`${q("#draw-page")} && window.__app.session.doc("draw").layers().length === 1`);
  const doc = await a.eval(`"k:L" + window.__app.session.doc("draw").layers()[0].id`);
  const count = () => a.eval(`window.__app.session.doc(${JSON.stringify(doc)}).strokes().length`);
  const box = await a.eval(`(() => { const r = document.getElementById("draw-page").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy];
  const line = async (fy) => {
    await a.front();
    await a.touch("start", [at(0.2, fy)]);
    for (let i = 1; i <= 10; i++) await a.touch("move", [at(0.2 + 0.05 * i, fy)]);
    await a.touch("end");
  };
  await click(a, '[data-ink="red"]');
  await click(a, "#ink-steady"); await click(a, "#ink-steady"); await click(a, "#ink-steady"); // 끔: the line goes exactly where the finger went
  await line(0.3);
  await click(a, '[data-ink="blue"]');
  await line(0.5);
  await a.waitFor(`window.__app.session.doc(${JSON.stringify(doc)}).strokes().length === 2`);
  // Two fingers tapped: 되돌리기.
  await a.front();
  await a.touch("start", [at(0.4, 0.7), at(0.6, 0.72)]);
  await pause(60);
  await a.touch("end");
  await a.waitFor(`window.__app.session.doc(${JSON.stringify(doc)}).strokes().length === 1`);
  await a.waitFor(`document.getElementById("gesture-hint")?.textContent === "되돌리기"`, 1500);
  // Three fingers tapped: 다시하기.
  await pause(950);
  await a.touch("start", [at(0.3, 0.7), at(0.5, 0.72), at(0.7, 0.7)]);
  await pause(60);
  await a.touch("end");
  await a.waitFor(`window.__app.session.doc(${JSON.stringify(doc)}).strokes().length === 2`);
  await a.waitFor(`document.getElementById("gesture-hint")?.textContent === "다시하기"`, 1500);
  // 스포이트: held still on the red line, the loupe shows; lifted, red is the pen's colour; no dot was drawn.
  await click(a, '[data-ink="black"]');
  const red = await a.eval(`(() => { const r = document.getElementById("draw-page").getBoundingClientRect(); return [r.left + r.width * 0.45, r.top + r.height * 0.3]; })()`);
  await a.front();
  await a.touch("start", [red]);
  await pause(650);
  await a.waitFor(q(".loupe"), 1500);
  await a.shot(out("eyedropper.png"));
  await a.touch("end");
  await a.waitFor(`!document.querySelector(".loupe") && ${q("#ink-picked")}`, 2000);
  const picked = await a.eval(`getComputedStyle(${q("#ink-picked")}).backgroundColor`);
  const [r, g, b] = picked.match(/\d+/g).map(Number);
  assert.ok(r > 180 && g < 120 && b < 120, "the red was picked: " + picked);
  assert.equal(await a.eval(`${q("#ink-picked")}.getAttribute("aria-pressed")`), "true");
  assert.equal(await count(), 2, "holding still drew nothing");
  // Two fingers that move are a zoom, not a tap: nothing is undone.
  await a.touch("start", [at(0.4, 0.7), at(0.6, 0.72)]);
  for (let i = 1; i <= 6; i++) await a.touch("move", [at(0.4 - 0.02 * i, 0.7), at(0.6 + 0.02 * i, 0.72)]);
  await a.touch("end");
  await pause(200);
  assert.equal(await count(), 2, "a pinch undoes nothing");
});

// Every brush on one page, as the owner will see them (a picture to look at), each kept with its
// own brush: 펜, 만년필, 붓펜, 연필 (Klecks' chalk), 스케치 (Klecks), 크레용 (Easy-Brush), 마커, 에어브러시, 형광펜.
// 채우기 (the brush table's paint bucket, as Klecks fills): a tap inside a drawn shape fills it in the
// chosen colour up to its line (and a pixel under the line's soft edge), outside stays as it was; it
// is one shape, the same on the friend's screen; 되돌리기 takes it away.
scenario("채우기: a tap inside a drawn square fills it up to the line in the chosen colour, outside stays clear; the friend sees the same; undo takes it away", async ({ open, out }) => {
  const a = await open({ dev: "a", width: 420, height: 860 });
  await click(a, "#add-creative");
  await click(a, '[data-kind="creative-draw"]');
  await fill(a, "#room-name", "색칠");
  await fill(a, "#my-name", "가람");
  await click(a, "#create-room");
  await a.waitFor(`location.hash.startsWith("#r-") && ${q("#invite-done")}`);
  await click(a, "#invite-done");
  await a.waitFor(`${q("#draw-page")} && window.__app.session.doc("draw").layers().length === 1`);
  const id = await a.eval("location.hash.slice(3)");
  const b = await open({ dev: "b", hash: "r-" + id, width: 420, height: 860 });
  await joinNew(b, { name: "나래" });
  await b.waitFor(`${q("#draw-page")} && window.__app.session.doc("draw").layers().length === 1`);
  const layerDoc = `("k:L" + window.__app.session.doc("draw").layers()[0].id)`;
  const strokes = (page) => page.eval(`window.__app.session.doc(${layerDoc}).strokes().map((s) => s.s || s.b)`);
  await a.front();
  const box = await a.eval(`(() => { const r = document.getElementById("draw-page").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  // A closed square with the pen (모양 잡기 makes it exact).
  const sq = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.6], [0.3, 0.6], [0.3, 0.3]].map(([u, v]) => [box.x + box.w * u, box.y + box.h * v]);
  await a.press(sq[0][0], sq[0][1]);
  for (let i = 1; i < sq.length; i++) for (let k = 1; k <= 6; k++) await a.moveTo(sq[i - 1][0] + ((sq[i][0] - sq[i - 1][0]) * k) / 6, sq[i - 1][1] + ((sq[i][1] - sq[i - 1][1]) * k) / 6);
  await a.release(sq[4][0], sq[4][1]);
  await a.waitFor(`window.__app.session.doc(${layerDoc}).strokes().length === 1`);
  // 채우기 in red, a tap in the middle.
  await click(a, '[data-brush="fill"]');
  await click(a, '[data-ink="red"]');
  await click(a, '[data-brush="fill"]');
  const mid = [box.x + box.w * 0.5, box.y + box.h * 0.45];
  await a.tap(mid[0], mid[1]);
  await a.waitFor(`window.__app.session.doc(${layerDoc}).strokes().length === 2`);
  assert.deepEqual(await strokes(a), ["pen", "fill"]);
  // The colour under the tap is red; far outside the square it is clear.
  const pixel = (page, x, y) => page.eval(`(() => { const l = window.__app.session.doc("draw").layers()[0]; const c = document.querySelector('.draw-layer[data-layer="' + l.id + '"] canvas'); const r = c.getBoundingClientRect(); const g = c.getContext("2d"); const d = g.getImageData(Math.round((${x} - r.left) * c.width / r.width), Math.round((${y} - r.top) * c.height / r.height), 1, 1).data; return [d[0], d[1], d[2], d[3]]; })()`);
  const inside = await pixel(a, mid[0], mid[1]);
  assert.ok(inside[3] > 200 && inside[0] > 150 && inside[1] < 120, "red inside: " + inside);
  const outside = await pixel(a, box.x + box.w * 0.15, box.y + box.h * 0.85);
  assert.equal(outside[3], 0, "clear outside: " + outside);
  await a.shot(out("fill.png"));
  // The friend sees the same fill.
  await b.waitFor(`window.__app.session.doc(${layerDoc}).strokes().length === 2`);
  await b.front();
  await pause(300);
  const theirs = await pixel(b, mid[0], mid[1]);
  assert.ok(theirs[3] > 200 && theirs[0] > 150, "the friend sees it red: " + theirs);
  // Undo takes it away.
  await a.front();
  await click(a, "#draw-undo");
  await a.waitFor(`window.__app.session.doc(${layerDoc}).strokes().length === 1`);
});

// 문지르기 (libmypaint's smudge for the idea, Krita's smearing): a finger through wet paint pulls
// the colour along into the empty paper beside it; where it did not pass stays as it was.
scenario("문지르기: dragged out of a red bar, the red is pulled into the empty paper to its right (only along the finger's way); kept as a smudge; the friend's screen smudges the same", async ({ open, out }) => {
  const a = await open({ dev: "a", width: 420, height: 860 });
  await click(a, "#add-creative");
  await click(a, '[data-kind="creative-draw"]');
  await fill(a, "#room-name", "문지르기");
  await fill(a, "#my-name", "가람");
  await click(a, "#create-room");
  await a.waitFor(`location.hash.startsWith("#r-") && ${q("#invite-done")}`);
  await click(a, "#invite-done");
  await a.waitFor(`${q("#draw-page")} && window.__app.session.doc("draw").layers().length === 1`);
  const id = await a.eval("location.hash.slice(3)");
  const b = await open({ dev: "b", hash: "r-" + id, width: 420, height: 860 });
  await joinNew(b, { name: "나래" });
  await b.waitFor(`${q("#draw-page")} && window.__app.session.doc("draw").layers().length === 1`);
  const layerDoc = `("k:L" + window.__app.session.doc("draw").layers()[0].id)`;
  await a.front();
  const box = await a.eval(`(() => { const r = document.getElementById("draw-page").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const drag = async (from, to, steps) => {
    await a.press(from[0], from[1]);
    for (let k = 1; k <= steps; k++) await a.moveTo(from[0] + ((to[0] - from[0]) * k) / steps, from[1] + ((to[1] - from[1]) * k) / steps);
    await a.release(to[0], to[1]);
  };
  // A thick red bar, top to bottom.
  await click(a, '[data-brush="marker"]');
  await click(a, '[data-ink="red"]');
  await click(a, '[data-width="3"]');
  const barX = box.x + box.w * 0.35;
  await drag([barX, box.y + box.h * 0.2], [barX, box.y + box.h * 0.7], 12);
  await a.waitFor(`window.__app.session.doc(${layerDoc}).strokes().length === 1`);
  // Alpha along a row of the layer, in screen px.
  const row = (page, y) => page.eval(`(() => { const l = window.__app.session.doc("draw").layers()[0]; const c = document.querySelector('.draw-layer[data-layer="' + l.id + '"] canvas'); const r = c.getBoundingClientRect(); const g = c.getContext("2d"); const yy = Math.round((${y} - r.top) * c.height / r.height); const d = g.getImageData(0, yy, c.width, 1).data; const out = []; for (let x = Math.ceil(r.left); x < r.right; x++) { const i = Math.round((x - r.left) * c.width / r.width) * 4; out.push([x, d[i], d[i + 3]]); } return out; })()`);
  const plain = box.y + box.h * 0.3;
  const through = box.y + box.h * 0.5;
  const before = await row(a, through);
  const barRight = Math.max(...before.filter(([, , al]) => al > 128).map(([x]) => x));
  assert.ok(barRight > barX && barRight < barX + 40, "the bar's right edge: " + barRight);
  const near = barRight + 8;
  assert.equal(before.find(([x]) => x === near)[2], 0, "clear paper beside the bar before");
  // 문지르기, slowly out of the bar to the right.
  await click(a, '[data-brush="smudge"]');
  assert.equal(await a.eval(`${q('[data-brush="smudge"]')}.getAttribute("aria-pressed")`), "true");
  // While the finger is still down the paper already shows the smudge (laid as it goes).
  const endX = box.x + box.w * 0.75;
  await a.press(barX - 6, through);
  for (let k = 1; k <= 30; k++) await a.moveTo(barX - 6 + ((endX - barX + 6) * k) / 30, through);
  await pause(120);
  const during = (await row(a, through)).find(([x]) => x === near);
  assert.ok(during[2] > 30 && during[1] > 150, "smudged while drawing: " + during);
  await a.release(endX, through);
  await a.waitFor(`window.__app.session.doc(${layerDoc}).strokes().length === 2`);
  assert.deepEqual(await a.eval(`window.__app.session.doc(${layerDoc}).strokes().map((s) => s.s || s.b)`), ["marker", "smudge"]);
  await pause(150);
  const after = await row(a, through);
  const pulled = after.find(([x]) => x === near);
  assert.ok(pulled[2] > 30 && pulled[1] > 150, "red pulled into the paper beside the bar: " + pulled);
  assert.ok(Math.abs(pulled[2] - during[2]) < 40, "as kept, as it looked while drawing: " + pulled + " / " + during);
  const untouched = (await row(a, plain)).find(([x]) => x === near);
  assert.equal(untouched[2], 0, "where the finger did not pass stays clear: " + untouched);
  await a.shot(out("smudge.png"));
  // The friend's screen smudges the same.
  await b.waitFor(`window.__app.session.doc(${layerDoc}).strokes().length === 2`);
  await b.front();
  await pause(300);
  const theirs = (await row(b, through)).find(([x]) => x === near);
  assert.ok(theirs[2] > 30 && Math.abs(theirs[2] - pulled[2]) < 40, "the friend sees it smudged alike: " + theirs + " / " + pulled);
});

scenario("brush sheet: all nine brushes drawn on one page, each kept as its own brush", async ({ open, out }) => {
  const a = await open({ dev: "a", width: 430, height: 900 });
  await click(a, "#add-creative");
  await click(a, '[data-kind="creative-draw"]');
  await fill(a, "#room-name", "붓 모음");
  await fill(a, "#my-name", "가람");
  await click(a, "#create-room");
  await a.waitFor(`location.hash.startsWith("#r-") && ${q("#invite-done")}`);
  await click(a, "#invite-done");
  await a.waitFor(`${q("#draw-page")} && window.__app.session.doc("draw").layers().length === 1`);
  const doc = await a.eval(`"k:L" + window.__app.session.doc("draw").layers()[0].id`);
  const box = await a.eval(`(() => { const r = document.getElementById("draw-page").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const brushes = ["pen", "fountain", "brushpen", "pencil", "sketch", "crayon", "marker", "airbrush", "highlighter"];
  const colours = ["black", "blue", "indigo", "black", "violet", "orange", "green", "red", "yellow"];
  await click(a, '[data-width="3"]');
  for (let i = 0; i < brushes.length; i++) {
    await click(a, `[data-brush="${brushes[i]}"]`);
    await click(a, `[data-ink="${colours[i]}"]`);
    const y = box.y + box.h * (0.07 + i * 0.1);
    await a.press(box.x + box.w * 0.12, y);
    for (let k = 1; k <= 16; k++) await a.moveTo(box.x + box.w * (0.12 + 0.048 * k), y + Math.sin(k / 2.2) * box.h * 0.025);
    await a.release(box.x + box.w * 0.88, y);
    await a.waitFor(`window.__app.session.doc(${JSON.stringify(doc)}).strokes().length === ${i + 1}`);
  }
  const kept = await a.eval(`window.__app.session.doc(${JSON.stringify(doc)}).strokes().map((s) => s.s || s.b || "pen")`);
  assert.deepEqual(kept, brushes);
  await a.front();
  await pause(150);
  await a.shot(out("brush-sheet.png"));
});

// The owner (20 November): the panel's grip can be thrown to the left, right, top or bottom edge,
// and the panel goes there; its end swiped back toward its own edge puts it away; a tap on ⋮ brings
// it out where it last was. Judged as vaul judges a drawer's swipe (quick, or a quarter of its size).
scenario("⋮ panel thrown by its grip: up it goes to the top edge, left to the left; its inner edge swiped home puts it away; a nudge leaves it; a tap on ⋮ opens it where it last was", async ({ open, out }) => {
  const page = await open({ width: 390, height: 820 });
  await page.waitFor(q("#home-more"));
  const centre = (sel) => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const flick = async (sel, dx, dy) => {
    const [x, y] = await centre(sel);
    await page.front();
    await page.touch("start", [[x, y]]);
    for (let i = 1; i <= 6; i++) await page.touch("move", [[x + (dx * i) / 6, y + (dy * i) / 6]]);
    await page.touch("end");
  };
  await click(page, "#home-more");
  await page.waitFor(`${q("#home-panel")}?.dataset.edge === "bottom"`, 2000);
  await pause(600);
  // Up: to the top edge, lit there.
  await flick("#panel-grip", 0, -260);
  await page.waitFor(`!!document.querySelector(".edge-glow[data-edge='top']")`, 2000);
  await page.waitFor(`${q("#home-panel")}?.dataset.edge === "top"`, 2000);
  await pause(600);
  await page.shot(out("panel-top.png"));
  // Put away, and a tap brings it back at the top.
  await page.key("Escape");
  await page.waitFor(`!document.getElementById("home-panel")`, 2000);
  await click(page, "#home-more");
  await page.waitFor(`${q("#home-panel")}?.dataset.edge === "top"`, 2000);
  await pause(600);
  // A nudge: it stays as it is.
  await flick("#panel-grip", 6, 4);
  await pause(400);
  assert.equal(await page.eval(`${q("#home-panel")}?.dataset.edge`), "top", "a nudge leaves it");
  // Left: to the left edge.
  await flick("#panel-grip", -230, 0);
  await page.waitFor(`${q("#home-panel")}?.dataset.edge === "left"`, 2500);
  await pause(600);
  await page.shot(out("panel-left.png"));
  // Its inner edge swiped back to the left: put away.
  await flick("#panel-end", -160, 0);
  await page.waitFor(`!document.getElementById("home-panel")`, 2500);
  await click(page, "#home-more");
  await page.waitFor(`${q("#home-panel")}?.dataset.edge === "left"`, 2000);
});

// The owner (20 November): "점 3개 … 바깥에꺼가 터치가 되게끔 해야해 … 반만 가려져서 다른 거를 꾹 누르고
// 스와이프해서 거기 방 안에 넣을 수 있게끔 … 또 그걸 눌러서 다른 위치로 그게 옮겨가게 … 레퍼런스처럼
// 독단적으로 … 오른쪽에는 독단적으로 나오게 하는 거, 그리고 왼쪽에는 그 원래 했던 그거 느낌대로".
scenario("찾기와 집 leaves home touchable: half the screen; a room beside it is starred and drawn into its house; an empty tap puts it away; ⋮ again moves it round the edges and stays pressable; the icon on ⋮'s right floats it like 레퍼런스, moved by its head and kept there", async ({ open, out }) => {
  const page = await open({ width: 390, height: 820 });
  for (const room of ["햇살 일기", "바람 노트"]) {
    await createRoom(page, { room });
    await click(page, "#back");
    await page.waitFor(q("#home"));
  }
  const dailyNames = () => page.eval(`[...document.querySelectorAll('.half[data-side="daily"] .rooms .room-name')].map((e) => e.textContent)`);
  const centre = (sel) => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const pressable = (sel) => page.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && el.contains(hit); })()`);
  // Out at the bottom, half the screen at most; nothing dark over home.
  await click(page, "#home-more");
  await page.waitFor(`${q("#home-panel")}?.dataset.edge === "bottom"`, 2000);
  await pause(600);
  const box = await page.eval(`(() => { const r = document.getElementById("home-panel").getBoundingClientRect(); return { top: r.top, h: r.height }; })()`);
  assert.ok(box.h <= 820 / 2 + 1, "half the height at most: " + JSON.stringify(box));
  // A house built in it.
  await click(page, "#house-new");
  await fill(page, "#house-name", "작은 집");
  await click(page, "#house-save");
  await page.waitFor(q("#house-back"));
  await click(page, "#house-back");
  await page.waitFor(q("#home-panel .house-tile[data-house]"));
  // Home beside it answers: a room's star is pressed, and the panel stays out.
  const id = await page.eval(`window.__app.store.get("rooms", []).find((r) => r.name === "햇살 일기").id`);
  assert.ok(await pressable(`[data-star="${id}"]`), "the star beside the panel can be pressed");
  await click(page, `[data-star="${id}"]`);
  await page.waitFor(`${q(`[data-star="${id}"]`)}?.getAttribute("aria-pressed") === "true"`);
  assert.ok(await page.eval(`!!document.getElementById("home-panel")`), "still out after a tap on a room's star");
  // A room held beside it and drawn onto its house: in it, gone from home's list, the house counts it.
  const from = await page.eval(`(() => { const row = [...document.querySelectorAll(".room-row")].find((r) => r.querySelector(".room-name").textContent === "바람 노트"); const b = row.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
  const to = await centre("#home-panel .house-tile[data-house]");
  assert.ok(from[1] < box.top, "the room lies above the panel");
  await page.front();
  await page.touch("start", [from]);
  await pause(700);
  assert.ok(!(await page.eval(`!!document.getElementById("house-dock")`)), "no dock of houses from below while the panel is out");
  for (let i = 1; i <= 12; i++) await page.touch("move", [[from[0] + ((to[0] - from[0]) * i) / 12, from[1] + ((to[1] - from[1]) * i) / 12]]);
  await page.waitFor(q("#home-panel .house-tile[data-house].over"));
  await page.shot(out("panel-drop-house.png"));
  await page.touch("end");
  await page.waitFor(`!${q(".room-ghost")} && ${q("#home-panel .house-tile[data-house] .house-count")}?.textContent === "1"`, 3000);
  assert.ok(!(await dailyNames()).includes("바람 노트"), "it left home's list");
  assert.ok(await page.eval(`!!document.getElementById("home-panel")`), "the panel is still out");
  // An open house takes a room dropped anywhere on it.
  await click(page, "#home-panel .house-tile[data-house]");
  await page.waitFor(`${q("#house-rooms")}?.textContent.includes("바람 노트")`);
  const from2 = await page.eval(`(() => { const row = [...document.querySelectorAll(".room-row")].find((r) => r.querySelector(".room-name").textContent === "햇살 일기"); const b = row.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
  const to2 = await centre("#house-rooms");
  await page.touch("start", [from2]);
  await pause(700);
  for (let i = 1; i <= 12; i++) await page.touch("move", [[from2[0] + ((to2[0] - from2[0]) * i) / 12, from2[1] + ((to2[1] - from2[1]) * i) / 12 + 30]]);
  await page.waitFor(q("#home-panel.over"));
  await page.touch("end");
  await page.waitFor(`${q("#house-rooms")}?.textContent.includes("햇살 일기")`, 3000);
  assert.ok(!(await page.eval(`!!document.querySelector("#home-panel.over")`)), "the light on it goes when let go");
  // A tap on an empty place puts it away.
  const empty = await centre('.half[data-side="daily"] .half-title');
  await page.touch("start", [empty]);
  await page.touch("end");
  await page.waitFor(`!document.getElementById("home-panel")`, 2000);
  // ⋮ again while it is out: it moves to the next edge round (bottom → left → top → right), and ⋮ stays pressable on each.
  await click(page, "#home-more");
  await page.waitFor(`${q("#home-panel")}?.dataset.edge === "bottom"`, 2000);
  await pause(600);
  for (const next of ["left", "top", "right"]) {
    assert.ok(await pressable("#home-more"), "⋮ can be pressed with the panel out");
    await click(page, "#home-more");
    await page.waitFor(`${q("#home-panel")}?.dataset.edge === ${JSON.stringify(next)} && document.querySelectorAll("#home-panel").length === 1`, 2500);
    await pause(650);
    // What the panel holds is not under home's buttons.
    const clear = await page.eval(`(() => { const t = document.querySelector(".home-top").getBoundingClientRect(); const f = document.getElementById("home-search").getBoundingClientRect(); return f.top >= t.bottom || f.right <= t.left || f.left >= t.right || f.bottom <= t.top; })()`);
    assert.ok(clear, next + ": the search field is clear of home's buttons");
    if (next === "right") await page.shot(out("panel-moved-right.png"));
  }
  assert.ok(await pressable("#home-more"), "⋮ can still be pressed");
  // The icon on ⋮'s right: the same panel floating on its own, below home's buttons.
  await click(page, "#home-float");
  await page.waitFor(`${q("#home-panel.floating")} && ${q("#float-head")}`, 2000);
  await pause(350);
  assert.equal(await page.eval(`document.querySelectorAll("#home-panel").length`), 1, "one panel at a time");
  const placed = await page.eval(`(() => { const r = document.getElementById("home-panel").getBoundingClientRect(); const t = document.querySelector(".home-top").getBoundingClientRect(); return { top: r.top, below: t.bottom, left: r.left, right: r.right }; })()`);
  assert.ok(placed.top >= placed.below && placed.left >= 0 && placed.right <= 390, "below the buttons, on the screen: " + JSON.stringify(placed));
  // Moved by its head; let go, it stays there and is remembered.
  const head = await centre("#float-head");
  await page.front();
  await page.touch("start", [[head[0] - 60, head[1]]]);
  for (let i = 1; i <= 8; i++) await page.touch("move", [[head[0] - 60 - i * 3, head[1] + i * 30]]);
  await page.touch("end");
  await pause(200);
  const moved = await page.eval(`(() => { const r = document.getElementById("home-panel").getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; })()`);
  assert.ok(moved.y > placed.top + 200, "it went down with the head: " + JSON.stringify([placed, moved]));
  assert.deepEqual(await page.eval(`window.__app.store.get("homePanelFloat", null)`), moved, "where it was left is kept");
  await page.shot(out("panel-floating.png"));
  // Floating, a tap on an empty place leaves it (it stands on its own); the icon puts it away; again, it comes back there.
  const empty2 = await centre('.half[data-side="creative"] .half-title');
  await page.touch("start", [empty2]);
  await page.touch("end");
  await pause(300);
  assert.ok(await page.eval(`!!document.getElementById("home-panel")`), "floating, an empty tap leaves it out");
  await click(page, "#home-float");
  await page.waitFor(`!document.getElementById("home-panel")`, 2000);
  await click(page, "#home-float");
  await page.waitFor(q("#home-panel.floating"), 2000);
  await pause(350);
  const again = await page.eval(`(() => { const r = document.getElementById("home-panel").getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; })()`);
  assert.deepEqual(again, moved, "it comes back where it was left");
  await click(page, "#float-close");
  await page.waitFor(`!document.getElementById("home-panel")`, 2000);
  // And ⋮ still brings it out of the edge as before.
  await click(page, "#home-more");
  await page.waitFor(`${q("#home-panel")}?.dataset.edge === "right" && !${q("#home-panel.floating")}`, 2000);
});

// The owner (20 November): "필압등 그 걍 손으로 해도 좋은 필기감". A finger has no pressure: it is read
// from the hand's speed on the glass and kept in the line, as a pen's would be. A slow finger line is
// heavier than a quick one; the mouse stays even (a tool, not a hand).
scenario("finger lines press as a pen would: a slow finger line is kept heavier than a quick one, touching down light; the mouse stays even", async ({ open, out }) => {
  const page = await open({ width: 420, height: 860 });
  await click(page, "#add-creative");
  await click(page, '[data-kind="creative-draw"]');
  await fill(page, "#room-name", "손 그림");
  await fill(page, "#my-name", "가람");
  await click(page, "#create-room");
  await page.waitFor(`location.hash.startsWith("#r-") && ${q("#invite-done")}`);
  await click(page, "#invite-done");
  await page.waitFor(`${q("#draw-page")} && window.__app.session.doc("draw").layers().length === 1`);
  const box = await page.eval(`(() => { const r = document.getElementById("draw-page").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const strokes = () => page.eval(`(() => { const l = window.__app.session.doc("draw").layers()[0]; return window.__app.session.doc("k:L" + l.id).strokes().map((s) => s.pts.filter((_, i) => i % 3 === 2)); })()`);
  await page.front();
  // Slowly, as one writes carefully.
  const y1 = box.y + box.h * 0.3;
  await page.touch("start", [[box.x + box.w * 0.15, y1]]);
  for (let i = 1; i <= 30; i++) {
    await page.touch("move", [[box.x + box.w * 0.15 + i * 6, y1 + Math.sin(i / 4) * 4]]);
    await pause(20);
  }
  await page.touch("end");
  await page.waitFor(`(() => { const l = window.__app.session.doc("draw").layers()[0]; return window.__app.session.doc("k:L" + l.id).strokes().length === 1; })()`);
  // Quickly, a flick.
  const y2 = box.y + box.h * 0.5;
  await page.touch("start", [[box.x + box.w * 0.15, y2]]);
  for (let i = 1; i <= 6; i++) await page.touch("move", [[box.x + box.w * 0.15 + i * 45, y2 + i * 2]]);
  await page.touch("end");
  await page.waitFor(`(() => { const l = window.__app.session.doc("draw").layers()[0]; return window.__app.session.doc("k:L" + l.id).strokes().length === 2; })()`);
  // The mouse.
  const y3 = box.y + box.h * 0.7;
  await page.press(box.x + box.w * 0.15, y3);
  for (let i = 1; i <= 8; i++) await page.moveTo(box.x + box.w * (0.15 + 0.07 * i), y3);
  await page.release(box.x + box.w * 0.71, y3);
  await page.waitFor(`(() => { const l = window.__app.session.doc("draw").layers()[0]; return window.__app.session.doc("k:L" + l.id).strokes().length === 3; })()`);
  const [slow, quick, mouse] = await strokes();
  const middle = (ps) => { const m = ps.slice(Math.floor(ps.length / 3), Math.ceil((ps.length * 2) / 3)); return m.reduce((a, b) => a + b, 0) / m.length; };
  assert.ok(slow[0] < 50, "a finger touches down light: " + slow[0]);
  assert.ok(middle(slow) >= 62, "a slow finger presses: " + JSON.stringify(slow));
  assert.ok(middle(quick) <= 50 && middle(slow) - middle(quick) >= 15, "a quick one skims: " + JSON.stringify(quick));
  assert.ok(mouse.every((p) => p === 50), "the mouse stays even: " + JSON.stringify(mouse));
  await page.shot(out("finger-feel.png"));
});

// 애니메이션 방 (reference study §3, FlipaClip · Procreate · OpenToonz): a flipbook drawn together.
// It starts with two empty frames and the onion skin on; a frame drawn on shows faintly (red) on the
// next; a frame copied comes next with the same drawing; held longer (×3) it is wider in the strip
// and shows longer as it plays; ▶ plays the frames in turn; the friend sees the same frames, and the
// strip shows on which frame each friend is.
scenario("애니메이션 방: two frames to start; the onion skin shows the frame before; 복제 copies a frame; ×3 holds it; ▶ plays the frames in turn; the friend sees the frames and where each one is", async ({ open, out }) => {
  const a = await open({ dev: "a", width: 420, height: 880 });
  await click(a, "#add-creative");
  await click(a, '[data-kind="creative-anim"]');
  await fill(a, "#room-name", "같이 플립북");
  await fill(a, "#my-name", "가람");
  await click(a, "#create-room");
  await a.waitFor(`location.hash.startsWith("#r-") && ${q("#invite-done")}`);
  await click(a, "#invite-done");
  await a.waitFor(`${q("#anim-page")} && window.__app.session.doc("anim").frames().length === 2 && document.querySelectorAll("#anim-strip .anim-frame").length === 2`);
  assert.equal(await a.eval(`${q("#anim-onion-btn")}.getAttribute("aria-pressed")`), "true", "the onion skin is on");
  const frames = () => a.eval(`window.__app.session.doc("anim").frames().map((f) => f.id)`);
  const [f1, f2] = await frames();
  const box = await a.eval(`(() => { const r = document.getElementById("anim-page").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  // A ball on the first frame.
  await a.press(box.x + box.w * 0.3, box.y + box.h * 0.5);
  for (let i = 1; i <= 12; i++) await a.moveTo(box.x + box.w * (0.3 + 0.08 * Math.cos((i / 12) * Math.PI * 2) - 0.08), box.y + box.h * (0.5 + 0.06 * Math.sin((i / 12) * Math.PI * 2)));
  await a.release(box.x + box.w * 0.3, box.y + box.h * 0.5);
  await a.waitFor(`window.__app.session.doc("k:F${f1}").strokes().length === 1`);
  // On the second frame, the first shows faintly beneath (the onion skin has ink).
  await click(a, `.anim-frame[data-frame="${f2}"]`);
  await a.waitFor(`${q(`.anim-frame[data-frame="${f2}"]`)}.classList.contains("on")`);
  await a.front();
  await pause(200);
  const onionInk = await a.eval(`(() => { const c = document.querySelector(".anim-onion"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; })()`);
  assert.ok(onionInk > 50, "the frame before shows through: " + onionInk);
  // Back to the first, and 복제: a third frame right after it, with the same ball.
  await click(a, `.anim-frame[data-frame="${f1}"]`);
  await click(a, "#anim-copy");
  await a.waitFor(`window.__app.session.doc("anim").frames().length === 3`);
  const after = await frames();
  assert.equal(after[0], f1);
  assert.equal(after[2], f2, "the copy comes right after the one copied");
  await a.waitFor(`window.__app.session.doc("k:F${after[1]}").strokes().length === 1`);
  // ×3: held longer, wider in the strip.
  const narrow = await a.eval(`${q(`.anim-frame[data-frame="${f1}"]`)}.getBoundingClientRect().width`);
  const cell = await a.eval(`(() => { const r = document.querySelector('.anim-frame[data-frame="${f1}"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await a.front();
  await a.touch("start", [cell]);
  await pause(650);
  await a.touch("end");
  await a.waitFor(q("#anim-menu"), 2000);
  await click(a, '#anim-menu [data-hold="3"]');
  await a.waitFor(`window.__app.session.doc("anim").frame("${f1}").hold === 3 && !document.getElementById("anim-menu")`);
  const wide = await a.eval(`${q(`.anim-frame[data-frame="${f1}"]`)}.getBoundingClientRect().width`);
  assert.ok(wide > narrow * 1.5, `held frames are wider: ${narrow} → ${wide}`);
  // The friend joins and sees the three frames; the strip shows where the friend is.
  const id = await a.eval("location.hash.slice(3)");
  const b = await open({ dev: "b", hash: "r-" + id, width: 420, height: 880 });
  await joinNew(b, { name: "나래" });
  await b.waitFor(`document.querySelectorAll("#anim-strip .anim-frame").length === 3`);
  await click(b, `.anim-frame[data-frame="${f2}"]`);
  await a.waitFor(`${q(`.anim-frame[data-frame="${f2}"] .anim-peers i`)}`, 4000);
  // ▶: the frames show in turn (f1 three ticks, then its copy, then f2), and ⏸ stops.
  await a.front();
  await click(a, "#anim-play");
  const seen = new Set();
  const until = Date.now() + 2500;
  while (Date.now() < until && seen.size < 3) {
    const f = await a.eval(`document.getElementById("anim-show").dataset.frame || ""`);
    if (f) seen.add(f);
    await pause(30);
  }
  assert.equal(seen.size, 3, "every frame showed while playing: " + [...seen]);
  await a.shot(out("anim-playing.png"));
  await click(a, "#anim-play");
  await a.waitFor(`document.getElementById("anim-show").hidden`);
  await a.shot(out("anim-room.png"));
});

// The owner: "친구한테 미니게임 신청하기… 친구가 수락하면 전체가 조금 불투명하게 바뀌고 가운데 3, 2, 1…
// 카운트가 끝났을 때 미니게임이 뜨게", "그거 끄는 기능도 홈 화면에서". From the reference study §4.
// The owner (20 November): "인원수가 많아 질 수록 2인용 게임 말고도 다른것도… 갈틱폰의 느낌". 이어 그리기 for
// everyone in the room: the asker opens it, friends join from their small card, the asker begins it
// with who joined; a line each, the books pass on, the line is drawn, the books pass on, the drawing
// is put into words; then the album is turned page by page, the same page on every screen.
scenario("이어 그리기: three friends join, write a line each, draw the line they got, put the drawing they got into words; the album turns for everyone; 한 판 더 and 닫기", async ({ open, out }) => {
  const a = await open({ dev: "a", width: 400, height: 860 });
  await createRoom(a, { room: "파티 방", name: "가람" });
  const id = await a.eval("location.hash.slice(3)");
  const b = await open({ dev: "b", hash: "r-" + id, width: 400, height: 860 });
  await joinNew(b, { name: "나래" });
  const c = await open({ dev: "c", hash: "r-" + id, width: 400, height: 860 });
  await joinNew(c, { name: "다온" });
  await a.waitFor(`window.__app.session.peers.filter((p) => !p.isMe && p.state?.m).length >= 2`, 6000);
  await a.front();
  await click(a, "#room-game");
  await a.waitFor(`${q("#game-menu")} && !${q('[data-game="relay"]')}.disabled`);
  assert.match(await text(a, ".game-menu-title"), /3명이/);
  await click(a, '[data-game="relay"]');
  await a.waitFor(q("#relay-gather"), 5000);
  assert.ok(await a.eval(`${q("#relay-begin")}.disabled`), "alone it cannot begin");
  for (const p of [b, c]) {
    await p.waitFor(q("#game-invite"), 6000);
    assert.match(await text(p, "#game-invite"), /가람님이 이어 그리기를 열었어요/);
    await p.front();
    await click(p, "#game-accept");
    await p.waitFor(q("#relay-gather"), 5000);
  }
  await a.waitFor(`${q("#relay-begin")}?.textContent === "3명이서 시작" && !${q("#relay-begin")}.disabled`, 5000);
  await a.front();
  await a.shot(out("relay-gather.png"));
  await click(a, "#relay-begin");
  const pages = [a, b, c];
  for (const p of pages) await p.waitFor(`${q("#relay-round")}?.dataset.kind === "write"`, 9000);
  // Round 1: a line each.
  const lines = { a: "우산 쓴 펭귄", b: "피아노 치는 문어", c: "달에서 라면 먹기" };
  for (const [name, p] of [["a", a], ["b", b], ["c", c]]) {
    await p.front();
    await fill(p, "#relay-text", lines[name]);
    await click(p, "#relay-done");
  }
  // Round 2: each draws the line of the one before (a gets c's, b gets a's, c gets b's).
  for (const p of pages) await p.waitFor(`${q("#relay-round")}?.dataset.kind === "draw"`, 9000);
  assert.equal(await text(a, "#relay-given"), lines.c);
  assert.equal(await text(b, "#relay-given"), lines.a);
  assert.equal(await text(c, "#relay-given"), lines.b);
  for (const p of pages) {
    await p.front();
    const box = await p.eval(`(() => { const r = document.getElementById("relay-page").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    await p.press(box.x + box.w * 0.25, box.y + box.h * 0.5);
    for (let i = 1; i <= 8; i++) await p.moveTo(box.x + box.w * (0.25 + 0.06 * i), box.y + box.h * (0.5 + Math.sin(i) * 0.15));
    await p.release(box.x + box.w * 0.73, box.y + box.h * 0.5);
  }
  await b.shot(out("relay-draw.png"));
  for (const p of pages) { await p.front(); await click(p, "#relay-done"); }
  // Round 3: what the drawing shows (a sees b's drawing of a's own line? no: the book of b, drawn by c… each gets the next book).
  for (const p of pages) await p.waitFor(`${q("#relay-round")}?.dataset.kind === "guess"`, 9000);
  await c.waitFor(`document.querySelector("#relay-round .relay-page canvas") !== null`);
  for (const [name, p] of [["a", a], ["b", b], ["c", c]]) {
    await p.front();
    await fill(p, "#relay-text", name + "의 생각");
    await click(p, "#relay-done");
  }
  // The album: the same page for everyone, whoever turns it.
  for (const p of pages) await p.waitFor(q("#relay-album-card"), 9000);
  await click(b, "#relay-next");
  for (const p of pages) await p.waitFor(`document.querySelectorAll("#relay-album .relay-entry").length === 1`, 5000);
  assert.equal(await text(a, "#relay-album .relay-entry-text"), lines.a, "a's book begins with a's line");
  await click(c, "#relay-next");
  await click(a, "#relay-next");
  for (const p of pages) await p.waitFor(`document.querySelectorAll("#relay-album .relay-entry").length === 3`, 5000);
  assert.equal(await c.eval(`document.querySelectorAll("#relay-album .relay-entry")[1].dataset.kind`), "draw");
  await a.shot(out("relay-album.png"));
  for (let n = 3; n <= 9; n++) { await a.front(); await click(a, "#relay-next"); await a.waitFor(`window.__app.session.doc("game").game(${JSON.stringify(await a.eval(`window.__app.session.doc("game").list().at(-1).id`))}).turn >= ${n}`, 4000); }
  for (const p of pages) await p.waitFor(q("#relay-again"), 5000);
  await click(a, "#relay-close");
  await a.waitFor(`!${q("#game-layer")}`, 3000);
});

scenario("미니게임: 가위바위보 asked from the top bar; the friend's small card accepts it; both screens dim and count 3·2·1, then show the hands together; 오목 to five in a row; the tally; switched off at home, no button and no invitation", async ({ open, out }) => {
  const a = await open({ dev: "a", width: 400, height: 860 });
  await createRoom(a, { room: "게임 방", name: "가람" });
  const id = await a.eval("location.hash.slice(3)");
  const b = await open({ dev: "b", hash: "r-" + id, width: 400, height: 860 });
  await joinNew(b, { name: "나래" });
  await a.waitFor(`window.__app.session.peers.some((p) => !p.isMe && p.state?.m)`, 5000);
  // 가위바위보.
  await click(a, "#room-game");
  await a.waitFor(`${q("#game-menu")} && !${q('[data-game="rps"]')}.disabled`);
  assert.match(await text(a, ".game-menu-title"), /나래님과/);
  await click(a, '[data-game="rps"]');
  await b.waitFor(q("#game-invite"), 5000);
  assert.match(await text(b, "#game-invite"), /가람님이 가위바위보를 신청했어요/);
  await b.shot(out("game-invite.png"));
  await click(b, "#game-accept");
  await a.waitFor(`${q("#game-count")}`, 5000);
  await b.waitFor(`${q("#game-count")}`, 5000);
  assert.ok(["1", "2", "3"].includes(await text(a, "#game-count")), "a counts");
  await a.shot(out("game-count.png"));
  await click(a, '[data-hand="rock"]');
  await click(b, '[data-hand="scissors"]');
  await a.waitFor(`${q("#game-result")}?.textContent === "이겼어요!"`, 8000);
  await b.waitFor(`${q("#game-result")}?.textContent === "가람님 승"`, 8000);
  assert.equal(await text(a, "#rps-theirs"), "✌️");
  await a.shot(out("game-rps.png"));
  await click(a, "#game-close");
  await click(b, "#game-close");
  // 오목: a (black) makes five in a row.
  await click(a, "#room-game");
  await click(a, '[data-game="omok"]');
  await b.waitFor(q("#game-invite"), 5000);
  await click(b, "#game-accept");
  await a.waitFor(q("#omok"), 8000);
  await b.waitFor(q("#omok"), 8000);
  const stone = async (page, x, y) => {
    await page.waitFor(`!${q(`.omok-cell[data-x="${x}"][data-y="${y}"]`)}.disabled`, 5000);
    await click(page, `.omok-cell[data-x="${x}"][data-y="${y}"]`);
  };
  for (let i = 0; i < 5; i++) {
    await stone(a, 5 + i, 7);
    if (i < 4) await stone(b, 5 + i, 9);
  }
  await a.waitFor(`document.querySelectorAll(".omok-stone.lit").length === 5`, 5000);
  await b.waitFor(`${q("#game-result")}?.textContent === "가람님 승"`, 5000);
  await a.shot(out("game-omok.png"));
  await click(a, "#game-close");
  await click(a, "#room-game");
  await a.waitFor(q("#game-tally"));
  assert.match(await text(a, "#game-tally"), /나 2 · 나래 0/);
  await a.key("Escape");
  await a.tap(5, 300);
  // 나래 turns games off at home: back in the room, no game button and no invitation.
  await click(b, "#game-close");
  await click(b, "#back");
  await b.waitFor(q("#home-settings"));
  await click(b, "#home-settings");
  await b.waitFor(q("#games-on"));
  await click(b, "#games-on");
  assert.equal(await b.eval(`window.__app.store.get("settings", {}).games`), false);
  await b.key("Escape");
  await b.eval(`(location.hash = "#r-${id}", true)`);
  await b.waitFor(q("#invite"), 5000);
  assert.equal(await b.eval(`!!document.getElementById("room-game")`), false, "no game button");
  await a.waitFor(`window.__app.session.peers.some((p) => !p.isMe && p.state?.m)`, 5000);
  await click(a, "#room-game");
  await click(a, '[data-game="rps"]');
  await pause(1500);
  assert.equal(await b.eval(`!!document.getElementById("game-invite")`), false, "no invitation comes");
});

// From the reference study §5 (GarageBand's count-in): with a tempo set, 녹음 first counts one bar
// (clicks and 1·2·3·4 in the middle), then the take begins; pressed again while counting, no take;
// switched off in 박자, the take begins at once. Without a tempo, nothing changes.
scenario("song 카운트인: with a tempo, a bar of 1·2·3·4 before the take; pressed again while counting, no take; off, the take begins at once", async ({ open, out }) => {
  const page = await open();
  await createSongRoom(page);
  const song = `window.__app.session.doc("song")`;
  await click(page, "#beat");
  await page.waitFor(q("#beat-sheet"));
  await fill(page, "#bpm-input", "120");
  await page.key("Enter");
  await page.waitFor(`${song}.tempo()?.bpm === 120`);
  assert.equal(await page.eval(`${q("#count-in")}.checked`), true, "the count-in is on at first");
  await page.key("Escape");
  await page.waitFor(`!document.getElementById("beat-sheet")`);
  // Counted in, then recorded.
  await click(page, "#record");
  await page.waitFor(q(".count-in"), 4000);
  assert.ok(["1", "2", "3", "4"].includes(await text(page, ".count-in-num")), "a beat's number shows");
  assert.equal(await page.eval(`!!document.getElementById("rec-clip")`), false, "no take while counting");
  await page.shot(out("song-count-in.png"));
  await page.waitFor(`!document.querySelector(".count-in") && ${q("#rec-clip")}`, 6000);
  await page.waitFor(`document.getElementById("song-clock").textContent >= "0:01.5"`, 8000);
  await click(page, "#record");
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 1`, 8000);
  // Pressed again while counting: called off.
  await click(page, "#record");
  await page.waitFor(q(".count-in"), 4000);
  await click(page, "#record");
  await page.waitFor(`!document.querySelector(".count-in")`, 3000);
  await pause(2400);
  assert.equal(await page.eval(`!!document.getElementById("rec-clip")`), false, "no take after it was called off");
  assert.equal(await page.eval(`document.querySelectorAll(".clip[data-id]").length`), 1);
  // Off: at once.
  await click(page, "#beat");
  await page.waitFor(q("#beat-sheet"));
  await click(page, 'label[for="count-in"]');
  assert.equal(await page.eval(`window.__app.store.get("settings", {}).countIn`), false);
  await page.key("Escape");
  await page.waitFor(`!document.getElementById("beat-sheet")`);
  await click(page, "#record");
  await page.waitFor(q("#rec-clip"), 4000);
  assert.equal(await page.eval(`!!document.querySelector(".count-in")`), false, "no count");
  await pause(2000);
  await click(page, "#record");
  await page.waitFor(`document.querySelectorAll(".clip[data-id]").length === 2`, 8000);
});

// The empty song room's ways in once showed the word "falsefalse" (a list with false in it was
// appended as it was). Nothing on the start card but the words and buttons meant to be there.
scenario("song start card: the three ways in show no stray words", async ({ open }) => {
  const page = await open();
  await createSongRoom(page);
  await page.waitFor(q("#start-record"));
  const words = await page.eval(`document.querySelector(".start, #song-start, .song-start")?.textContent || document.body.textContent`);
  assert.ok(!/false|true|undefined|null/.test(words), "no stray words: " + words.slice(0, 200));
});
