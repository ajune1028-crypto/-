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
