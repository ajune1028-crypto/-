// Home: two halves side by side. 일상 on the left, 창작 on the right.

import { h, icon, iconButton, mount, inputRow, openSheet, formBox, toast, toggle } from "./dom.js";
import { openHouseArc } from "./house-arc.js";
import { duplicateRoom, putIntoBoard, putRoomIntoSong, roomHistory } from "./room-actions.js";
import { displaySettings, diagnostics } from "./room-shell.js";
import { rememberRoom, forgetRoom } from "../identity.js";
import { validPreview } from "../core/preview.js";
import { inkColor } from "./ink.js";
import { RoomSession } from "../sync/session.js";
import { newRoomId, newMemberId, makeVerifier, validPin, createRoomOps } from "../core/room.js";
import { SIDES, kindsOf, sideOf, kindInfo } from "./kinds.js";
import { openReference } from "./reference.js";
import { myCode, myCodeSection, openMyCodeIntro } from "./my-code.js";
import { gesturesPage, hintOnce } from "./gestures.js";
import { burst } from "./motion.js";
import { roomKeyFrom, keyText, validRoomPassword } from "../core/lock.js";
import { sealedTransport } from "../sync/sealed.js";
import { refSounds } from "../reference.js";
import { getSettings, setSetting } from "../identity.js";
import { starred, toggleStar, houses, putInHouse, houseOf, takeOutOfHouse } from "../houses.js";
import { openHomePanel, houseShape, lastPanelEdge, rememberPanelEdge } from "./home-panel.js";

// Whether 찾기와 집 opens at its edge or as a window of its own (its top-right button chooses).
const PANEL_MODE = "homePanelMode";
import { glowEdge, aimMarker } from "./edge-glow.js";
import { VelocityTracker, throwOf, throwMeant, throwReach } from "../core/fling.js";
import { buzz } from "./chime.js";
import { segmented } from "./dom.js";
import { memberColor, personColor } from "../core/paint.js";
import { currentTheme, myPeopleColor } from "./theme.js";

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// The day and the time, whatever the screen (the owner, 21 November: "화면 큰 거에서는 날짜가 안 나오기도"):
// "오늘 오전 10:02", "어제 …", "11월 20일 오후 3:02".
function whenLabel(ms) {
  return Number.isFinite(ms) ? whenText(ms) : "";
}

/**
 * What a room holds, at a glance (the owner chose 홈 미리보기): kept when the room was last left on
 * this device. Its last line; its notes as small bars along the song; its cards as a tiny map.
 */
/** "오늘 오후 3:02", "어제 오전 9:10", "11월 14일 오후 3:02", "2025년 3월 1일 …" (this device's time). */
export function whenText(ms, now = Date.now()) {
  const d = new Date(ms);
  const n = new Date(now);
  const hh = d.getHours();
  const time = `${hh < 12 ? "오전" : "오후"} ${hh % 12 === 0 ? 12 : hh % 12}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, n)) return "오늘 " + time;
  const y = new Date(n);
  y.setDate(n.getDate() - 1);
  if (sameDay(d, y)) return "어제 " + time;
  const date = `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return (d.getFullYear() === n.getFullYear() ? date : `${d.getFullYear()}년 ${date}`) + " " + time;
}

const WORK_WORDS = { 녹음: (n) => `녹음 ${n}개`, 그림: (n) => `그림 ${n}획`, 카드: (n) => `카드 ${n}장`, 게임: (n) => `게임 ${n}판`, 글: () => "글", 노래: () => "노래 다듬기", 보드: () => "보드 정리", 애니: () => "애니메이션" };

/** The room's story, as the top of its long-press sheet. */
function historyView(hist) {
  const who = (id) => hist.people.get(id);
  const name = (id) => who(id)?.name || "누군가";
  const dot = (id) => h("span", { class: "dot", style: { background: personColor(who(id), currentTheme()) } });
  const line = (label, value, id) => h("p", { class: "hist-line" }, h("span", { class: "hist-label", text: label }), h("span", { class: "hist-value" }, value));
  const parts = [];
  if (hist.createdAt) parts.push(line("시작", [whenText(hist.createdAt), hist.createdBy ? ` · ${name(hist.createdBy)}이(가) 만듦` : ""].join(""), hist.createdBy));
  parts.push(line("최근 수정", hist.lastAt ? `${whenText(hist.lastAt)} · ${name(hist.lastBy)}` : "기록이 아직 없어요 (이제부터 남아요)"));
  // Who came in: each person once, with their latest coming in and how often.
  const people = new Map();
  for (const v of hist.visits) {
    const p = people.get(v.m) || { last: v.at, count: 0 };
    p.count++;
    if (v.at > p.last) p.last = v.at;
    people.set(v.m, p);
  }
  if (people.size) {
    parts.push(h("p", { class: "hist-head", text: "들어온 사람" }));
    parts.push(h("ul", { class: "hist-people", id: "hist-people" }, [...people.entries()].sort((a, b) => b[1].last - a[1].last).map(([id, p]) =>
      h("li", { data: { member: id } }, dot(id), h("span", { class: "hist-name", text: name(id) }), h("span", { class: "hist-when", text: `${whenText(p.last)}${p.count > 1 ? ` · ${p.count}번` : ""}` })))));
  }
  // What each made, by day (newest first; a week, then 더 보기).
  if (hist.days.length) {
    parts.push(h("p", { class: "hist-head", text: "날마다" }));
    const dayView = ({ day, work }) => {
      const [, m, d] = day.split("-").map(Number);
      const byPerson = new Map();
      for (const w of work) (byPerson.get(w.m) || byPerson.set(w.m, []).get(w.m)).push(WORK_WORDS[w.k] ? WORK_WORDS[w.k](w.n) : w.k);
      return h("li", { data: { day } }, h("span", { class: "hist-day", text: `${m}월 ${d}일` }),
        h("span", { class: "hist-work" }, [...byPerson.entries()].map(([id, words]) => h("span", { class: "hist-made" }, dot(id), `${name(id)} ${words.join(" · ")}`))));
    };
    const list = h("ul", { class: "hist-days", id: "hist-days" }, hist.days.slice(0, 7).map(dayView));
    parts.push(list);
    if (hist.days.length > 7) parts.push(h("button", { class: "btn quiet small", type: "button", id: "hist-more", text: "더 보기", onclick: (e) => { list.replaceChildren(...hist.days.map(dayView)); e.currentTarget.remove(); } }));
  }
  return parts;
}

