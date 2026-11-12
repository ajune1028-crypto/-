// Home: two halves side by side. 일상 on the left, 창작 on the right.

import { h, icon, iconButton, mount, inputRow, openSheet } from "./dom.js";
import { displaySettings } from "./room-shell.js";
import { rememberRoom } from "../identity.js";
import { RoomSession } from "../sync/session.js";
import { newRoomId, newMemberId, makeVerifier, validPin, createRoomOps } from "../core/room.js";
import { dayKey, dayLabel, hourLabel } from "../core/time.js";

const KINDS = {
  daily: [
    { kind: "daily-text", name: "텍스트", note: "같은 종이에 같이 써요", ready: true },
    { kind: "daily-photo", name: "사진", note: "시간대별 사진과 3초 영상" },
    { kind: "daily-both", name: "통합", note: "텍스트와 사진을 한 방에" },
  ],
  creative: [
    { kind: "creative-song", name: "노래 만들기", note: "흥얼거리면 피아노 음이 돼요" },
    { kind: "creative-writing", name: "글쓰기", note: "같이 쓰는 문서" },
    { kind: "creative-board", name: "화이트보드", note: "큰 종이에 전부 올려요" },
  ],
};

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function whenLabel(ms) {
  const tz = localZone();
  const day = dayKey(ms, tz);
  return day === dayKey(Date.now(), tz) ? hourLabel(ms, tz) : dayLabel(day).split(" ").slice(0, 2).join(" ");
}

