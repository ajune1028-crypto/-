// 몸짓 (the day's plan 8; the 검토's discomforts: "몸짓을 알 길이 없다"): what fingers can do, on a page
// of 설정 grouped by where it works, and once per kind of place a single short line the first time
// (never again on this device). Nothing here covers anything for long: a line, then it goes.

import { h, toast } from "./dom.js";

/** Where each gesture works, and what it does (only what the app really does). */
export const GESTURES = [
  ["그리기 · 글 방, 그림 방, 애니메이션, 화이트보드", [
    ["두 손가락 톡", "되돌리기"],
    ["세 손가락 톡", "다시하기"],
    ["네 손가락 톡", "도구 숨기기·보이기"],
    ["두 손가락 꾹", "스포이트 (두 손가락 사이 색 고르기)"],
    ["선을 긋고 잠깐 멈추기", "모양 잡기 (직선·원·네모…)"],
    ["두 손가락 벌리기·오므리기", "확대·축소"],
    ["그리기 막대 끝 손잡이 꾹", "조각을 떼어 원하는 곳에·가까이 두면 붙음 (손잡이 톡 = 90° 돌리기)"],
    ["색 버튼 꾹 들어 종이에 놓기", "그 자리 채우기 (그림·애니메이션)"],
    ["놓기 전에 멈추고 좌우로 (채우기 붓은 누른 채)", "채우는 정도"],
  ]],
  ["애니메이션", [
    ["장 꾹 들어 끌기", "장 순서 바꾸기"],
    ["장 꾹 하고 그대로 떼기", "길게·복제·지우기"],
    ["배경 칸 꾹", "종이 고르기"],
    ["소리 꾹 들어 끌기", "다른 장으로 (그대로 떼면 듣기·지우기)"],
  ]],
  ["노래 방", [
    ["두 손가락 가로·세로", "시간·줄 높이 확대"],
    ["클립 꾹 누른 채 끌기", "옮기기"],
    ["● 꾹", "어떻게 녹음할지 고르기"],
    ["멈춘 채 클립 톡", "재생선이 그 자리로"],
  ]],
  ["글 방", [
    ["글자 꾹", "누가 언제 썼는지"],
    ["두 번 톡", "색 섞기"],
    ["반짝이는 글자 2초 꾹", "숨은 사진·녹음"],
    ["날짜 이름 톡", "이 날 잠그기"],
  ]],
  ["화이트보드", [
    ["모드 막대 꾹", "막대 꾸미기·옮기기"],
    ["올가미 끝을 시작에 닿게", "닫기 (다른 손가락 톡으로도)"],
  ]],
  ["홈", [
    ["방 꾹", "집에 넣기"],
    ["방을 두 손가락으로 톡", "그 방의 역사와 할 일 (마우스는 왼쪽+오른쪽)"],
    ["햇살을 던지기", "던진 쪽에서 창이 나와요"],
    ["일상·창작 사이 선 꾹 (가운데보다 조금 위)", "두 칸의 너비 옮기기"],
    ["보드: 방 꾹 하고 끌기", "원하는 칸에 놓기"],
    ["보드: 방 꾹 하고 그대로 떼기", "모서리 손잡이로 크기 (한 칸이면 아이콘)"],
  ]],
];

/** 설정 → 몸짓: every gesture, grouped by where it works. */
export function gesturesPage() {
  return h("div", { class: "gestures", id: "gestures" },
    ...GESTURES.map(([place, list]) => h("div", { class: "section" },
      h("p", { class: "section-title", text: place }),
      h("div", { class: "gesture-list" }, ...list.map(([how, what]) => h("div", { class: "gesture-row" },
        h("span", { class: "gesture-how", text: how }), h("span", { class: "gesture-what", text: what })))))));
}

/** The one line each kind of place says the first time (then never again on this device). */
const FIRST = {
  draw: "두 손가락 톡 되돌리기 · 세 손가락 다시하기 · 두 손가락 꾹 스포이트",
  song: "두 손가락으로 확대 · 클립 꾹 눌러 옮기기 · ● 꾹 녹음 방법",
  text: "글자 꾹 = 누가 언제 · 두 번 톡 = 색 섞기",
  home: "방 꾹 = 집에 넣기 · 햇살을 던지면 그쪽에서 나와요",
};

/** Once per kind of place, a short line about its gestures (and where to see them all). */
export function hintOnce(app, kind) {
  if (!app.hints || !FIRST[kind]) return false;
  const key = "hint-" + kind;
  try {
    if (app.store.get(key, false)) return false;
    app.store.set(key, true);
  } catch {
    return false;
  }
  toast(app.root, FIRST[kind] + " · 설정 → 몸짓", 4600);
  return true;
}
