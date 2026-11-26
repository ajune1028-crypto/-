// 나의 고유 코드 on screen (the owner, 21 November: "처음 이 앱을 들어왔을 때 생기는 좀 복잡한 코드…
// '이건 당신의 식별 코드입니다. 이걸 안다면 당신의 모든 것들을 어디에서나 로그인할 수 있습니다'… 설정에서
// 잘 보이게"). The first time the app opens it is handed over like the key of a new home: the code in
// four groups, two plain lines on what it is, 복사 and 알겠어요, and the way in for a code from
// another device. After that it lives at the top of 설정, hidden until asked for.

import { h, toast, formBox } from "./dom.js";
import { normalizeCode, validCode, formatCode, CODE_LENGTH } from "../core/me.js";
import { myCodeOf, markMyCodeShown, adoptMyCode } from "../identity.js";

export const myCode = myCodeOf;
const markShown = markMyCodeShown;
const adoptCode = adoptMyCode;

/** The code as four groups of letters, or four groups of dots while it is hidden. */
function codeLetters(code, { masked = false } = {}) {
  const groups = formatCode(code).split("-");
  return h("div", { class: "my-code" + (masked ? " masked" : ""), "aria-label": masked ? "가려진 나의 고유 코드" : "나의 고유 코드 " + formatCode(code) },
    ...groups.map((g, i) => h("span", { class: "my-code-group", style: { "--i": i } }, masked ? "••••" : g)));
}

function copyCode(root, code) {
  Promise.resolve()
    .then(() => navigator.clipboard.writeText(formatCode(code)))
    .then(() => toast(root, "코드를 복사했어요. 나만 아는 곳에 두세요"), () => toast(root, "복사가 막혀 있어요. 코드를 길게 눌러 복사해 주세요"));
}

/**
 * The first time the app opens: the code, what it is, and the way in for a code from another device.
 * `sheet(title, build)` opens a sheet the way the caller's screen does (one window at a time).
 */
export function openMyCodeIntro(app, root, sheet, { onChange } = {}) {
  const me = myCode(app.store);
  return sheet("나의 고유 코드", (panel, close, onClose) => {
    panel.classList.add("my-code-sheet");
    onClose?.(() => markShown(app.store));
    panel.append(
      h("p", { class: "my-code-motto", text: "작은 우주를 기록해 보자" }),
      codeLetters(me.code),
      h("p", { class: "my-code-words", text: "이건 당신만의 코드예요. 이 코드를 알면 어디서든 당신의 방과 집, 모든 것을 그대로 열 수 있어요." }),
      h("p", { class: "help", text: "다른 사람에게는 보여 주지 마세요. 설정 맨 위에서 언제든 다시 볼 수 있어요." }),
      h("div", { class: "my-code-actions" },
        h("button", { class: "btn quiet", id: "my-code-copy", type: "button", text: "복사", onclick: () => copyCode(root, me.code) }),
        h("button", { class: "btn", id: "my-code-ok", type: "button", text: "알겠어요", onclick: () => close() })),
      h("button", {
        class: "link-btn my-code-have", id: "my-code-have", type: "button", text: "다른 기기에서 쓰던 코드가 있어요",
        onclick: () => { markShown(app.store); openEnterCode(app, root, sheet, { onChange }); },
      }));
  });
}

/** A code from another device, typed in: one letter wrong is caught by its check letter. */
export function openEnterCode(app, root, sheet, { onChange } = {}) {
  return sheet("다른 코드 넣기", (panel, close) => {
    panel.classList.add("my-code-sheet");
    const input = h("input", {
      class: "input my-code-input", id: "my-code-field", type: "text", autocomplete: "off", autocapitalize: "characters",
      spellcheck: "false", inputmode: "text", placeholder: "XXXX-XXXX-XXXX-XXXX", "aria-label": "나의 고유 코드",
    });
    const plain = "다른 기기의 설정 맨 위에 있는 코드를 그대로 쳐요. 대문자·소문자, 빈칸은 상관없어요.";
    const note = h("p", { class: "help", id: "my-code-note", text: plain });
    const go = h("button", { class: "btn", id: "my-code-use", type: "button", text: "이 코드로", disabled: true, onclick: () => use() });
    input.addEventListener("input", () => {
      const norm = normalizeCode(input.value).slice(0, CODE_LENGTH);
      const shaped = formatCode(norm);
      if (input.value !== shaped) input.value = shaped;
      const full = norm.length === CODE_LENGTH;
      const ok = full && validCode(norm);
      go.disabled = !ok;
      note.textContent = !full ? plain : ok ? "맞는 코드예요." : "한 글자가 다른 것 같아요. 다시 봐 주세요.";
      note.classList.toggle("warn", full && !ok);
    });
    function use() {
      if (!adoptCode(app.store, input.value)) {
        if (validCode(input.value)) close(); // the code this device already has
        return;
      }
      close();
      // Home is drawn again first (a toast is part of the screen it replaces), then it says what happened.
      onChange?.();
      toast(root, "이 기기도 같은 우주예요. 이 기기의 방과 집은 그대로 함께 가요");
    }
    panel.append(formBox(use, input, note, h("div", { class: "my-code-actions" }, go)));
    setTimeout(() => input.focus(), 80);
  });
}

/** The top of 설정: the code hidden until 보기, 복사, and 다른 코드 넣기. */
export function myCodeSection(app, root, sheet, { onChange } = {}) {
  const me = myCode(app.store);
  let shown = false;
  const slot = h("div", { class: "my-code-slot" });
  const paint = () => slot.replaceChildren(codeLetters(me.code, { masked: !shown }));
  paint();
  const see = h("button", {
    class: "chip", id: "my-code-see", type: "button", text: "보기",
    onclick: () => { shown = !shown; see.textContent = shown ? "가리기" : "보기"; paint(); },
  });
  return h("div", { class: "section my-code-section" },
    h("p", { class: "section-title", text: "나의 고유 코드" }),
    slot,
    h("p", { class: "help small", text: "이 코드를 알면 어디서든 당신의 모든 것을 열 수 있어요. 다른 사람에게는 보여 주지 마세요." }),
    h("div", { class: "my-code-chips" }, see,
      h("button", { class: "chip", id: "my-code-copy", type: "button", text: "복사", onclick: () => copyCode(root, me.code) }),
      h("button", { class: "chip", id: "my-code-other", type: "button", text: "다른 코드 넣기", onclick: () => openEnterCode(app, root, sheet, { onChange }) })));
}
