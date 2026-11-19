// 찾기와 집: what the ⋮ at home's top right brings out (the owner, 17 November). At the top, a search
// of my rooms by their names (초성 too, core/search.js) or by what they hold; the last searches
// under it. Then 집: houses that hold rooms, each one colour of deep glass with a ㅅ roof, a small
// chimney and a white icon, its name beneath. It comes out of the edge it was thrown to (a tap
// brings it up from the bottom). Leaving the app puts it away, and the search with it.

import { h, icon, toast } from "./dom.js";
import { segmented } from "./dom.js";
import { kindInfo } from "./kinds.js";
import { getSettings } from "../identity.js";
import { rankByName, snippet } from "../core/search.js";
import { houses, addHouse, updateHouse, removeHouse, putInHouse, takeOutOfHouse, houseOf, recentSearches, rememberSearch, forgetSearches, roomWords, HOUSE_COLORS, HOUSE_ICONS } from "../houses.js";

export function houseColor(key) {
  return (HOUSE_COLORS.find(([k]) => k === key) || HOUSE_COLORS[0])[1];
}

/** A house: one colour of deep glass, a ㅅ roof and a small chimney, a white icon inside. */
export function houseShape(house) {
  const wrap = h("span", { class: "house-shape", "aria-hidden": "true" });
  wrap.style.setProperty("--house", houseColor(house.color));
  wrap.innerHTML = '<svg viewBox="0 0 100 100"><rect class="house-chimney" x="67" y="15" width="11" height="24" rx="2.5"/>' +
    '<path class="house-body" d="M50 14 L84 43 V85 Q84 91 78 91 H22 Q16 91 16 85 V43 Z"/>' +
    '<path class="house-shine" d="M50 21 L78 45 V56 Q50 47 22 58 V45 Z"/>' +
    '<path class="house-roof" d="M9 46 L50 12 L91 46"/></svg>';
  const mark = icon(house.icon || "home");
  mark.classList.add("house-mark");
  wrap.append(mark);
  return wrap;
}

/** The parts of a name around a match, the match marked. */
function marked(text, at, len) {
  const t = [...text];
  return [t.slice(0, at).join(""), h("mark", { text: t.slice(at, at + len).join("") }), t.slice(at + len).join("")];
}

/**
 * Opens the panel. rooms(): every room I know (mine and those made on my other devices);
 * changed(): home draws itself again (a room went into a house, a house was built or taken down).
 * view: what it opens on ({ name: "main" }, { name: "house", id }, { name: "build", room }).
 */
