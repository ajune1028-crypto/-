// The 레퍼런스 sheet: my private notes, from home or from inside any room.

import { h, openSheet, toast } from "./dom.js";
import { refNotes, addRefNote, removeRefNote } from "../reference.js";
import { clipboardItem } from "../clipboard.js";

/** `insert(text)` puts a note into the room that is open, when that room can take text. */
export function openReference(app, { insert = null } = {}) {
  openSheet(app.root, "레퍼런스 (나만 보기)", (panel, close) => {
    const list = h("div", { class: "ref-list", id: "ref-list" });
    const area = h("textarea", { class: "input note-area", id: "ref-text", rows: 3, placeholder: "가사, 코드, 아이디어… 이 기기의 나만 봐요" });
    const draw = () => {
      const notes = refNotes(app.store);
      const clip = clipboardItem(app.store, "song-clip");
      list.replaceChildren(
        clip && h("p", { class: "help ref-clip", id: "ref-clip", text: `복사해 둔 노래 클립: ${clip.source?.name || "녹음"} · ${(clip.length / 1000).toFixed(1)}초 (노래 방이나 화이트보드에 붙일 수 있어요)` }),
        ...(notes.length ? notes.map((n) => h("div", { class: "ref-note", data: { id: n.id } },
          h("p", { class: "ref-body", text: n.text }),
          h("div", { class: "ref-actions" },
            h("button", { class: "chip", type: "button", text: "복사", onclick: () => Promise.resolve().then(() => navigator.clipboard.writeText(n.text)).then(() => toast(app.root, "복사했어요"), () => toast(app.root, "길게 눌러 복사해 주세요")) }),
            insert && h("button", { class: "chip", type: "button", data: { put: n.id }, text: "이 방에 붙이기", onclick: () => { insert(n.text); close(); toast(app.root, "붙였어요"); } }),
            h("button", { class: "chip danger", type: "button", text: "지우기", onclick: () => { removeRefNote(app.store, n.id); draw(); } }))))
          : [h("p", { class: "help", text: "아직 메모가 없어요. 여기 적은 것은 이 기기의 나만 볼 수 있어요." })]));
    };
    panel.append(h("div", { class: "form" }, area,
      h("button", { class: "btn", id: "ref-add", type: "button", text: "메모 남기기", onclick: () => {
        if (!area.value.trim()) return;
        addRefNote(app.store, area.value.trim());
        area.value = "";
        draw();
      } }), list));
    draw();
  });
}