export function showHome(app) {
  const root = app.root;
  let alive = true;
  let others = [];
  let slow = false;
  let closeSheet = null;

  function roomRow(room, when) {
    return h("button", { class: "room-row", type: "button", data: { id: room.id }, onclick: () => app.go("r-" + room.id) },
      h("span", { class: "room-name", text: room.name }),
      when && h("span", { class: "room-when", text: when }));
  }

  function half(side, title, note, emptyText) {
    const mine = app.store.get("rooms", []).filter((r) => r.kind.startsWith(side)).sort((a, b) => b.at - a.at);
    const known = new Set(app.store.get("rooms", []).map((r) => r.id));
    const elsewhere = others.filter((r) => r.kind.startsWith(side) && !known.has(r.id));
    return h("section", { class: "half field " + side, data: { side } },
      h("div", { class: "half-scroll" },
        h("h1", { class: "half-title", text: title }),
        h("p", { class: "half-note", text: note }),
        mine.length
          ? h("div", { class: "rooms" }, mine.map((r) => roomRow(r, whenLabel(r.at))))
          : h("p", { class: "empty", text: emptyText }),
        elsewhere.length > 0 && [
          h("p", { class: "group-label", text: "다른 기기에서 만든 방" }),
          h("div", { class: "rooms", id: side === "daily" ? "others" : "others-creative" }, elsewhere.map((r) => roomRow(r))),
        ]),
      h("button", { class: "add", id: "add-" + side, type: "button", "aria-label": title + " 방 만들기", onclick: () => chooseKind(side) }, icon("plus")));
  }

  function draw() {
    if (!alive) return;
    const notice = !app.store.available
      ? "이 기기에는 방 목록이 저장되지 않아요"
      : app.limited ? "이 화면에서는 다른 기기와 연결되지 않아요" : null;
    mount(root,
      h("div", { class: "home", id: "home" },
        half("daily", "일상", "가볍게, 매일", "아직 방이 없어요. 아래 +로 만들어 보세요."),
        half("creative", "창작", "같이 만들기", "노래 만들기가 곧 열려요.")),
      notice && h("div", { class: "notice", id: "notice", role: "status", text: notice }),
      h("div", { class: "home-top" }, iconButton("home-settings", "more", "설정", openSettings)),
      h("div", { class: "home-foot" },
        slow && h("span", { class: "hint", id: "connecting", text: "아직 연결 중" }),
        h("button", { class: "pill", id: "by-code", type: "button", text: "코드로 들어가기", onclick: openCode })));
  }

  function sheet(title, build) {
    closeSheet?.();
    closeSheet = openSheet(root, title, build);
  }

  function chooseKind(side) {
    sheet("어떤 방을 만들까요?", (panel, close) => {
      panel.append(h("div", { class: "kinds" }, KINDS[side].map((k) =>
        h("button", { class: "kind", type: "button", data: { kind: k.kind }, disabled: !k.ready, onclick: () => { close(); roomForm(k); } },
          h("span", { class: "kind-name" }, k.name, h("span", { class: "kind-note", text: k.note })),
          !k.ready && h("span", { class: "soon", text: "준비 중" })))));
    });
  }

  function roomForm({ kind, name: kindName }) {
    sheet("새 " + kindName + " 방", (panel, close) => {
      const last = app.store.get("last", {});
      const room = inputRow("room-name", "방 이름", { maxLength: 30, placeholder: "예: 우리 둘" });
      const me = inputRow("my-name", "내 별명", { maxLength: 20, value: last.name || "" });
      const pin = inputRow("my-pin", "개인 식별 코드 (숫자 5자리, 안 정해도 돼요)", { maxLength: 5, inputMode: "numeric", value: last.pin || "" });
      const error = h("p", { class: "error", id: "form-error", role: "alert" });
      const button = h("button", { class: "btn", id: "create-room", type: "submit", text: "방 만들기" });
      const form = h("form", { class: "form", onsubmit: submit }, room.row, me.row, pin.row,
        h("p", { class: "help", text: "코드가 있으면 다른 기기에서도 같은 사람, 같은 색으로 들어올 수 있어요." }), error, button);
      panel.append(form);

      async function submit(event) {
        event.preventDefault();
        const roomName = room.input.value.trim();
        const myName = me.input.value.trim();
        const code = pin.input.value.trim();
        if (!roomName) return void (error.textContent = "방 이름을 적어 주세요.");
        if (!myName) return void (error.textContent = "내 별명을 적어 주세요.");
        if (code && !validPin(code)) return void (error.textContent = "개인 식별 코드는 숫자 5자리예요.");
        error.textContent = "";
        button.disabled = true;
        try {
          const transport = await app.ready;
          const id = newRoomId();
          await transport.createRoom({ id, kind, name: roomName });
          const session = new RoomSession({ transport, roomId: id, store: app.store });
          if ((await session.open()) !== "ok") throw new Error("room did not open");
          const memberId = newMemberId();
          session.commit("room", createRoomOps(session.clock, {
            kind, name: roomName, tz: localZone(), now: Date.now(), memberId, memberName: myName,
            pin: code ? await makeVerifier(code) : null,
          }));
          rememberRoom(app.store, { id, kind, name: roomName, memberId });
          app.store.set("last", { name: myName, pin: code });
          app.handoff = session;
          close();
          app.go("r-" + id);
        } catch (err) {
          console.warn(err);
          button.disabled = false;
          error.textContent = "방을 만들지 못했어요. 잠시 뒤에 다시 해 주세요.";
        }
      }
    });
  }

  function openCode() {
    sheet("코드로 들어가기", (panel, close) => {
      const code = inputRow("code", "방 코드", { maxLength: 20, autocapitalize: "off", placeholder: "영문과 숫자 12자리" });
      const error = h("p", { class: "error", id: "form-error", role: "alert" });
      const button = h("button", { class: "btn", id: "open-code", type: "submit", text: "들어가기" });
      panel.append(h("form", { class: "form", onsubmit: submit }, code.row,
        h("p", { class: "help", text: "방 안의 설정에서 코드를 볼 수 있어요." }), error, button));

      async function submit(event) {
        event.preventDefault();
        const id = code.input.value.toLowerCase().replace(/[^a-z2-7]/g, "");
        button.disabled = true;
        let found = false;
        try {
          const channel = id.length === 12 ? await (await app.ready).openRoom(id) : null;
          found = !!channel;
          channel?.close();
        } catch (err) {
          console.warn(err);
        }
        button.disabled = false;
        if (!found) return void (error.textContent = "그 코드의 방을 찾을 수 없어요.");
        close();
        app.go("r-" + id);
      }
    });
  }

  function openSettings() {
    sheet("설정", (panel) => panel.append(displaySettings(app, { withColors: false })));
  }

  draw();
  const slowTimer = setTimeout(() => {
    if (!app.connecting) return;
    slow = true;
    draw();
  }, 1500);
  app.ready
    .then((transport) => transport.listRooms())
    .then((list) => { others = list; }, (err) => console.warn(err))
    .finally(() => {
      slow = false;
      if (!closeSheet || !root.querySelector(".scrim")) draw();
    });

  return () => {
    alive = false;
    clearTimeout(slowTimer);
    closeSheet?.();
  };
}