export function openHomePanel(app, { edge = "bottom", rooms, changed, view = { name: "main" } }) {
  const root = app.root;
  const store = app.store;
  const max = () => getSettings(store).recentSearchMax || 5;
  let mode = "name";
  let query = "";
  const panel = h("aside", { class: "home-panel", id: "home-panel", data: { edge }, role: "dialog", "aria-label": "찾기와 집" });
  const scrim = h("div", { class: "home-panel-scrim", "aria-hidden": "true", onclick: () => close() });
  root.append(scrim, panel);
  const from = { right: "translateX(105%)", left: "translateX(-105%)", top: "translateY(-105%)", bottom: "translateY(105%)" }[edge];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced && panel.animate) {
    panel.animate([{ transform: from, opacity: 0.6 }, { transform: "none", opacity: 1 }], { duration: 420, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
  }
  let open = true;
  const onKey = (e) => { if (e.key === "Escape") close(); };
  // Leaving the app and coming back finds home as it was: no search, no panel.
  const onHide = () => { if (document.visibilityState === "hidden") close({ now: true, forget: true }); };
  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onHide);

  function close({ now = false, forget = false } = {}) {
    if (!open) return;
    open = false;
    if (!forget && query.trim()) rememberSearch(store, query, max());
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", onHide);
    const gone = () => { panel.remove(); scrim.remove(); };
    if (now || reduced || !panel.animate) return gone();
    panel.animate([{ transform: "none", opacity: 1 }, { transform: from, opacity: 0.4 }], { duration: 260, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" }).finished.then(gone, gone);
    scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: "forwards" });
  }

  const goRoom = (id) => {
    if (query.trim()) rememberSearch(store, query, max());
    close({ now: true });
    app.go("r-" + id);
  };

  function draw() {
    if (!open) return;
    if (view.name === "house") return drawHouse();
    if (view.name === "build") return drawBuild();
    drawMain();
  }

  // ---- 찾기 + 집 ----------------------------------------------------------------------------

  function drawMain() {
    const results = h("div", { class: "search-results", id: "search-results", "aria-live": "polite" });
    const field = h("input", { class: "input search-input", id: "home-search", type: "search", enterkeyhint: "search", autocomplete: "off", spellcheck: "false",
      placeholder: mode === "name" ? "방 이름 (ㅅㅌ처럼 초성도)" : "쓴 글, 녹음 이름, 메모",
      value: query,
      oninput: () => { query = field.value; fill(); },
      onkeydown: (e) => { if (e.key === "Enter") { rememberSearch(store, query, max()); field.blur(); } } });
    const modes = segmented([["name", "이름", "search-by-name"], ["words", "내용", "search-by-words"]], mode, (m) => {
      mode = m;
      field.placeholder = m === "name" ? "방 이름 (ㅅㅌ처럼 초성도)" : "쓴 글, 녹음 이름, 메모";
      fill();
    }, "searchMode");
    modes.classList.add("search-modes");
    const fill = () => results.replaceChildren(...resultsFor(), ...[]);
    function resultsFor() {
      const q = query.trim();
      if (!q) {
        const recent = recentSearches(store, max());
        if (!recent.length) return [];
        return [h("div", { class: "recent", id: "recent-searches" },
          h("span", { class: "group-label", text: "최근 검색" }),
          h("div", { class: "recent-chips" }, recent.map((r) => h("button", { class: "chip recent-chip", type: "button", text: r, onclick: () => { query = r; field.value = r; fill(); } }))),
          h("button", { class: "link-btn", id: "recent-clear", type: "button", text: "지우기", onclick: () => { forgetSearches(store); fill(); } }))];
      }
      const all = rooms();
      if (mode === "name") {
        const found = rankByName(all, q);
        if (!found.length) return [h("p", { class: "help", id: "no-results", text: "그런 이름의 방이 없어요" })];
        return found.map(({ item, at, len }) => hit(item, marked(item.name || "방", at, len)));
      }
      const words = roomWords(store);
      const found = [];
      for (const r of all) {
        const w = words[r.id];
        const s = w && snippet(w.text, q, 14);
        if (s) found.push([r, s]);
      }
      const unread = all.filter((r) => !words[r.id]).length;
      return [
        ...found.map(([r, s]) => hit(r, r.name || "방", h("span", { class: "hit-words" }, s.before.replace(/\n/g, " "), h("mark", { text: s.match }), s.after.replace(/\n/g, " ")))),
        !found.length && h("p", { class: "help", id: "no-results", text: "그런 내용이 있는 방이 없어요" }),
        unread > 0 && h("p", { class: "help small", text: `이 기기에서 아직 열어 보지 않은 방 ${unread}개는 내용을 몰라요` }),
      ].filter(Boolean);
    }
    function hit(room, name, extra = null) {
      const kind = kindInfo(room.kind);
      const home = houseOf(store, room.id);
      return h("button", { class: "search-hit", type: "button", data: { room: room.id }, onclick: () => goRoom(room.id) },
        h("span", { class: "hit-name" }, ...(Array.isArray(name) ? name : [name])),
        h("span", { class: "hit-meta" }, icon(kind?.icon || "lines"), kind?.name || "방", home && h("span", { class: "hit-house", text: "· " + home.name })),
        extra);
    }
    const list = houses(store);
    panel.replaceChildren(
      h("div", { class: "panel-grip", "aria-hidden": "true" }),
      h("div", { class: "home-panel-body" },
        h("div", { class: "search-row" }, h("span", { class: "search-icon", "aria-hidden": "true" }, icon("search")), field, modes),
        results,
        h("section", { class: "houses", id: "houses" },
          h("h2", { class: "houses-title" }, "집", list.length > 0 && h("span", { class: "houses-count", text: String(list.length) })),
          !list.length && h("p", { class: "help small", text: "방을 꾹 눌러 끌어다 집에 넣을 수 있어요." }),
          h("div", { class: "house-grid", id: "house-grid" },
            ...list.map((house) => h("button", { class: "house-tile", type: "button", data: { house: house.id }, "aria-label": `${house.name} (방 ${house.rooms.length}개)`,
              onclick: () => { view = { name: "house", id: house.id }; draw(); } },
              houseShape(house),
              h("span", { class: "house-name", text: house.name }),
              house.rooms.length > 0 && h("span", { class: "house-count", text: String(house.rooms.length) }))),
            h("button", { class: "house-tile house-new", id: "house-new", type: "button", "aria-label": "집 짓기", onclick: () => { view = { name: "build" }; draw(); } },
              h("span", { class: "house-shape house-plan", "aria-hidden": "true" }, icon("plus")),
              h("span", { class: "house-name", text: "집 짓기" }))))));
    fill();
  }

  // ---- one house ----------------------------------------------------------------------------

  function drawHouse() {
    const house = houses(store).find((x) => x.id === view.id);
    if (!house) {
      view = { name: "main" };
      return draw();
    }
    const known = new Map(rooms().map((r) => [r.id, r]));
    const inside = house.rooms.map((id) => known.get(id)).filter(Boolean);
    let asking = false;
    const actions = h("div", { class: "house-actions" });
    const paintActions = () => actions.replaceChildren(...(asking
      ? [h("p", { class: "help", text: "이 집을 허물까요? 방은 그대로 홈으로 돌아가요." }),
        h("button", { class: "chip danger", id: "house-remove-yes", type: "button", text: "허물기", onclick: () => { removeHouse(store, house.id); changed(); view = { name: "main" }; draw(); toast(root, "집을 허물었어요. 방은 홈에 있어요"); } }),
        h("button", { class: "chip", type: "button", text: "그대로 두기", onclick: () => { asking = false; paintActions(); } })]
      : [h("button", { class: "chip", id: "house-edit", type: "button", text: "꾸미기", onclick: () => { view = { name: "build", id: house.id }; draw(); } }),
        h("button", { class: "chip", id: "house-remove", type: "button", text: "허물기", onclick: () => { asking = true; paintActions(); } })]));
    paintActions();
    panel.replaceChildren(
      h("div", { class: "panel-grip", "aria-hidden": "true" }),
      h("div", { class: "home-panel-body" },
        h("div", { class: "house-head" },
          h("button", { class: "icon-btn", id: "house-back", type: "button", "aria-label": "뒤로", onclick: () => { view = { name: "main" }; draw(); } }, icon("back")),
          h("span", { class: "house-head-shape" }, houseShape(house)),
          h("h2", { class: "house-head-name", text: house.name })),
        inside.length
          ? h("div", { class: "house-rooms", id: "house-rooms" }, inside.map((r) => {
            const kind = kindInfo(r.kind);
            return h("div", { class: "house-room", data: { room: r.id } },
              h("button", { class: "search-hit", type: "button", onclick: () => goRoom(r.id) },
                h("span", { class: "hit-name", text: r.name || "방" }),
                h("span", { class: "hit-meta" }, icon(kind?.icon || "lines"), kind?.name || "방")),
              h("button", { class: "chip", type: "button", data: { takeOut: r.id }, text: "꺼내기", onclick: () => { takeOutOfHouse(store, r.id); changed(); draw(); toast(root, `'${r.name || "방"}'을(를) 홈으로 꺼냈어요`); } }));
          }))
          : h("p", { class: "help", id: "house-empty", text: "아직 빈 집이에요. 홈에서 방을 꾹 눌러 끌어다 넣어요." }),
        actions));
  }

  // ---- 집 짓기 / 꾸미기 ------------------------------------------------------------------------

  function drawBuild() {
    const old = view.id ? houses(store).find((x) => x.id === view.id) : null;
    const draft = { name: old?.name || "", color: old?.color || HOUSE_COLORS[0][0], icon: old?.icon || HOUSE_ICONS[0] };
    const preview = h("span", { class: "build-preview" });
    const paint = () => preview.replaceChildren(houseShape(draft));
    paint();
    const name = h("input", { class: "input", id: "house-name", maxlength: 30, autocomplete: "off", placeholder: "집 이름 (예: 우리 가족)", value: draft.name, oninput: () => { draft.name = name.value; } });
    const colors = h("div", { class: "house-colors", id: "house-colors", role: "group", "aria-label": "집 색" },
      HOUSE_COLORS.map(([k, c, label]) => h("button", { class: "house-color", type: "button", data: { color: k }, "aria-label": label, "aria-pressed": String(draft.color === k), style: { background: c },
        onclick: (e) => { draft.color = k; for (const b of colors.children) b.setAttribute("aria-pressed", String(b === e.currentTarget)); paint(); } })));
    const icons = h("div", { class: "house-icons", id: "house-icons", role: "group", "aria-label": "집 아이콘" },
      HOUSE_ICONS.map((k) => h("button", { class: "house-icon-pick", type: "button", data: { icon: k }, "aria-pressed": String(draft.icon === k), "aria-label": k,
        onclick: (e) => { draft.icon = k; for (const b of icons.children) b.setAttribute("aria-pressed", String(b === e.currentTarget)); paint(); } }, icon(k))));
    const save = () => {
      if (old) {
        updateHouse(store, old.id, draft);
        changed();
        view = { name: "house", id: old.id };
      } else {
        const made = addHouse(store, draft);
        if (view.room) {
          putInHouse(store, view.room, made.id);
          toast(root, `'${made.name}'에 넣었어요`);
        }
        changed();
        view = view.room ? { name: "main" } : { name: "house", id: made.id };
      }
      draw();
    };
    panel.replaceChildren(
      h("div", { class: "panel-grip", "aria-hidden": "true" }),
      h("div", { class: "home-panel-body" },
        h("div", { class: "house-head" },
          h("button", { class: "icon-btn", id: "build-back", type: "button", "aria-label": "뒤로", onclick: () => { view = old ? { name: "house", id: old.id } : { name: "main" }; draw(); } }, icon("back")),
          h("h2", { class: "house-head-name", text: old ? "집 꾸미기" : "집 짓기" })),
        h("div", { class: "build" }, preview,
          h("div", { class: "form" },
            name,
            h("span", { class: "label", text: "색" }), colors,
            h("span", { class: "label", text: "아이콘" }), icons,
            h("button", { class: "btn", id: "house-save", type: "button", text: old ? "저장" : "짓기", onclick: save })))));
    if (!old) setTimeout(() => name.focus({ preventScroll: true }), 80);
  }

  draw();
  // nodes: home draws itself anew by replacing what it holds; it puts these back after.
  return { close, show: (next) => { view = next; draw(); }, isOpen: () => open, nodes: [scrim, panel] };
}