function previewOf(room) {
  const p = room.preview;
  if (!validPreview(p)) return null;
  if (p.t === "text") return h("span", { class: "room-preview room-preview-text", text: p.line });
  if (p.t === "song") {
    if (!p.notes.length && !p.clips?.length) return null;
    const pct = (v) => v / 10 + "%";
    return h("span", { class: "room-preview room-preview-song", "aria-hidden": "true" },
      (p.clips || []).map(([x, w]) => h("span", { class: "pv-clip", style: { left: pct(x), width: pct(w) } })),
      p.notes.map(([x, w, y]) => h("span", { class: "pv-note", style: { left: pct(x), width: pct(w), top: 8 + y * 0.62 + "%" } })));
  }
  const NS = "http://www.w3.org/2000/svg";
  if (p.t === "draw") {
    // The drawing's own lines in their own colours (a black line kept as it was drawn).
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "room-preview room-preview-draw");
    svg.setAttribute("viewBox", "0 0 100 60");
    svg.setAttribute("aria-hidden", "true");
    for (const [c, w, filled, ...pts] of p.lines) {
      const line = document.createElementNS(NS, filled ? "polygon" : "polyline");
      line.setAttribute("points", pts.join(" "));
      const colour = inkColor(c, true);
      line.setAttribute(filled ? "fill" : "stroke", colour);
      if (filled) line.setAttribute("stroke", "none");
      else {
        line.setAttribute("fill", "none");
        line.setAttribute("stroke-width", String(w));
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("stroke-linejoin", "round");
      }
      svg.append(line);
    }
    return svg;
  }
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "room-preview room-preview-board");
  svg.setAttribute("viewBox", "0 0 100 60");
  svg.setAttribute("aria-hidden", "true");
  for (const [x, y, w, hgt, k] of p.cards) {
    const r = document.createElementNS(NS, "rect");
    for (const [key, v] of Object.entries({ x, y, width: w, height: hgt, rx: 1.6, class: "pv-card pv-" + k })) r.setAttribute(key, v);
    svg.append(r);
  }
  return svg;
}

