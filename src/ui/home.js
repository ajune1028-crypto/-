// Home: two halves side by side. 일상 on the left, 창작 on the right.

import { h, icon, iconButton, mount, inputRow, openSheet, formBox } from "./dom.js";
import { displaySettings, diagnostics } from "./room-shell.js";
import { rememberRoom } from "../identity.js";
import { RoomSession } from "../sync/session.js";
import { newRoomId, newMemberId, makeVerifier, validPin, createRoomOps } from "../core/room.js";
import { dayKey, dayLabel, hourLabel } from "../core/time.js";
import { SIDES, kindsOf, sideOf, kindInfo } from "./kinds.js";
import { openReference } from "./reference.js";
import { getSettings } from "../identity.js";

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

  // A room's row says what kind of room it is, so a whiteboard is told from a song room at a glance.
  function roomRow(room, when) {
    const kind = kindInfo(room.kind);
    return h("button", { class: "room-row", type: "button", data: { id: room.id, roomKind: room.kind || "daily-text" }, onclick: () => app.go("r-" + room.id) },
      h("span", { class: "room-name", text: room.name }),
      h("span", { class: "room-meta" },
        h("span", { class: "room-kind" }, icon(kind?.icon || "lines"), kind?.name || "새 버전의 방"),
        when && h("span", { class: "room-when", text: when })));
  }

  function half(side, title, note, emptyText) {
    const mine = app.store.get("rooms", []).filter((r) => sideOf(r.kind) === side).sort((a, b) => b.at - a.at);
    const known = new Set(app.store.get("rooms", []).map((r) => r.id));
    const elsewhere = others.filter((r) => sideOf(r.kind) === side && !known.has(r.id));
    return h("section", { class: "half field " + side, data: { side } },
      h("div", { class: "half-scroll" },
        h("h1", { class: "half-title", text: title }),
        h("p", { class: "half-note", text: note }),
        mine.length
          ? h("div", { class: "rooms" }, mine.map((r) => roomRow(r, r.local ? "이 기기만" : whenLabel(r.at))))
          : h("p", { class: "empty", text: emptyText }),
        elsewhere.length > 0 && [
          h("p", { class: "group-label", text: "다른 기기에서 만든 방" }),
          h("div", { class: "rooms", id: side === "daily" ? "others" : "others-creative" }, elsewhere.map((r) => roomRow(r))),
        ]),
      h("button", { class: "add", id: "add-" + side, type: "button", "aria-label": title + " 방 만들기", onclick: () => chooseKind(side) }, icon("plus")));
  }

  function draw() {
    if (!alive) return;
    const serverKind = app.transport?.info().kind;
    const notice = app.limited
      ? (!app.store.available ? "다른 기기와 연결되지 않아요. 이 화면을 닫으면 여기서 만든 방은 사라져요"
        : serverKind === "firebase" ? "서버에 연결하지 못해서 방을 이 기기에만 만들었어요. 인터넷을 확인해 주세요"
        : "아직 서버가 없어서 방은 이 기기에만 있어요")
      : app.store.available ? null : "이 기기에는 방 목록이 저장되지 않아요";
    // The notice takes its own row above the halves, so it never lies over a button.
    mount(root,
      notice && h("div", { class: "notice", id: "notice", role: "status", text: notice }),
      h("div", { class: "home-wrap" },
        h("div", { class: "home", id: "home" },
          half("daily", SIDES.daily.title, SIDES.daily.note, "아직 방이 없어요. 아래 +로 만들어 보세요."),
          half("creative", SIDES.creative.title, SIDES.creative.note, "아직 방이 없어요. 아래 +로 노래 방을 만들어 보세요.")),
        h("div", { class: "home-top" },
          getSettings(app.store).reference && iconButton("home-reference", "book", "레퍼런스 (나만 보기)", () => openReference(app)),
          iconButton("home-settings", "more", "설정", openSettings)),
        h("div", { class: "home-foot" },
          slow && h("span", { class: "hint", id: "connecting", text: "아직 연결 중" }),
          h("button", { class: "pill", id: "by-code", type: "button", text: "코드로 들어가기", onclick: openCode }))));
  }

  function sheet(title, build) {
    closeSheet?.();
    closeSheet = openSheet(root, title, build);
  }

  function chooseKind(side) {
    sheet("어떤 방을 만들까요?", (panel, close) => {
      panel.append(h("div", { class: "kinds" }, kindsOf(side).map((k) =>
        h("button", { class: "kind", type: "button", data: { kind: k.kind }, disabled: !k.mount, onclick: () => { close(); roomForm(k); } },
          h("span", { class: "kind-icon" }, icon(k.icon)),
          h("span", { class: "kind-name" }, k.name, h("span", { class: "kind-note", text: k.note })),
          !k.mount && h("span", { class: "soon", text: "준비 중" })))));
    });
  }

  function roomForm({ kind, name: kindName }) {
    sheet("새 " + kindName + " 방", (panel, close) => {
      const last = app.store.get("last", {});
      const room = inputRow("room-name", "방 이름", { maxLength: 30, placeholder: "예: 우리 둘" });
      const me = inputRow("my-name", "내 별명", { maxLength: 20, value: last.name || "" });
      const pin = inputRow("my-pin", "개인 식별 코드 (숫자 5자리, 안 정해도 돼요)", { maxLength: 5, inputMode: "numeric", value: last.pin || "" });
      const error = h("p", { class: "error", id: "form-error", role: "alert" });
      const status = h("p", { class: "help", id: "form-status", role: "status" });
      const button = h("button", { class: "btn", id: "create-room", type: "button", text: "방 만들기", onclick: submit });
      panel.append(formBox(submit, room.row, me.row, pin.row,
        h("p", { class: "help", text: "코드가 있으면 다른 기기에서도 같은 사람, 같은 색으로 들어올 수 있어요." }), error, button, status));

      /** Makes the room on one transport and opens it. */
      async function make(transport, id, roomName) {
        await transport.createRoom({ id, kind, name: roomName });
        const session = new RoomSession({ transport, roomId: id, store: app.store });
        try {
          if ((await session.open()) !== "ok") throw new Error("room did not open");
        } catch (err) {
          session.close();
          throw err;
        }
        return session;
      }

      async function submit() {
        if (button.disabled) return;
        const roomName = room.input.value.trim();
        const myName = me.input.value.trim();
        const code = pin.input.value.trim();
        if (!roomName) return void (error.textContent = "방 이름을 적어 주세요.");
        if (!myName) return void (error.textContent = "내 별명을 적어 주세요.");
        if (code && !validPin(code)) return void (error.textContent = "개인 식별 코드는 숫자 5자리예요.");
        error.textContent = "";
        button.disabled = true;
        try {
          status.textContent = "연결하는 중…";
          const shared = await app.ready;
          const id = newRoomId();
          const sharedKind = shared.info().kind;
          let session;
          // A room made while this view has no shared store lives on this device only.
          let local = sharedKind === "local" && app.limited;
          status.textContent = "방을 만드는 중…";
          try {
            session = await make(shared, id, roomName);
            if (sharedKind !== "local") app.limited = false;
          } catch (err) {
            if (sharedKind === "local") throw err;
            // The shared store did not take the room. Writing should still be possible, so the
            // room is made on this device, and the screens say that it is not shared.
            app.trace("create: no shared room (" + (err?.code || err?.message || err) + "), made on this device");
            shared.dropRoom?.(id);
            app.limited = true;
            local = true;
            session = await make(app.local(), id, roomName);
          }
          const memberId = newMemberId();
          session.commit("room", createRoomOps(session.clock, {
            kind, name: roomName, tz: localZone(), now: Date.now(), memberId, memberName: myName,
            pin: code ? await makeVerifier(code) : null,
          }));
          rememberRoom(app.store, { id, kind, name: roomName, memberId, local });
          app.store.set("last", { name: myName, pin: code });
          app.handoff = session;
          app.fresh = local ? null : id;
          close();
          app.go("r-" + id);
        } catch (err) {
          console.warn(err);
          app.trace("create failed: " + (err?.code || err?.message || err));
          button.disabled = false;
          status.textContent = "";
          error.textContent = "방을 만들지 못했어요. 잠시 뒤에 다시 해 주세요.";
        }
      }
    });
  }

  function openCode() {
    sheet("코드로 들어가기", (panel, close) => {
      const code = inputRow("code", "방 코드", { maxLength: 20, autocapitalize: "off", placeholder: "영문과 숫자 12자리" });
      const error = h("p", { class: "error", id: "form-error", role: "alert" });
      const button = h("button", { class: "btn", id: "open-code", type: "button", text: "들어가기", onclick: submit });
      panel.append(formBox(submit, code.row,
        h("p", { class: "help", text: "방 안의 설정에서 코드를 볼 수 있어요." }), error, button));

      async function submit() {
        if (button.disabled) return;
        const id = code.input.value.toLowerCase().replace(/[^a-z2-7]/g, "");
        button.disabled = true;
        let found = false;
        try {
          const channel = id.length === 12 ? await (await app.ready).openRoom(id) : null;
          found = !!channel;
          channel?.close();
        } catch (err) {
          console.warn(err);
          app.trace("code lookup failed: " + (err?.code || err?.message || err));
        }
        button.disabled = false;
        if (!found) return void (error.textContent = "그 코드의 방을 찾을 수 없어요.");
        close();
        app.go("r-" + id);
      }
    });
  }

  function openSettings() {
    sheet("설정", (panel) => panel.append(
      displaySettings(app, { withColors: false }),
      h("div", { class: "section" }, h("p", { class: "section-title", text: "연결 진단" }), diagnostics(app, null))));
  }

  draw();
  const slowTimer = setTimeout(() => {
    if (!app.connecting) return;
    slow = true;
    draw();
  }, 1500);
  app.ready
    .then((transport) => transport.listRooms().then(
      (list) => {
        others = list;
        app.trace("rooms: " + list.length);
      },
      (err) => {
        console.warn(err);
        app.trace("rooms: not readable (" + (err?.code || err?.message || err) + ")");
        // Without the list the shared store is out of reach for now; say so.
        if (transport.info().kind !== "local") app.limited = true;
      }))
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
