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
import { micProblem } from "../audio/recorder.js";

// Videos too: their sound is used (an iPhone or iPad answers "record a sound" with the camera).
export const AUDIO_TYPES = "audio/*,video/*,.m4a,.mp3,.wav,.aac,.ogg,.oga,.opus,.webm,.3gp,.amr,.flac,.mov,.mp4";

/** iPhone and iPad (an iPad says it is a Mac, with a touch screen). */
export function isApple() {
  const n = globalThis.navigator;
  return !!n && (/iP(hone|ad|od)/.test(n.userAgent || "") || (n.platform === "MacIntel" && n.maxTouchPoints > 1));
}
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

/**
 * The public build: opens in any browser with no login and records there (its rooms stay on that
 * device until the room server is set). Claude's own page needs its owner's Claude login in that
 * browser and has no microphone anyway, so from inside Claude, Chrome is sent here.
 */
export const PUBLIC_APP = "https://raw.githack.com/ajune1028-crypto/-/main/site/index.html";

/** 크롬에서 열기 and 링크 복사: the same room, or from inside Claude the public build. */
export function elsewhere({ app, roomId, root, prefix }) {
  const inClaude = app.transport?.info?.().kind === "claude";
  // Outside a room (레퍼런스 from home), the app's own address.
  const link = inClaude ? PUBLIC_APP : roomId ? app.linkFor(roomId) : String(app.shareBase() || location.href).split("#")[0];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast(root, "링크를 복사했어요. 크롬 주소창에 붙여 넣으면 같은 방이 열려요", 3600);
    } catch {
      toast(root, link, 8000);
    }
  };
  return [
    h("a", { class: "btn quiet small", id: prefix + "open-browser", href: link, target: "_blank", rel: "noopener" }, inClaude ? "크롬에서 열기 (녹음되는 공개 주소)" : "크롬에서 열기"),
    inClaude && h("p", { class: "help", id: prefix + "public-note", text: "로그인 없이 열리고 녹음이 돼요. 다만 그곳의 방은 그 기기에만 생겨요(서버를 켜기 전까지)." }),
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
    // A phone's own recorder app (the owner, 22 November: "녹음 앱을 들어가게 해야 돼… 핸드폰 녹음 앱도
    // 저장되고 여기서도 나오고"): Android opens it from a page (삼성 녹음 and the like), the take stays there
    // and comes straight here. iPhone and iPad cannot open 음성 메모 from a page (Apple keeps it shut) and
    // offer the camera instead, which is not a recording ("동영상으로 찍어서 음원 추출… 그거 말고"): there
    // a voice memo comes in as a file, and a take made here can be saved to the phone from 비서's 녹음.
    !isApple() && h("label", { class: "btn quiet way", id: prefix + "capture", for: name + "-capture" }, "폰 녹음 앱으로 녹음하기"),
    !isApple() && h("p", { class: "help", text: "삼성 녹음 같은 폰의 녹음 앱이 열려요. 녹음은 그 앱에도 남고, 마치면 바로 여기로 와요." }),
    h("label", { class: "btn quiet way", id: prefix + "file", for: name + "-file" }, isApple() ? "음성 메모·파일에서 가져오기" : "파일에서 가져오기"),
    h("p", { class: "help", text: isApple() ? "음성 메모에서 녹음 → 공유 → '파일에 저장' 한 뒤 여기서 골라요. 아이폰·아이패드는 웹에서 녹음 앱을 바로 열 수 없어서 이렇게 가져와요. 여기서 녹음한 것은 비서의 녹음에서 '폰에 저장'으로 폰에도 남겨요." : "녹음 앱에 저장된 파일(m4a), mp3, wav, 영상(소리만) 모두 돼요." }),
    // Only what is there: a caller may append these as they are, and `false` would show as the word.
  ].filter(Boolean);
}

/** Where this browser keeps a site's microphone permission, in steps a person can follow. */
export function micSteps() {
  const ua = globalThis.navigator?.userAgent || "";
  if (isApple() && /CriOS/.test(ua)) return "설정 앱 → Chrome → 마이크를 켜 주세요. 그다음 '다시 불러오기'를 누르세요.";
  if (isApple()) return "주소창 왼쪽의 '가가'(aA) → '웹 사이트 설정' → '마이크' → '허용'(또는 '확인')을 고르세요. 그다음 '다시 불러오기'를 누르세요. 그래도 안 되면 설정 앱 → Safari → 마이크 → '확인'.";
  if (/SamsungBrowser/.test(ua)) return "주소창의 자물쇠 → '권한'(사이트 권한) → '마이크' → 허용. 그다음 '다시 불러오기'를 누르세요.";
  if (/Android/.test(ua)) return "주소창 왼쪽의 아이콘(ⓘ 또는 조절 모양) → '권한' → '마이크' → 허용. 안 보이면 크롬 ⋮ → 설정 → 사이트 설정 → 마이크. 그다음 '다시 불러오기'를 누르세요.";
  return "주소창 왼쪽의 자물쇠(또는 조절 모양) → '마이크' → 허용. 그다음 '다시 불러오기'를 누르세요.";
}

/**
 * Recording was refused. Where the browser can still ask, one tap brings its own
 * "허용하시겠습니까?" back (the question only comes from a tap); where the site is
 * blocked, the steps for this browser and a reload. retry() records once allowed.
 */
export function micRefused({ app, root, err, retry }) {
  const name = err?.name || "";
  if (name !== "NotAllowedError" && name !== "SecurityError") return void toast(root, micProblem(err), 3600);
  // Claude's own page has no microphone to give.
  if (app.transport?.info?.().kind === "claude") return void toast(root, micReason("blocked"), 5200);
  openSheet(root, "마이크를 허용해 주세요", (panel, close) => {
    const steps = h("p", { class: "help warn", id: "mic-steps", hidden: true, text: micSteps() });
    const allow = h("button", { type: "button", class: "btn", id: "mic-allow", onclick: () => {
      // Asked straight from this tap, so the browser shows its own question.
      const asked = performance.now();
      let ask;
      try {
        ask = navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        ask = Promise.reject(e);
      }
      ask.then((stream) => {
        for (const t of stream.getTracks()) t.stop();
        close();
        toast(root, "마이크가 켜졌어요", 1800);
        retry?.();
      }, () => {
        // Refused at once, with no question: the site is blocked in the browser's settings.
        steps.hidden = false;
        allow.textContent = performance.now() - asked < 700 ? "다시 물어보기" : "마이크 허용하기";
      });
    } }, "마이크 허용하기");
    panel.append(h("div", { class: "form", id: "mic-help" },
      h("p", { class: "help", text: "녹음하려면 이 페이지에 마이크를 허용해야 해요. 아래 버튼을 누르면 브라우저가 허용할지 물어봐요." }),
      allow, steps,
      h("button", { type: "button", class: "btn quiet", id: "mic-reload", onclick: () => location.reload() }, "다시 불러오기")));
    // Already blocked: the steps at once (the button may still bring the question back).
    navigator.permissions?.query?.({ name: "microphone" }).then((p) => { if (p.state === "denied") steps.hidden = false; }, () => {});
  });
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
