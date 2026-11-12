// The frame every room shares: top bar, who is here, settings, and the way in.

import { h, iconButton, mount, inputRow, segmented, toggle, openSheet, toast } from "./dom.js";
import { applyTheme, currentTheme } from "./theme.js";
import { showJoin } from "./join.js";
import { mountTextRoom } from "./text-room.js";
import { RoomSession } from "../sync/session.js";
import { getSettings, setSetting, rememberRoom, roomEntry, forgetRoom } from "../identity.js";
import { memberColor, PALETTE } from "../core/paint.js";
import { memberOps, makeVerifier, validPin } from "../core/room.js";

/** Theme, and optionally the two colour switches. Shared by home and room settings. */
export function displaySettings(app, { withColors }) {
  const settings = getSettings(app.store);
  const change = (key, value) => {
    setSetting(app.store, key, value);
    if (key === "theme") applyTheme(value);
    app.events.emit("settings");
  };
  return h("div", { class: "form" },
    h("div", { class: "row" }, h("span", { class: "label", text: "화면 밝기" }),
      segmented([["system", "기기 설정"], ["light", "밝게"], ["dark", "어둡게"]], settings.theme, (v) => change("theme", v), "themeChoice")),
    withColors && toggle("set-colors", "사람마다 다른 색으로 보기", settings.colors, (on) => change("colors", on)),
    withColors && toggle("set-mixing", "색 섞기", settings.mixing, (on) => change("mixing", on)));
}

