// Entering a room for the first time on this device: as a new person, or as
// someone already in the room, proven with their personal code.

import { h, iconButton, mount, inputRow, segmented } from "./dom.js";
import { currentTheme } from "./theme.js";
import { memberColor } from "../core/paint.js";
import { Attempts, newMemberId, makeVerifier, checkVerifier, validPin, joinOps } from "../core/room.js";

export function showJoin(app, session, onDone) {
  const root = app.root;
  const attempts = new Attempts();
  const last = app.store.get("last", {});
  const typed = { name: last.name || "", pin: last.pin || "", backPin: "" };
  let mode = "new";
  let chosen = null;
  const error = h("p", { class: "error", id: "form-error", role: "alert" });
  const body = h("div");

  const dot = (color) => h("span", { class: "dot", style: { background: memberColor(color, currentTheme()) } });

  function newForm() {
    const name = inputRow("join-name", "별명", { maxLength: 20, value: typed.name, oninput: () => { typed.name = name.input.value; } });
    const pin = inputRow("join-pin", "개인 식별 코드 (숫자 5자리, 안 정해도 돼요)", { maxLength: 5, inputMode: "numeric", value: typed.pin, oninput: () => { typed.pin = pin.input.value; } });
    return h("form", { class: "form", onsubmit: enterNew }, name.row,
      h("p", { class: "preview" }, dot(session.room.freeColor()), "내 글은 이 색으로 써져요. 들어온 뒤에 바꿀 수 있어요."),
      pin.row,
      h("p", { class: "help", text: "코드가 있으면 다른 기기에서도 같은 사람, 같은 색으로 들어올 수 있어요." }),
      error, h("button", { class: "btn", id: "enter", type: "submit", text: "들어가기" }));
  }

  function backForm() {
    const people = session.room.members().filter((m) => m.pin);
    if (!people.length) return h("p", { class: "help", id: "no-codes", text: "이 방에는 개인 식별 코드를 정한 사람이 아직 없어요." });
    const pin = inputRow("back-pin", "개인 식별 코드", { maxLength: 5, inputMode: "numeric", value: typed.backPin, oninput: () => { typed.backPin = pin.input.value; } });
    const list = h("div", {}, people.map((m) =>
      h("button", { class: "who", type: "button", data: { id: m.id }, "aria-pressed": String(m.id === chosen), onclick: () => { chosen = m.id; for (const b of list.children) b.setAttribute("aria-pressed", String(b.dataset.id === chosen)); pin.input.focus(); } },
        dot(m.color), h("span", { class: "who-name", text: m.name }))));
    return h("form", { class: "form", onsubmit: enterBack }, h("div", { class: "row" }, h("span", { class: "label", text: "내 이름을 골라 주세요" }), list), pin.row, error,
      h("button", { class: "btn", id: "enter", type: "submit", text: "들어가기" }));
  }

  function drawBody() {
    error.textContent = "";
    mount(body, mode === "new" ? newForm() : backForm());
  }

  async function enterNew(event) {
    event.preventDefault();
    const name = typed.name.trim();
    const pin = typed.pin.trim();
    if (!name) return void (error.textContent = "별명을 적어 주세요.");
    if (pin && !validPin(pin)) return void (error.textContent = "개인 식별 코드는 숫자 5자리예요.");
    const memberId = newMemberId();
    session.commit("room", joinOps(session.clock, session.room, { memberId, name, pin: pin ? await makeVerifier(pin) : null, now: Date.now() }));
    app.store.set("last", { name, pin });
    onDone(memberId);
  }

  async function enterBack(event) {
    event.preventDefault();
    const wait = (ms) => `5번 틀렸어요. ${Math.ceil(ms / 1000)}초 뒤에 다시 해 주세요.`;
    const locked = attempts.lockedMs(Date.now());
    if (locked) return void (error.textContent = wait(locked));
    const member = chosen && session.room.member(chosen);
    if (!member) return void (error.textContent = "내 이름을 골라 주세요.");
    const pin = typed.backPin.trim();
    if (await checkVerifier(pin, member.pin)) {
      attempts.ok();
      app.store.set("last", { name: member.name, pin });
      return onDone(member.id);
    }
    attempts.fail(Date.now());
    const now = attempts.lockedMs(Date.now());
    error.textContent = now ? wait(now) : "코드가 맞지 않아요.";
  }

  const title = h("h1", { text: session.room.meta("name") || "방" });
  mount(root, h("div", { class: "join field daily" },
    h("div", { class: "bar" }, iconButton("back", "back", "홈으로", () => app.go(""))),
    title,
    h("p", { class: "lead", text: "이 기기로는 처음 들어오는 방이에요." }),
    segmented([["new", "처음 왔어요", "join-new"], ["back", "원래 있던 사람이에요", "join-back"]], mode, (value) => { mode = value; drawBody(); }),
    body));
  drawBody();

  // People may still be arriving from the store; keep the list of names fresh.
  return session.on("change", ({ doc }) => {
    if (doc !== "room") return;
    title.textContent = session.room.meta("name") || "방";
    if (mode === "back" && !chosen) drawBody();
  });
}
