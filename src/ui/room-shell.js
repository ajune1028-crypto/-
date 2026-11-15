// The frame every room shares: top bar, who is here, settings, and the way in.

import { shrinkPhoto } from "./photo.js";
import { watchPickers } from "./picker-watch.js";
import { fileOps } from "../core/files.js";
import { fromBase64 } from "../core/b64.js";
import { h, icon, iconButton, mount, inputRow, segmented, toggle, openSheet, toast } from "./dom.js";
import { applyTheme, applyAccent, applyTextScale, currentTheme, ACCENTS, TEXT_SIZES } from "./theme.js";
import { showJoin } from "./join.js";
import { kindInfo, sideOf } from "./kinds.js";
import { openReference } from "./reference.js";
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
    if (key === "accent") applyAccent(value);
    if (key === "textScale") applyTextScale(value);
    app.events.emit("settings");
  };
  // Your own colour: the presets, and a colour well for any colour at all.
  const current = settings.accent || ACCENTS.find(([key]) => key === "blue")[2];
  const accents = h("div", { class: "swatches", id: "accents", role: "group", "aria-label": "포인트 색" });
  const paintAccents = (hex) => { for (const b of accents.querySelectorAll("[data-accent]")) b.setAttribute("aria-pressed", String(b.dataset.accent === hex)); };
  for (const [key, name, hex] of ACCENTS) {
    accents.append(h("button", { class: "swatch", type: "button", data: { accent: hex, key }, "aria-label": name, title: name, style: { background: hex },
      onclick: () => { change("accent", key === "blue" ? null : hex); paintAccents(hex); } }));
  }
  const well = h("input", { type: "color", id: "accent-own", value: current, "aria-label": "직접 고르기",
    oninput: () => { change("accent", well.value); paintAccents(well.value); } });
  accents.append(h("span", { class: "swatch own", data: { accent: ACCENTS.some(([, , hex]) => hex === current) ? "" : current }, title: "직접 고르기" }, well));
  paintAccents(current);
  return h("div", { class: "form" },
    h("div", { class: "row" }, h("span", { class: "label", text: "화면 밝기" }),
      segmented([["system", "기기 설정"], ["light", "밝게"], ["dark", "어둡게"]], settings.theme, (v) => change("theme", v), "themeChoice")),
    h("div", { class: "row" }, h("span", { class: "label", text: "글라스 색 (밝게·어둡게 모두 같은 색)" }), accents),
    h("div", { class: "row" }, h("span", { class: "label", text: "글자 크기" }),
      segmented(TEXT_SIZES.map(([v, name]) => [String(v), name, "text-" + String(v).replace(".", "-")]), String(settings.textScale || 1), (v) => change("textScale", Number(v)), "textSize")),
    toggle("set-reference", "레퍼런스 기능 (나만 보는 메모)", settings.reference, (on) => change("reference", on)),
    withColors && toggle("set-colors", "사람마다 다른 색으로 보기", settings.colors, (on) => change("colors", on)),
    withColors && toggle("set-mixing", "색 섞기", settings.mixing, (on) => change("mixing", on)));
}

/** How this view is connected, and what happened on the way. Shown on home and in a room. */
export function diagnostics(app, session) {
  const transport = session?.transport || app.transport;
  const info = transport ? transport.info() : null;
  const facts = [
    ["전송 방식", info ? info.kind : "연결 중"],
    ["저장소", info ? info.db : "-"],
    ["실시간 채널", info ? info.live : "-"],
    session && ["접속 중인 화면", String(session.peers.length)],
    session && ["아직 못 보낸 기록", String(session.pending)],
    ["마지막 오류", session?.lastError || info?.lastError || "없음"],
    ["버전", app.version],
    ["기록", app.traceText() || "없음"],
  ].filter(Boolean);
  return h("dl", { class: "diag", id: "diag" }, facts.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })]));
}

