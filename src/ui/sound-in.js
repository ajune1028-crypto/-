// The ways a sound comes in, shared by the song room and the whiteboard's 노래 모드:
// record in the app, the phone's recorder app (a file input with capture, which
// Android answers with Samsung 녹음 or the default recorder), or a file.
//
// Pickers are opened by <label>s, never by a script: some phones and app views
// only open a file chooser straight from a person's tap. A tap that opens no
// chooser (the Claude app's view does this) gets a way out instead of silence:
// the same room in the phone's browser.

import { h, openSheet, toast } from "./dom.js";
import { watchPickers } from "./picker-watch.js";

export const AUDIO_TYPES = "audio/*,.m4a,.mp3,.wav,.aac,.ogg,.oga,.opus,.webm,.3gp,.amr,.flac";
export const KEEP_RATE = 24000; // recordings are kept at this rate: clear voice, a quarter of CD size

/** Why this page cannot record in the app, in words a person can act on. */
export function micReason(reason) {
  if (reason === "blocked") return "Claude 안에서는 Claude가 이 화면에 마이크를 열어 주지 않아요. 폰 녹음 앱이나 파일로 넣어 주세요. Claude 앱에서 그것도 안 열리면 '크롬에서 열기'로 같은 방을 크롬에서 여세요.";
  if (reason === "insecure") return "이 주소에서는 브라우저가 마이크를 열어 주지 않아요(https 주소에서만 돼요). 아래 '폰 녹음 앱으로 녹음하기'를 써 주세요.";
  if (reason === "unsupported") return "이 브라우저는 앱 안 녹음을 지원하지 않아요. 아래 '폰 녹음 앱으로 녹음하기'를 써 주세요.";
  return reason || "";
}

/**
 * The two hidden pickers (ids `${name}-file` and `${name}-capture`), watched for
 * taps that open nothing. onFile(file) gets what was picked. Returns
 * { inputs, stop }; put the inputs in the page once.
 */
export function soundPickers(name, { onFile, onSilent }) {
  const inputs = [
    h("input", { type: "file", accept: AUDIO_TYPES, id: name + "-file", class: "vh", tabindex: "-1" }),
    h("input", { type: "file", accept: "audio/*", capture: "user", id: name + "-capture", class: "vh", tabindex: "-1" }),
  ];
  for (const input of inputs) {
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.value = "";
      if (file) onFile(file);
    });
  }
  return { inputs, stop: watchPickers(inputs, onSilent) };
}

/** 크롬에서 열기 and 링크 복사 for the same room. */
export function elsewhere({ app, roomId, root, prefix }) {
  // Outside a room (레퍼런스 from home), the app's own address.
  const link = roomId ? app.linkFor(roomId) : String(app.shareBase() || location.href).split("#")[0];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast(root, "링크를 복사했어요. 크롬 주소창에 붙여 넣으면 같은 방이 열려요", 3600);
    } catch {
      toast(root, link, 8000);
    }
  };
  return [
    h("a", { class: "btn quiet small", id: prefix + "open-browser", href: link, target: "_blank", rel: "noopener" }, "크롬에서 열기"),
    h("button", { type: "button", class: "btn quiet small", id: prefix + "copy-link", onclick: copy }, "링크 복사"),
  ];
}

/**
 * The three ways in, as buttons, for a start card or a sheet.
 * name: the pickers' name (see soundPickers); prefix: for these buttons' ids;
 * mic: micSupport(); canRecord: false while read-only; onRecord: start recording.
 */
export function waysIn({ app, roomId, root, name, prefix, mic, canRecord, onRecord }) {
  return [
    h("button", { type: "button", class: "btn rec-way", id: prefix + "record", disabled: !canRecord || !mic.ok, onclick: () => onRecord() }, h("span", { class: "dot-rec" }), "지금 이 앱에서 녹음"),
    !mic.ok && h("p", { class: "help warn", id: prefix + "mic-reason", text: micReason(mic.reason) }),
    mic.reason === "blocked" && h("div", { class: "elsewhere" }, ...elsewhere({ app, roomId, root, prefix })),
    h("label", { class: "btn quiet way", id: prefix + "capture", for: name + "-capture" }, "폰 녹음 앱으로 녹음하기"),
    h("p", { class: "help", text: "삼성 녹음 같은 폰의 녹음 앱이 열려요. 녹음을 마치면 바로 이 방으로 와요." }),
    h("label", { class: "btn quiet way", id: prefix + "file", for: name + "-file" }, "파일에서 가져오기"),
    h("p", { class: "help", text: "녹음 앱에 저장된 파일(m4a), mp3, wav 모두 돼요." }),
  ];
}

/** A picker was tapped and no chooser came. */
export function pickerHelp({ app, roomId, root, mic }) {
  return openSheet(root, "선택 창이 안 열렸나요?", (panel) => {
    panel.append(h("div", { class: "form", id: "picker-help" },
      h("p", { class: "help", text: mic.reason === "blocked"
        ? "Claude 앱 안에서는 파일 선택 창(폰 녹음 앱 포함)이 열리지 않을 수 있어요. 같은 방을 크롬에서 열면 폰 녹음 앱과 파일로 넣을 수 있어요."
        : "이 화면에서는 파일 선택 창이 열리지 않았어요. 같은 방을 크롬에서 열어 보세요." }),
      h("div", { class: "elsewhere" }, ...elsewhere({ app, roomId, root, prefix: "help-" }))));
  });
}