export function showRoom(app, roomId) {
  const root = app.root;
  let alive = true;
  let session = null;
  const offs = [];

  const centered = (id, title, text, action) => h("div", { class: "center field daily", id },
    h("div", { class: "bar", style: { padding: "0", marginLeft: "-0.6rem" } }, iconButton("back", "back", "홈으로", () => app.go(""))),
    h("h1", { text: title }), text && h("p", { text }), action);

  mount(root, centered("opening", "방을 여는 중이에요", null));
  const slowTimer = setTimeout(() => {
    if (alive && !app.session) mount(root, centered("opening", "방을 여는 중이에요", "아직 연결 중"));
  }, 2000);

  (async () => {
    const transport = await app.ready;
    if (!alive) return;
    if (app.handoff && app.handoff.roomId === roomId) session = app.handoff;
    else {
      const opened = new RoomSession({ transport, roomId, store: app.store });
      const result = await opened.open();
      if (!alive) return void opened.close();
      if (result === "missing") return void mount(root, centered("missing", "방을 찾을 수 없어요", "코드나 링크를 다시 확인해 주세요."));
      session = opened;
    }
    app.handoff = null;
    app.session = session;
    const entry = roomEntry(app.store, roomId);
    const known = entry?.memberId && (session.room.member(entry.memberId) || !session.room.members().length);
    if (known) enter(entry.memberId);
    else offs.push(showJoin(app, session, enter));
  })().catch((err) => {
    console.warn(err);
    if (alive) mount(root, centered("failed", "방을 열지 못했어요", "연결을 확인하고 다시 해 주세요.",
      h("button", { class: "btn small", type: "button", text: "다시 열기", onclick: () => app.go("r-" + roomId) })));
  });

  function enter(memberId) {
    if (!alive) return;
    session.setMe(memberId);
    const remember = () => rememberRoom(app.store, {
      id: roomId, kind: session.room.meta("kind") || "daily-text", name: session.room.meta("name") || "방", memberId,
    });
    remember();
    session.setPresence({ m: memberId });

    const title = h("h1", { id: "room-title" });
    const people = h("div", { class: "people", id: "people" });
    const status = h("span", { class: "status", id: "status", role: "img" });
    const banner = h("div", { class: "banner", id: "banner", role: "status", hidden: true });
    const body = h("div", { class: "room-body", id: "room-body" });

    const drawTitle = () => { title.textContent = session.room.meta("name") || "방"; };
    const drawPeople = () => {
      const here = [memberId, ...session.peers.map((p) => p.state?.m)].filter((id, i, all) => typeof id === "string" && all.indexOf(id) === i);
      mount(people, here.map((id) => session.room.member(id)).filter(Boolean)
        .map((m) => h("span", { class: "dot", title: m.name, style: { background: memberColor(m.color, currentTheme()) } })));
    };
    const drawStatus = () => {
      status.dataset.status = session.status;
      status.setAttribute("aria-label", session.status === "online" ? "연결됨" : "연결이 끊겼어요. 쓴 글은 기기에 남아 있어요");
    };
    const notices = { readOnly: false, unknown: session.room.unknown.length > 0 };
    const drawBanner = () => {
      notices.readOnly = !!app.transport.readOnly;
      const text = notices.readOnly ? "보기만 할 수 있어요"
        : app.transport.full ? "저장 공간이 가득 찼어요"
        : notices.unknown ? "새 버전이 있어요. 새로고침해 주세요" : "";
      banner.textContent = text;
      banner.hidden = !text;
    };

    mount(root, h("div", { class: "room field daily" },
      h("header", { class: "bar" },
        iconButton("back", "back", "홈으로", () => app.go("")),
        title, status, people,
        iconButton("room-settings", "more", "방 설정", openSettings)),
      banner, body));
    drawTitle();
    drawPeople();
    drawStatus();

    offs.push(
      session.on("change", ({ doc }) => {
        if (doc !== "room") return;
        drawTitle();
        drawPeople();
        remember();
      }),
      session.on("peers", drawPeople),
      session.on("status", () => { drawStatus(); drawBanner(); }),
      session.on("sent", drawBanner),
      session.on("unknown", () => { notices.unknown = true; drawBanner(); }),
      app.events.on("settings", drawPeople),
      mountTextRoom(body, app, session),
    );
    drawBanner();
  }

  function openSettings() {
    const me = session.me;
    if (!me) return;
    openSheet(root, "방 설정", (panel, close) => {
      const set = (fields) => session.commit("room", memberOps(session.clock, me.id, fields));
      const isOwner = session.room.meta("createdBy") === me.id;

      const roomName = inputRow("set-room", "방 이름", { maxLength: 30, value: session.room.meta("name") || "", disabled: !isOwner,
        onchange: () => { const v = roomName.input.value.trim(); if (v) session.commit("room", [{ t: "meta", id: session.clock.next(), k: "name", v }]); } });
      const myName = inputRow("set-name", "내 별명", { maxLength: 20, value: me.name,
        onchange: () => { const v = myName.input.value.trim(); if (v && v !== session.me.name) set({ name: v }); } });
      const swatches = h("div", { class: "swatches" }, PALETTE.map((_, i) =>
        h("button", { class: "swatch", type: "button", data: { color: String(i) }, "aria-label": "색 " + (i + 1), "aria-pressed": String(i === me.color),
          style: { background: memberColor(i, currentTheme()) },
          onclick: () => { set({ color: i }); for (const b of swatches.children) b.setAttribute("aria-pressed", String(b.dataset.color === String(i))); } })));
      const pin = h("input", { class: "input", id: "set-pin", type: "text", inputMode: "numeric", maxLength: 5, autocomplete: "off", placeholder: me.pin ? "새 코드" : "숫자 5자리" });
      const pinError = h("p", { class: "error", id: "pin-error", role: "alert" });
      const savePin = async () => {
        const code = pin.value.trim();
        if (!validPin(code)) return void (pinError.textContent = "개인 식별 코드는 숫자 5자리예요.");
        pinError.textContent = "";
        set({ pin: await makeVerifier(code) });
        app.store.set("last", { name: session.me.name, pin: code });
        pin.value = "";
        toast(root, "개인 식별 코드를 저장했어요");
      };

      const info = app.transport.info();
      const facts = [["전송 방식", info.kind], ["저장소", info.db], ["실시간 채널", info.live], ["접속 중인 화면", String(session.peers.length)],
        ["아직 못 보낸 기록", String(session.pending)], ["마지막 오류", session.lastError || info.lastError || "없음"], ["버전", app.version]];

      panel.append(
        h("div", { class: "form" }, isOwner && roomName.row, myName.row,
          h("div", { class: "row" }, h("span", { class: "label", text: "내 색" }), swatches),
          h("div", { class: "row" }, h("label", { for: "set-pin", text: me.pin ? "개인 식별 코드 바꾸기" : "개인 식별 코드 정하기" }),
            h("div", { class: "with-btn" }, pin, h("button", { class: "btn small", id: "save-pin", type: "button", text: "저장", onclick: savePin })),
            pinError,
            h("p", { class: "help", text: "다른 기기에서 내 이름을 고르고 이 코드를 넣으면 같은 사람으로 들어와요." }))),
        h("div", { class: "section" }, h("p", { class: "section-title", text: "화면" }), displaySettings(app, { withColors: true })),
        h("div", { class: "section" }, h("p", { class: "section-title", text: "초대" }),
          h("div", { class: "form" },
            h("p", { class: "help", text: "다른 기기의 홈에서 '코드로 들어가기'에 이 코드를 넣어요." }),
            h("div", { class: "with-btn", style: { alignItems: "center" } },
              h("span", { class: "code", id: "room-code", style: { flex: "1" }, text: roomId }),
              h("button", { class: "btn small quiet", id: "copy-code", type: "button", text: "코드 복사", onclick: () => {
                Promise.resolve().then(() => navigator.clipboard.writeText(roomId))
                  .then(() => toast(root, "코드를 복사했어요"), () => toast(root, "코드를 길게 눌러 복사해 주세요"));
              } })))),
        h("div", { class: "section" }, h("p", { class: "section-title", text: "연결 진단" }),
          h("dl", { class: "diag", id: "diag" }, facts.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })]))),
        h("div", { class: "section" },
          h("button", { class: "btn quiet", id: "leave", type: "button", text: "방 나가기", onclick: () => { close(); forgetRoom(app.store, roomId); app.go(""); } }),
          h("p", { class: "help", style: { marginTop: "0.5rem" }, text: "내 목록에서만 빠져요. 방과 글은 그대로 남아요." })));
    });
  }

  return () => {
    alive = false;
    clearTimeout(slowTimer);
    for (const off of offs) off?.();
    session?.close();
    if (app.session === session) app.session = null;
  };
}