/** 배경: grainy gradients a room can take (or a photo of its own). */
export const BACKGROUNDS = [[1, "노을"], [2, "바다"], [3, "숲"], [4, "라벤더"], [5, "밤하늘"], [6, "복숭아"]];
const BG_PHOTO_CHARS = 600000; // about 450 kB of JPEG, in 15 parts

export function showRoom(app, roomId) {
  const root = app.root;
  let alive = true;
  let session = null;
  let screen = {};
  const offs = [];

  const centered = (id, title, text, action) => h("div", { class: "center field daily", id },
    h("div", { class: "bar", style: { padding: "0", marginLeft: "-0.6rem" } }, iconButton("back", "back", "홈으로", () => app.go(""))),
    h("h1", { text: title }), text && h("p", { text }), action);

  mount(root, centered("opening", "방을 여는 중이에요", null));
  const slowTimer = setTimeout(() => {
    if (alive && !app.session) mount(root, centered("opening", "방을 여는 중이에요", "아직 연결 중"));
  }, 2000);

  (async () => {
    const transport = await app.transportFor(roomId);
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
    app.trace("room did not open: " + (err?.code || err?.message || err));
    if (alive) mount(root, centered("failed", "방을 열지 못했어요", "연결을 확인하고 다시 해 주세요.",
      h("button", { class: "btn small", type: "button", text: "다시 열기", onclick: () => app.go("r-" + roomId) })));
  });

  function enter(memberId) {
    if (!alive) return;
    session.setMe(memberId);
    const remember = () => rememberRoom(app.store, {
      id: roomId, kind: session.room.meta("kind") || "daily-text", name: session.room.meta("name") || "방", memberId,
      people: session.room.members().map((m) => m.color),
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
      notices.readOnly = !!session.transport.readOnly;
      const text = isLocal() ? "이 기기에만 있는 방이에요. 다른 기기와는 연결되지 않아요."
        : notices.readOnly ? "보기만 할 수 있어요"
        : session.transport.full ? "저장 공간이 가득 찼어요"
        : notices.unknown ? "새 버전이 있어요. 새로고침해 주세요" : "";
      banner.textContent = text;
      banner.hidden = !text;
    };

    const kind = session.room.meta("kind") || "daily-text";
    const top = h("div", { class: "room-top", id: "room-top" });
    // The room's background lies behind everything (over the colour field, under its grain).
    const backdrop = h("div", { class: "room-bg", id: "room-bg", "aria-hidden": "true" });
    let bgUrl = null;
    let bgShown = null;
    const drawBackground = async () => {
      const bg = session.room.meta("bg") || null;
      const key = JSON.stringify(bg);
      const roomEl = backdrop.parentElement;
      if (!roomEl || key === bgShown) return;
      const show = (preset, url) => {
        if (bgUrl && bgUrl !== url) URL.revokeObjectURL(bgUrl);
        bgUrl = url;
        if (preset) backdrop.dataset.bg = String(preset);
        else delete backdrop.dataset.bg;
        backdrop.style.backgroundImage = url ? `url("${url}")` : "";
        roomEl.classList.toggle("has-bg", !!(preset || url));
        bgShown = key;
      };
      if (!bg) return void show(null, null);
      if (bg.p) return void show(bg.p, null);
      if (!bg.f) return;
      // A photo: once all its parts have come (each change of the files calls this again).
      const files = await session.load("files");
      const file = files.file(bg.f);
      if (!file || !alive || JSON.stringify(session.room.meta("bg") || null) !== key) return;
      show(null, URL.createObjectURL(new Blob([fromBase64(file.data)], { type: file.type })));
    };
    offs.push(() => { if (bgUrl) URL.revokeObjectURL(bgUrl); });
    mount(root, h("div", { class: "room field " + sideOf(kind), data: { kind } },
      backdrop,
      h("header", { class: "bar" },
        iconButton("back", "back", "홈으로", () => app.go("")),
        title, status, people,
        getSettings(app.store).reference && iconButton("room-reference", "book", "레퍼런스 (나만 보기)", () => openReference(app, { insert: screen.insertText || null, insertSound: screen.insertSound || null, roomId })),
        iconButton("invite", "invite", "친구 초대", openInvite),
        iconButton("room-settings", "more", "방 설정", openSettings)),
      banner, top, body));
    drawTitle();
    drawPeople();
    drawStatus();
    drawBackground();

    offs.push(
      session.on("change", ({ doc }) => {
        if (doc === "files") return void drawBackground();
        if (doc !== "room") return;
        drawBackground();
        drawTitle();
        drawPeople();
        remember();
      }),
      session.on("peers", drawPeople),
      session.on("status", () => { drawStatus(); drawBanner(); }),
      session.on("sent", drawBanner),
      session.on("unknown", () => { notices.unknown = true; drawBanner(); }),
      app.events.on("settings", drawPeople),
    );
    // The kind's own screen goes into the body. A kind this version does not know says so.
    const info = kindInfo(kind);
    const made = info?.mount ? info.mount(body, app, session, { top }) : unsupported(body);
    screen = typeof made === "function" ? { close: made } : made || {};
    offs.push(() => screen.close?.());
    drawBanner();
    if (app.fresh === roomId) openInvite();
    app.fresh = null;
  }

  const isLocal = () => !!roomEntry(app.store, roomId)?.local;

  function unsupported(body) {
    body.append(h("div", { class: "center", id: "unsupported" },
      h("h1", { text: "이 방은 새 버전에서 열려요" }),
      h("p", { text: "새로고침하면 열 수 있을 거예요." })));
    return () => {};
  }

  function copy(text, done, failed) {
    // The clipboard may refuse (it does in some frames); the text stays on screen to long-press.
    Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => toast(root, done), () => toast(root, failed));
  }

  function openInvite() {
    openSheet(root, "친구 초대", (panel, close) => {
      if (isLocal()) {
        return void panel.append(h("div", { class: "form" },
          h("p", { class: "help", id: "invite-local", text: "이 방은 이 기기에만 있어서 링크로 초대할 수 없어요." }),
          h("button", { class: "btn quiet", id: "invite-done", type: "button", text: "닫기", onclick: close })));
      }
      const link = app.linkFor(roomId);
      const name = session.room.meta("name") || "방";
      // The system share sheet exists on phones outside the trial page, which refuses it.
      const canSend = !app.shareBase() && typeof navigator.share === "function";
      const send = () => Promise.resolve().then(() => navigator.share({ title: name, text: name + " 방으로 들어와요", url: link }))
        .catch((err) => { if (err?.name !== "AbortError") copy(link, "링크를 복사했어요", "링크를 길게 눌러 복사해 주세요"); });
      panel.append(h("div", { class: "form" },
        h("p", { class: "help", text: "이 링크를 받은 사람은 바로 이 방으로 들어와요." }),
        h("p", { class: "link-box", id: "invite-link", text: link }),
        h("div", { class: "btn-row" },
          canSend && h("button", { class: "btn", id: "send-link", type: "button", text: "보내기", onclick: send }),
          h("button", { class: canSend ? "btn quiet" : "btn", id: "copy-link", type: "button", text: "링크 복사",
            onclick: () => copy(link, "링크를 복사했어요", "링크를 길게 눌러 복사해 주세요") })),
        h("div", { class: "row" }, h("span", { class: "label", text: "링크 대신 홈의 '코드로 들어가기'에 넣는 방 코드" }),
          h("div", { class: "with-btn", style: { alignItems: "center" } },
            h("span", { class: "code", id: "invite-code", style: { flex: "1" }, text: roomId }),
            h("button", { class: "btn small quiet", id: "copy-invite-code", type: "button", text: "코드 복사",
              onclick: () => copy(roomId, "코드를 복사했어요", "코드를 길게 눌러 복사해 주세요") }))),
        app.shareBase() && h("p", { class: "help", id: "invite-note", text: "시험판이라 Claude에서 이 페이지를 공유받은 사람만 들어올 수 있어요." }),
        h("button", { class: "btn quiet", id: "invite-done", type: "button", text: "닫기", onclick: close })));
    });
  }

  /** 배경: none, a grainy gradient, or a photo; for the whole room, and anyone may change it. */
  function backgroundSection() {
    const now = session.room.meta("bg") || null;
    const setBg = (v) => {
      session.commit("room", [{ t: "meta", id: session.clock.next(), k: "bg", v }]);
      for (const b of choices.children) {
        const on = b.id === "bg-none" ? !v : b.id === "bg-photo" ? !!v?.f : v?.p === Number(b.dataset.bg);
        b.setAttribute("aria-pressed", String(on));
      }
    };
    const input = h("input", { type: "file", accept: "image/*", id: "bg-file", class: "vh", tabindex: "-1" });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file || !session) return;
      toast(root, "배경을 넣는 중이에요…");
      const photo = await shrinkPhoto(file, BG_PHOTO_CHARS, [1600, 1280, 1024, 800]).catch(() => null);
      if (!photo) return void toast(root, "이 사진은 읽을 수 없어요", 3200);
      const made = fileOps(session.clock, { type: "image/jpeg", data: photo.data.slice(photo.data.indexOf(",") + 1), by: session.memberId });
      session.commit("files", made.ops);
      setBg({ f: made.id });
      toast(root, "배경을 바꿨어요");
    });
    const stopWatch = watchPickers([input], () => toast(root, "사진 고르는 창이 열리지 않았어요. Claude 앱이라면 크롬에서 같은 방을 열어 주세요.", 4200));
    offs.push(stopWatch);
    const choices = h("div", { class: "bg-choices", id: "bg-choices" },
      h("button", { class: "bg-choice none", type: "button", id: "bg-none", "aria-pressed": String(!now), text: "없음", onclick: () => setBg(null) }),
      ...BACKGROUNDS.map(([n, name]) => h("button", { class: "bg-choice", type: "button", id: "bg-" + n, data: { bg: String(n) }, "aria-label": name, title: name, "aria-pressed": String(now?.p === n), onclick: () => setBg({ p: n }) })),
      h("label", { class: "bg-choice photo", id: "bg-photo", for: "bg-file", role: "button", "aria-pressed": String(!!now?.f) }, icon("photo"), "내 사진"));
    return h("div", { class: "section" }, h("p", { class: "section-title", text: "배경" }), input, choices,
      h("p", { class: "help", text: "방 전체에 보여요. 방에 있는 누구나 바꿀 수 있어요." }));
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

      panel.append(
        h("div", { class: "form" }, isOwner && roomName.row, myName.row,
          h("div", { class: "row" }, h("span", { class: "label", text: "내 색" }), swatches),
          h("div", { class: "row" }, h("label", { for: "set-pin", text: me.pin ? "개인 식별 코드 바꾸기" : "개인 식별 코드 정하기" }),
            h("div", { class: "with-btn" }, pin, h("button", { class: "btn small", id: "save-pin", type: "button", text: "저장", onclick: savePin })),
            pinError,
            h("p", { class: "help", text: "다른 기기에서 내 이름을 고르고 이 코드를 넣으면 같은 사람으로 들어와요." }))),
        backgroundSection(close),
        h("div", { class: "section" }, h("p", { class: "section-title", text: "화면" }), displaySettings(app, { withColors: true })),
        screen.settings?.(close),
        h("div", { class: "section" }, h("p", { class: "section-title", text: "초대" }),
          h("div", { class: "form" },
            h("p", { class: "help", text: "다른 기기의 홈에서 '코드로 들어가기'에 이 코드를 넣어요." }),
            h("div", { class: "with-btn", style: { alignItems: "center" } },
              h("span", { class: "code", id: "room-code", style: { flex: "1" }, text: roomId }),
              h("button", { class: "btn small quiet", id: "copy-code", type: "button", text: "코드 복사",
                onclick: () => copy(roomId, "코드를 복사했어요", "코드를 길게 눌러 복사해 주세요") })))),
        h("div", { class: "section" }, h("p", { class: "section-title", text: "연결 진단" }), diagnostics(app, session)),
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