export function showHome(app) {
  const root = app.root;
  let alive = true;
  let others = [];
  let slow = false;
  let closeSheet = null;

  // A room's row says what kind of room it is, so a whiteboard is told from a song room at a glance.
  // A long press (or a right click) brings the room's actions: 복제, 링크 복사, 화이트보드에 넣기, 목록에서 빼기.
  /** 방 보기: cards (the room's look large, as many side by side as fit) or rows. */
  const cardView = () => getSettings(app.store).roomView === "cards";

  function roomRow(room, when, mine = false) {
    const kind = kindInfo(room.kind);
    const house = mine ? houseOf(app.store, room.id) : null;
    const isStarred = mine && starred(app.store).has(room.id);
    let held = false;
    let timer = null;
    let start = null;
    const row = h("button", { class: "room-row" + (isStarred ? " starred" : ""), type: "button", data: { id: room.id, roomKind: room.kind || "daily-text" }, onclick: (e) => {
      if (held) {
        held = false;
        e.preventDefault();
        return;
      }
      app.go("r-" + room.id);
    } },
      // The name at the very top (the owner: "방이름은 맨위에"); under it the box of what it holds, with
      // what kind of room it is as a round logo with only its icon inside the box at its top left
      // ("무슨 방인지 알려주는 그런 동그란 아이콘은 네모 안에 왼쪽 끝에 위에").
      h("span", { class: "room-name" }, room.name, house && h("span", { class: "room-house", role: "img", "aria-label": `${house.name}에 있어요`, title: house.name }, houseShape(house))),
      h("span", { class: "room-thumb" + (validPreview(room.preview) ? "" : " no-preview") },
        h("span", { class: "room-logo", role: "img", "aria-label": kind?.name || "새 버전의 방", title: kind?.name || "새 버전의 방" }, icon(kind?.icon || "lines")),
        previewOf(room)),
      h("span", { class: "room-meta" },
        when && h("span", { class: "room-when", text: when }),
        // Who is behind the door: the colours of the people in it, once it is more than me.
        room.people?.length > 1 && h("span", { class: "room-people", role: "img", "aria-label": `${room.people.length}명이 있는 방` },
          room.people.map((c) => h("span", { class: "dot", style: { background: memberColor(c, currentTheme()) } })))));
    if (!mine) return row;
    // 별표 (the owner: "별표 표시한 방은 맨 위에"): starred rooms lead their half.
    const star = h("button", { class: "room-star", type: "button", data: { star: room.id }, "aria-pressed": String(isStarred), "aria-label": isStarred ? "별표 빼기" : "별표 (맨 위에 두기)",
      onclick: (e) => {
        e.stopPropagation();
        const on = toggleStar(app.store, room.id);
        buzz(app);
        draw();
        if (on) burst(root.querySelector(`.room-star[data-star="${room.id}"]`));
        toast(root, on ? "별표: 맨 위에 둘게요" : "별표를 뺐어요", 1600);
      } }, icon("star"));
    // Held, the room lifts and the houses come up as a small world from below (ui/house-arc.js);
    // drawn onto a house it goes in, let go where it was the world stays for a tap on a house (the
    // owner, 21 November: "꾹 누르면 어디 집에 넣을지"). Its details and actions are two fingers' tap
    // (or 마우스 왼쪽·오른쪽 together, or the right button): roomMenu.
    let lift = null;
    const hold = () => {
      if (fingers.size > 1) return;
      held = true;
      clearTimeout(timer);
      // With 햇살 out, its own houses take the room; otherwise the world of houses rises from below.
      lift = { x: start.x, y: start.y, moved: false, over: null, ghost: null, dock: panelCtl?.isOpen() ? null : houseArc() };
      if (lift.dock) lift.dock.onSpin = () => { if (lift?.moved && lift.at) overAt(...lift.at); };
      row.classList.add("lifted");
      try { row.setPointerCapture(start.id); } catch { /* the pointer may be gone already */ }
      buzz(app, 10);
    };
    const endLift = ({ keep = false } = {}) => {
      row.classList.remove("lifted");
      lift?.ghost?.remove();
      lift?.over?.classList.remove("over");
      const dock = lift?.dock;
      lift = null;
      if (dock && !keep) dock.close();
    };
    const putRoom = (id) => {
      if (!id) return;
      if (id === "new") {
        if (panelCtl?.isOpen()) return void panelCtl.show({ name: "build", room: room.id });
        return void openPanel({ edge: "bottom", strength: 0.3, view: { name: "build", room: room.id } });
      }
      putInHouse(app.store, room.id, id);
      buzz(app, 14);
      draw();
      panelCtl?.isOpen() && panelCtl.refresh();
      toast(root, `'${houses(app.store).find((x) => x.id === id)?.name || "집"}'에 넣었어요`);
    };
    const dragTo = (x, y) => {
      if (!lift.moved && Math.hypot(x - lift.x, y - lift.y) < 8) return;
      if (!lift.moved) {
        lift.moved = true;
        lift.ghost = h("div", { class: "room-ghost", "aria-hidden": "true" }, icon(kind?.icon || "lines"), room.name);
        document.body.append(lift.ghost);
      }
      lift.ghost.style.translate = `${x}px ${y}px`;
      lift.at = [x, y];
      overAt(x, y);
      // Near either end of the planet, it turns to bring the houses further along.
      lift.dock?.follow(x, y);
    };
    /** The house under the finger lights up (read again as the planet turns under a still finger). */
    const overAt = (x, y) => {
      const target = document.elementFromPoint(x, y)?.closest?.(".dock-house:not(.far), .home-panel .house-tile, .home-panel[data-drop-house]") || null;
      if (target !== lift.over) {
        lift.over?.classList.remove("over");
        target?.classList.add("over");
        if (target) buzz(app, 6);
        lift.over = target;
      }
    };
    const drop = () => {
      const target = lift.over;
      const moved = lift.moved;
      const dock = lift.dock;
      if (!moved) {
        // Let go where it was held: the world stays for a tap on a house (or + for a new one).
        endLift({ keep: true });
        if (dock) dock.choose(putRoom);
        else toast(root, "집 위로 끌어다 놓아요 · 방의 자세한 것은 두 손가락으로 톡", 2600);
        return;
      }
      endLift();
      if (!target) return;
      putRoom(target.dataset.house || target.dataset.dropHouse || (target.id === "house-new" ? "new" : null));
    };
    // Two fingers on the room at once, a quick tap: its details and what can be done with it (the
    // owner, 21 November: "두 손가락으로 동시에 그 방을 누르면 그 방의 세부 정보나 상호작용").
    const fingers = new Map();
    let two = null;
    let lastKind = "mouse";
    row.addEventListener("pointerdown", (e) => {
      lastKind = e.pointerType || "mouse";
      if (e.pointerType === "touch") {
        fingers.set(e.pointerId, [e.clientX, e.clientY]);
        if (fingers.size === 2 && !lift) {
          clearTimeout(timer);
          held = true; // no tap-to-open from these fingers
          two = { at: e.timeStamp, spoiled: e.timeStamp - (two?.first ?? e.timeStamp) > 220 };
        } else if (fingers.size === 1) two = { first: e.timeStamp };
        else if (fingers.size > 2 && two) two.spoiled = true;
        if (fingers.size > 1) return;
      }
      held = false;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      clearTimeout(timer);
      if (e.button === 0) timer = setTimeout(hold, 500);
    });
    row.addEventListener("pointermove", (e) => {
      const at = fingers.get(e.pointerId);
      if (at && two?.at && Math.hypot(e.clientX - at[0], e.clientY - at[1]) > 16) two.spoiled = true;
      if (lift) return void dragTo(e.clientX, e.clientY);
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) clearTimeout(timer);
    });
    const lifted = (e) => {
      if (!fingers.delete(e.pointerId) || fingers.size) return false;
      const t = two;
      two = null;
      if (!t?.at || t.spoiled || e.type === "pointercancel" || e.timeStamp - t.at > 450) return t?.at != null;
      roomMenu(room);
      return true;
    };
    row.addEventListener("pointerup", (e) => { clearTimeout(timer); if (lifted(e)) return; if (lift) drop(); });
    row.addEventListener("pointercancel", (e) => { clearTimeout(timer); fingers.delete(e.pointerId); if (!fingers.size) two = null; if (lift) endLift(); });
    row.addEventListener("pointerleave", () => { if (!lift) clearTimeout(timer); });
    // Lifted, the finger moves the room, not the list.
    row.addEventListener("touchmove", (e) => { if (lift || fingers.size > 1) e.preventDefault(); }, { passive: false });
    // The mouse's right button (alone, or with the left held) is two fingers' tap; a finger's long
    // press may also send this (an iPad does): it is the long press, already in hand, so nothing more.
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // Chrome says what sent it; Safari does not, so the last press's kind stands in.
      if ((e.pointerType || lastKind) !== "mouse") return;
      clearTimeout(timer);
      if (lift) endLift();
      held = true;
      roomMenu(room);
    });
    return h("div", { class: "room-cell" }, row, star);
  }

  /** The world of houses that rises while a room is held (ui/house-arc.js). */
  function houseArc() {
    return openHouseArc({ houses: houses(app.store), shapeOf: houseShape });
  }

  // ---- ⋮: 찾기와 집 ---------------------------------------------------------------------------

  let panelCtl = null;
  const allRooms = () => {
    const remembered = app.store.get("rooms", []);
    return [...remembered, ...others.filter((o) => !remembered.some((r) => r.id === o.id))];
  };
  /**
   * Opens 찾기와 집: tapped, where it was last (at its edge, or floating if it was left floating);
   * thrown (`thrown`), out of the edge it was thrown to. Out already, a tap puts it away, and a throw
   * sends it to that edge (the owner, 21 November: "이미 거기 방향이면은 안 눌러주고 그걸 스와이프해서
   * 그쪽으로 보내야지만"); 설정's "다시 누르면 다른 쪽으로" brings back the tap that sends it round the
   * edges. Locked, it stays.
   */
  async function openPanel({ edge, at, strength = 0.3, delay = 0, view, thrown = false } = {}) {
    if (panelCtl?.isOpen() && !view) {
      if (panelCtl.locked()) return void panelCtl.nudge();
      if (!thrown) {
        if (!panelCtl.floating && getSettings(app.store).panelCycle) {
          const order = ["right", "bottom", "left", "top"];
          const to = order[(order.indexOf(panelCtl.edge()) + 1) % order.length];
          rememberPanelEdge(app.store, { edge: to, at: 0.5 });
          return void panelCtl.moveTo(to, 0.5, strength);
        }
        return void panelCtl.close();
      }
      if (!panelCtl.floating) {
        if (edge !== panelCtl.edge()) {
          rememberPanelEdge(app.store, { edge, at: at ?? 0.5 });
          panelCtl.moveTo(edge, at ?? 0.5, strength);
          return;
        }
        // Thrown at the edge it is already on: the ball hits it there, then the light comes as ever.
        const ctl = panelCtl;
        await ctl.squash({ at: at ?? 0.5, strength, delay });
        if (alive && ctl.isOpen()) glowEdge({ edge, at: at ?? 0.5, strength, delay: 0 });
        return;
      }
      // Floating and thrown: it comes down to that edge.
      app.store.set(PANEL_MODE, "dock");
    }
    if (panelCtl?.isOpen()) panelCtl.close({ now: true });
    closeWindows("panel");
    if (!thrown && !view && app.store.get(PANEL_MODE, "dock") === "float") {
      panelCtl = openHomePanel(app, { floating: true, rooms: allRooms, changed: () => draw(), swap });
      return;
    }
    if (!edge) ({ edge, at } = lastPanelEdge(app.store));
    await glowEdge({ edge, at: at ?? 0.5, strength, delay, onImpact: () => buzz(app, 8) });
    if (!alive) return;
    panelCtl = openHomePanel(app, { edge, at: at ?? 0.5, view, rooms: allRooms, changed: () => draw(), swap });
  }

  /** The panel's own top-right button: from its edge to a window of its own, and back (remembered). */
  function swap(toFloat) {
    app.store.set(PANEL_MODE, toFloat ? "float" : "dock");
    panelCtl?.close({ now: true });
    if (toFloat) panelCtl = openHomePanel(app, { floating: true, rooms: allRooms, changed: () => draw(), swap });
    else {
      const { edge, at } = lastPanelEdge(app.store);
      panelCtl = openHomePanel(app, { edge, at, rooms: allRooms, changed: () => draw(), swap });
    }
  }

  /**
   * The ⋮ at the top right: a tap brings 찾기와 집 out of the edge it was last thrown to; held and
   * thrown, it flies along the finger's path to the edge it really meets (a small light on that edge
   * shows where while aiming), lights it in my colour and the panel comes out there.
   */
  function kebab() {
    // Its look is the window's (the owner: "점3개 세로 아이콘 그걸 너가 새로 만든 그거 아이콘 디자인으로…
    // 기능은 점 3개 세로인 걸로").
    const btn = h("button", { class: "icon-btn home-kebab", id: "home-more", type: "button", "aria-label": "햇살: 방 찾기와 집 (누르면 지난번 그 자리에서, 끌어서 던지면 그쪽에서)",
      onclick: (e) => { if (e.detail === 0) openPanel(); } }, icon("sunshine"));
    let g = null;
    const aim = aimMarker();
    const reset = () => {
      aim.hide();
      btn.classList.remove("charging");
      const was = btn.style.translate;
      btn.style.translate = "";
      if (was && btn.animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) btn.animate([{ translate: was }, { translate: "0 0" }], { duration: 380, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
    };
    const throwNow = (x, y, v = { vx: 0, vy: 0 }) => throwOf({ x0: g.x0, y0: g.y0, x1: x, y1: y, vx: v.vx, vy: v.vy, w: innerWidth, h: innerHeight });
    btn.addEventListener("pointerdown", (e) => {
      g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, track: new VelocityTracker() };
      g.track.add(e.timeStamp, e.clientX, e.clientY);
      try { btn.setPointerCapture(e.pointerId); } catch { /* fine */ }
      btn.classList.add("charging");
    });
    btn.addEventListener("pointermove", (e) => {
      if (!g || e.pointerId !== g.id) return;
      for (const one of e.getCoalescedEvents?.() || [e]) g.track.add(one.timeStamp, one.clientX, one.clientY);
      // The dots lean after the finger, held back like a ball in a sling.
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      const d = Math.hypot(dx, dy) || 1;
      const pull = Math.min(24, d * 0.3);
      btn.style.translate = `${(dx / d) * pull}px ${(dy / d) * pull}px`;
      // Where it would land, shown on the edge before letting go.
      const t = throwNow(e.clientX, e.clientY);
      aim.show(t && d >= throwReach(t) ? t : null);
    });
    btn.addEventListener("touchmove", (e) => { if (g) e.preventDefault(); }, { passive: false });
    btn.addEventListener("pointercancel", () => { g = null; reset(); });
    btn.addEventListener("pointerup", (e) => {
      if (!g || e.pointerId !== g.id) return;
      g.track.add(e.timeStamp, e.clientX, e.clientY);
      const v = g.track.velocity(e.timeStamp);
      const moved = Math.hypot(e.clientX - g.x0, e.clientY - g.y0);
      // Thrown as far as the room that way allows (a short swipe at the near right edge counts).
      const t = throwNow(e.clientX, e.clientY, v);
      const hit = throwMeant(t, moved) ? t : null;
      g = null;
      reset();
      if (!hit) return void openPanel();
      // The invisible ball takes a moment to fly from the finger to the edge: further and softer, longer.
      const flight = Math.hypot(hit.x - e.clientX, hit.y - e.clientY);
      const delay = Math.round(Math.max(40, Math.min(190, flight / Math.max(0.9, hit.speed * 1.3))));
      if (panelCtl?.isOpen() && panelCtl.locked()) return void panelCtl.nudge();
      rememberPanelEdge(app.store, hit);
      openPanel({ edge: hit.edge, at: hit.at, strength: hit.strength, delay, thrown: true });
    });
    return btn;
  }

  function roomMenu(room) {
    // My whiteboards here and the ones made on my other devices (listed on home too).
    const remembered = app.store.get("rooms", []);
    const boards = [...remembered, ...others.filter((o) => !remembered.some((r) => r.id === o.id))].filter((r) => r.kind === "creative-board" && r.id !== room.id);
    sheet(room.name, (panel, close) => {
      const busy = (text) => { panel.querySelector("#room-actions").replaceChildren(h("p", { class: "help", id: "room-action-busy", text })); };
      const pickBoard = () => {
        panel.querySelector("#room-actions").replaceChildren(
          h("p", { class: "help", text: "어느 화이트보드에 넣을까요?" }),
          ...(boards.length ? boards.map((b) => h("button", { class: "btn quiet", type: "button", data: { board: b.id }, text: b.name, onclick: async () => {
            busy("넣는 중…");
            try {
              const n = await putIntoBoard(app, room, b);
              close();
              toast(root, n ? `'${b.name}'에 ${n}개를 넣었어요` : "넣을 것이 아직 없어요", 3200);
            } catch (err) {
              console.warn(err);
              close();
              toast(root, "넣지 못했어요. 두 방을 한 번씩 열었다가 다시 해 주세요.", 3600);
            }
          } })) : [h("p", { class: "help", text: "화이트보드 방이 아직 없어요. 창작 +에서 만들 수 있어요." })]));
      };
      // Where this room's things can go: a whiteboard takes words and songs as cards; a song room takes
      // a song room's clips or a whiteboard's songs in their order. Each says what will go.
      const songRooms = [...remembered, ...others.filter((o) => !remembered.some((r) => r.id === o.id))].filter((r) => r.kind === "creative-song" && r.id !== room.id);
      const pickWhere = () => {
        const what = room.kind === "creative-board" ? "노래 카드를 순서대로" : room.kind === "creative-song" ? "클립 전부를" : "글을";
        const go = (label, dest, put) => h("button", { class: "btn quiet", type: "button", data: { sendTo: dest.id }, text: `${label}: ${dest.name}`, onclick: async () => {
          busy("보내는 중…");
          try {
            const n = await put(dest);
            close();
            toast(root, n ? `'${dest.name}'에 ${n}개를 보냈어요` : "보낼 것이 아직 없어요", 3200);
          } catch (err) {
            console.warn(err);
            close();
            toast(root, "보내지 못했어요. 두 방을 한 번씩 열었다가 다시 해 주세요.", 3600);
          }
        } });
        const toSong = room.kind === "creative-board" || room.kind === "creative-song" ? songRooms : [];
        panel.querySelector("#room-actions").replaceChildren(...[
          h("p", { class: "help", id: "send-what", text: `이 방의 ${what} 어디로 보낼까요?` }),
          ...toSong.map((d) => go("노래 방", d, (dest) => putRoomIntoSong(app, room, dest))),
          ...boards.map((d) => go("화이트보드", d, (dest) => putIntoBoard(app, room, dest))),
          !toSong.length && !boards.length && h("p", { class: "help", text: "보낼 수 있는 방이 아직 없어요. 창작 +에서 만들 수 있어요." }),
        ].filter(Boolean));
      };
      // 역사 first: when it began, its latest change, who came in when, what was made by day.
      const story = h("div", { class: "room-history", id: "room-history" }, h("p", { class: "help", text: "역사를 불러오는 중…" }));
      panel.append(story);
      roomHistory(app, room).then(
        (hist) => story.replaceChildren(...historyView(hist)),
        (err) => { console.warn(err); story.replaceChildren(h("p", { class: "help", text: "역사를 불러오지 못했어요" })); });
      panel.append(h("div", { class: "form", id: "room-actions" },
        h("button", { class: "btn", type: "button", id: "room-open", text: "열기", onclick: () => { close(); app.go("r-" + room.id); } }),
        h("button", { class: "btn quiet", type: "button", id: "room-duplicate", text: "복제", onclick: async () => {
          busy("복제하는 중…");
          try {
            await duplicateRoom(app, room);
            close();
            toast(root, "복제했어요");
            draw();
          } catch (err) {
            console.warn(err);
            close();
            toast(root, "복제하지 못했어요", 3200);
          }
        } }),
        h("button", { class: "btn quiet", type: "button", id: "room-copy-link", text: "링크 복사", onclick: () => {
          const link = app.linkFor(room.id);
          Promise.resolve().then(() => navigator.clipboard.writeText(link)).then(() => toast(root, "링크를 복사했어요"), () => toast(root, link, 8000));
          close();
        } }),
        // 보내기: what this room holds, to where it can go (the owner: "홈화면에서 꾹 누르면 보내기… 뭘 보내고").
        h("button", { class: "btn quiet", type: "button", id: "room-send", text: "보내기", onclick: () => pickWhere() }),
        h("button", { class: "btn quiet", type: "button", id: "room-to-board", text: "화이트보드에 넣기", onclick: () => pickBoard() }),
        // 별표 and 집 from the menu too (a mouse, or whoever does not drag).
        h("button", { class: "btn quiet", type: "button", id: "room-star", text: starred(app.store).has(room.id) ? "별표 빼기" : "별표 (맨 위에)", onclick: () => { const on = toggleStar(app.store, room.id); close(); draw(); toast(root, on ? "별표: 맨 위에 둘게요" : "별표를 뺐어요", 1600); } }),
        houseOf(app.store, room.id)
          ? h("button", { class: "btn quiet", type: "button", id: "room-out-of-house", text: `'${houseOf(app.store, room.id).name}'에서 꺼내기`, onclick: () => { takeOutOfHouse(app.store, room.id); close(); draw(); } })
          : h("button", { class: "btn quiet", type: "button", id: "room-into-house", text: "집에 넣기", onclick: () => {
            panel.querySelector("#room-actions").replaceChildren(
              h("p", { class: "help", text: "어느 집에 넣을까요?" }),
              ...houses(app.store).map((x) => h("button", { class: "btn quiet", type: "button", data: { intoHouse: x.id }, text: x.name, onclick: () => { putInHouse(app.store, room.id, x.id); close(); draw(); toast(root, `'${x.name}'에 넣었어요`); } })),
              h("button", { class: "btn", type: "button", id: "room-new-house", text: "새 집 짓기", onclick: () => { close(); openPanel({ edge: "bottom", strength: 0.3, view: { name: "build", room: room.id } }); } }));
          } }),
        h("button", { class: "btn quiet", type: "button", id: "room-forget", text: "목록에서 빼기", onclick: () => { forgetRoom(app.store, room.id); close(); draw(); toast(root, "목록에서 뺐어요. 방은 그대로 있어요"); } })));
    }, { side: true });
  }

  function half(side, title, note, emptyText) {
    const stars = starred(app.store);
    // Rooms in a house stay here too, the house beside their name (the owner, 21 November: "집에 넣어
    // 놓은 방은… 그냥 똑같이 있는데 이름 옆에다가 자그만하게 그 집의 아이콘").
    const all = app.store.get("rooms", []).filter((r) => sideOf(r.kind) === side);
    const mine = all.slice().sort((a, b) => Number(stars.has(b.id)) - Number(stars.has(a.id)) || b.at - a.at);
    const known = new Set(app.store.get("rooms", []).map((r) => r.id));
    const elsewhere = others.filter((r) => sideOf(r.kind) === side && !known.has(r.id));
    // Its title stays where it is; only the rooms scroll, under a fine line, fading out before they
    // reach it (the owner, 21 November: "제목과 중요한 거 있는 부분에는 영향을 안 끼치게… 제목 근처에 갈수록
    // 그라데이션으로 안 보이게… 가로선이 있게끔").
    return h("section", { class: "half field " + side, data: { side } },
      h("div", { class: "half-head" },
        h("h1", { class: "half-title", text: title }),
        h("p", { class: "half-note", text: note })),
      h("div", { class: "half-scroll" },
        mine.length
          ? h("div", { class: "rooms" + (cardView() ? " cards" : "") }, mine.map((r) => roomRow(r, r.local ? "이 기기만" : whenLabel(r.at), true)))
          : h("p", { class: "empty", text: emptyText }),
        elsewhere.length > 0 && [
          h("p", { class: "group-label", text: "다른 기기에서 만든 방" }),
          h("div", { class: "rooms" + (cardView() ? " cards" : ""), id: side === "daily" ? "others" : "others-creative" }, elsewhere.map((r) => roomRow(r, whenLabel(r.at)))),
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
      h("div", { class: "home-wrap" + (getSettings(app.store).reference ? "" : " one-row") },
        h("div", { class: "home", id: "home" },
          half("daily", SIDES.daily.title, SIDES.daily.note, "아직 방이 없어요. 아래 +로 오늘을 같이 적을 방을 만들어 보세요."),
          half("creative", SIDES.creative.title, SIDES.creative.note, "아직 방이 없어요. 아래 +로 같이 부르고 놓을 방을 만들어 보세요.")),
        // 설정 and 햇살 side by side at the top right, 비서 under 햇살 (the owner, 21 November: "찾기와 집
        // 그거 기능을 레퍼런스 아이콘 위로"), so nothing lies over 창작's title.
        h("div", { class: "home-top" },
          iconButton("home-settings", "more", "설정", openSettings),
          // 햇살: 방 찾기와 집 (its bar's own button turns it into a window of its own and back).
          kebab(),
          getSettings(app.store).reference && iconButton("home-reference", "book", "비서 (나만 보기)", () => openRef())),
        h("div", { class: "home-foot" },
          slow && h("span", { class: "hint", id: "connecting", text: "아직 연결 중" }),
          // 녹음 right from home: the takes are kept (모아 두기) in 레퍼런스's 녹음, to send to a room when wanted.
          h("button", { class: "pill rec-pill", id: "home-record", type: "button", "aria-label": "녹음 (모아 두고 방으로 보내기)", onclick: () => openRef({ tab: "sounds" }) },
            h("span", { class: "dot-rec", "aria-hidden": "true" }), "녹음", refSounds(app.store).length > 0 && h("span", { class: "rec-count", text: String(refSounds(app.store).length) })),
          h("button", { class: "pill", id: "by-code", type: "button", text: "코드로 들어가기", onclick: openCode }))));
    // 찾기와 집 stays open while home draws itself again behind it.
    if (panelCtl?.isOpen()) root.append(...panelCtl.nodes);
  }

  function sheet(title, build, opts) {
    closeSheet?.();
    closeWindows("sheet");
    closeSheet = openSheet(root, title, build, opts);
  }

  /**
   * One window at a time (the owner, 21 November: "찾기 그 기능 나오는 거랑 설정창이랑 안 겹치게 해줘. 누구 하나
   * 있으면 누구 하나 꺼 주고"): whatever is out besides `keep` goes before another comes.
   */
  function closeWindows(keep) {
    if (keep !== "panel" && panelCtl?.isOpen()) panelCtl.close({ now: true });
    if (keep !== "reference") document.getElementById("reference")?.close?.();
    if (keep !== "sheet") closeSheet?.();
  }
  function openRef(opts) {
    if (!document.getElementById("reference")) closeWindows("reference");
    openReference(app, opts);
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
      // 방 비밀번호 (the owner, 21 November: "들어갈 때 비밀번호도 정할 수 있게"): a real lock (core/lock.js).
      const password = inputRow("room-password", "방 비밀번호 (안 정해도 돼요)", { type: "password", maxLength: 64, autocomplete: "new-password", placeholder: "4자 이상" });
      const error = h("p", { class: "error", id: "form-error", role: "alert" });
      const status = h("p", { class: "help", id: "form-status", role: "status" });
      const button = h("button", { class: "btn", id: "create-room", type: "button", text: "방 만들기", onclick: submit });
      panel.append(formBox(submit, room.row, me.row, pin.row,
        h("p", { class: "help", text: "코드가 있으면 다른 기기에서도 같은 사람, 같은 색으로 들어올 수 있어요." }),
        password.row,
        h("p", { class: "help", text: "정하면 주소만으로는 들어올 수 없고, 들어올 때 이 비밀번호를 물어요. 방에 쓴 것은 비밀번호로 잠겨서 오가요." }),
        error, button, status));

      /** Makes the room on one transport and opens it (through its sealed channel when it has a key). */
      async function make(transport, id, roomName, key) {
        // A locked room's name stays inside it; what lists rooms sees only that it is locked.
        await transport.createRoom({ id, kind, name: key ? "비밀번호가 있는 방" : roomName });
        const session = new RoomSession({ transport: key ? sealedTransport(transport, id, key) : transport, roomId: id, store: app.store });
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
        const pw = password.input.value;
        if (pw.trim() && !validRoomPassword(pw)) return void (error.textContent = "방 비밀번호는 4자 이상이에요.");
        error.textContent = "";
        button.disabled = true;
        try {
          status.textContent = "연결하는 중…";
          const shared = await app.ready;
          const id = newRoomId();
          let key = null;
          let keyKept = null;
          if (pw.trim()) {
            status.textContent = "비밀번호로 잠그는 중…";
            key = await roomKeyFrom(pw, id);
            keyKept = await keyText(key);
          }
          const sharedKind = shared.info().kind;
          let session;
          // A room made while this view has no shared store lives on this device only.
          let local = sharedKind === "local" && app.limited;
          status.textContent = "방을 만드는 중…";
          try {
            session = await make(shared, id, roomName, key);
            if (sharedKind !== "local") app.limited = false;
          } catch (err) {
            if (sharedKind === "local") throw err;
            // The shared store did not take the room. Writing should still be possible, so the
            // room is made on this device, and the screens say that it is not shared.
            app.trace("create: no shared room (" + (err?.code || err?.message || err) + "), made on this device");
            shared.dropRoom?.(id);
            app.limited = true;
            local = true;
            session = await make(app.local(), id, roomName, key);
          }
          const memberId = newMemberId();
          session.commit("room", createRoomOps(session.clock, {
            kind, name: roomName, tz: localZone(), now: Date.now(), memberId, memberName: myName,
            pin: code ? await makeVerifier(code) : null, color: myPeopleColor(getSettings(app.store)) ?? 0,
          }));
          rememberRoom(app.store, { id, kind, name: roomName, memberId, local, ...(keyKept ? { key: keyKept } : {}) });
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
    const settings = getSettings(app.store);
    const recent = String(settings.recentSearchMax || 5);
    sheet("설정", (panel) => {
      // The first page holds what is changed often; the rest is one step in (the owner, 21 November:
      // "설정을 더 간편하고 좋게"), each page sliding in from the side and '‹ 설정' back (iOS 설정, the
      // Stack Panel the owner sent).
      const pages = new Map();
      const main = h("div", { class: "settings-page", data: { settingsPage: "main" } });
      const go = (id) => {
        for (const [key, el] of pages) el.hidden = key !== id;
        const now = pages.get(id);
        now.classList.remove("in", "out");
        void now.offsetWidth;
        now.classList.add(id === "main" ? "out" : "in");
        panel.scrollTop = 0;
      };
      const page = (id, title, ...children) => {
        const el = h("div", { class: "settings-page sub", data: { settingsPage: id }, hidden: true },
          h("button", { class: "settings-back", type: "button", data: { settingsBack: "" }, onclick: () => go("main") }, icon("back"), h("span", { text: "설정" })),
          h("p", { class: "settings-page-title", text: title }),
          ...children);
        pages.set(id, el);
        return el;
      };
      const link = (id, label, hint) => h("button", { class: "settings-link", type: "button", data: { settingsPart: id }, onclick: () => go(id) },
        h("span", { class: "settings-link-text" }, h("span", { class: "settings-link-label", text: label }), hint && h("span", { class: "settings-link-hint", text: hint })),
        h("span", { class: "settings-link-go", "aria-hidden": "true", text: "›" }));
      pages.set("main", main);
      // 방 보기 (the owner: "방 나열을 카드형으로 바꾸는 설정"): rows, or cards with the room's look large.
      const roomView = h("div", { class: "row" }, h("span", { class: "label", text: "방 보기" }),
        segmented([["list", "목록", "room-view-list"], ["cards", "카드", "room-view-cards"]], getSettings(app.store).roomView === "cards" ? "cards" : "list", (v) => {
          setSetting(app.store, "roomView", v);
          for (const el of root.querySelectorAll(".rooms")) el.classList.toggle("cards", v === "cards");
        }, "roomView"));
      main.append(
        // 나의 고유 코드 first (the owner: "설정에서 잘 보이게").
        myCodeSection(app, root, (title, build) => sheet(title, build), { onChange: codeChanged }),
        displaySettings(app, { withColors: false, part: "look" }),
        h("div", { class: "form" }, roomView),
        h("div", { class: "settings-links" },
          link("feel", "색 세기 · 효과음 · 진동"),
          link("find", "찾기 · 햇살 · 비서"),
          link("games", "미니게임"),
          link("gestures", "몸짓", "손가락으로 할 수 있는 것"),
          link("diag", "연결 진단", "문제가 있을 때")));
      panel.append(main,
        page("feel", "색 세기 · 효과음 · 진동", displaySettings(app, { withColors: false, part: "feel" })),
        page("find", "찾기 · 햇살 · 비서",
          h("div", { class: "section" }, h("p", { class: "section-title", text: "찾기" }),
            h("div", { class: "row" }, h("span", { class: "label", text: "최근 검색 보이기" }),
              segmented([["5", "5개", "recent-5"], ["10", "10개", "recent-10"], ["20", "20개", "recent-20"]], recent, (v) => setSetting(app.store, "recentSearchMax", Number(v)), "recentMax"))),
          // ⋮ pressed again with 찾기와 집 out (the owner, 21 November: "설정에서… 키냐 안 키냐… 처음에는 이게 안
          // 켜진 상태로"): off, it is put away; on, it goes round to the next edge.
          h("div", { class: "section" }, h("p", { class: "section-title", text: "햇살 (방 찾기와 집)" }),
            toggle("panel-cycle", "열린 채 햇살을 다시 누르면 다른 쪽으로", settings.panelCycle === true, (on) => setSetting(app.store, "panelCycle", on)),
            h("p", { class: "help small", text: "끄면 다시 눌렀을 때 닫혀요. 다른 쪽으로 옮기려면 햇살이나 창의 바를 그쪽으로 던져요." })),
          h("div", { class: "section" }, h("p", { class: "section-title", text: "비서" }),
            toggle("set-reference", "비서 (나만 보는 메모·녹음, 내 방들 잇기)", settings.reference, (on) => { setSetting(app.store, "reference", on); app.events.emit("settings"); }))),
        // 미니게임 (the owner: "그거 끄는, 없애는 기능도 홈 화면에서"): off, no game button in rooms and no invitations.
        page("games", "미니게임",
          toggle("games-on", "방에서 친구와 미니게임", settings.games !== false, (on) => setSetting(app.store, "games", on)),
          h("p", { class: "help small", text: "끄면 방 위의 게임 버튼이 사라지고 친구의 신청도 오지 않아요." })),
        page("gestures", "몸짓", gesturesPage()),
        page("diag", "연결 진단", diagnostics(app, null)));
    });
  }

  draw();
  // Another device's code typed in: this device meets that universe; whatever it brings, home shows.
  function codeChanged() {
    app.me?.restart();
    draw();
  }
  const offMe = app.events.on("me-changed", () => {
    if (alive && !root.querySelector(".scrim:not(.closing)")) draw();
  });
  // 몸짓 on home, once there are rooms to hold and throw (never over a sheet).
  const homeHint = setTimeout(() => {
    if (alive && app.store.get("rooms", []).length && !document.querySelector(".scrim:not(.closing)")) hintOnce(app, "home");
  }, 2200);
  // The first time the app opens, 나의 고유 코드 is handed over once the home has come up (the owner,
  // 21 November: "처음 이 앱을 들어왔을 때 생기는… 코드"). Tests open with ?dev and skip it.
  const welcome = app.welcome && !myCode(app.store).shown && setTimeout(() => {
    if (alive && !document.querySelector(".scrim:not(.closing)")) openMyCodeIntro(app, root, (title, build) => sheet(title, build), { onChange: codeChanged });
  }, 450);
  const slowTimer = setTimeout(() => {
    if (!app.connecting) return;
    slow = true;
    draw();
  }, 1500);
  app.ready
    .then((transport) => transport.listRooms().then(
      (list) => {
        // 나의 고유 코드's place is not a room to show.
        others = list.filter((r) => r.kind !== "me");
        app.trace("rooms: " + others.length);
      },
      (err) => {
        console.warn(err);
        app.trace("rooms: not readable (" + (err?.code || err?.message || err) + ")");
        // Without the list the shared store is out of reach for now; say so.
        if (transport.info().kind !== "local") app.limited = true;
      }))
    .finally(() => {
      slow = false;
      if (!closeSheet || !root.querySelector(".scrim:not(.closing)")) draw();
    });

  // A window out (a sheet, 비서) only covers what it lies over: home's three round buttons stay where
  // they are (the owner, 26 November: "비서와 설정 누를 때 아이콘 3개 사라지는 거 없애 주고"; before,
  // 21 November, they stepped away). A sheet closes by its own button or a press outside it, and
  // 설정's spot pressed again is outside it. While 햇살's own window is out, only 햇살 stays above it
  // and still answers (the owner: "그 햇살창만 안 가려지게"), whatever 설정 says: that setting is only
  // what its tap does.
  const sheetOut = () => !!(document.querySelector(".scrim:not(.closing)") || document.getElementById("reference"));
  const sunOut = () => !!document.getElementById("home-panel");
  const watchWindows = new MutationObserver(() => {
    const sheet = alive && sheetOut();
    root.classList.toggle("home-window", sheet);
    root.classList.toggle("home-sun-out", alive && !sheet && sunOut());
  });
  watchWindows.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

  return () => {
    alive = false;
    clearTimeout(slowTimer);
    clearTimeout(welcome);
    clearTimeout(homeHint);
    offMe();
    closeSheet?.();
    watchWindows.disconnect();
    root.classList.remove("home-window", "home-sun-out");
  };
}
