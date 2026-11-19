// Every kind of room, in one place. Home offers them under its halves; the
// room frame mounts the one a room was made as. Adding a kind of room is one
// entry here plus its screen module.
//
// A screen module exports mount(body, app, session, frame):
//   body     the room's scrolling area, empty
//   frame    { top }: an empty row between the room's bar and the body, for
//            controls that stay in view (the song room's 원본 | 피아노)
// and returns a cleanup function, or { close, settings } where settings(close)
// gives extra sections for the room's settings sheet.

import { mountTextRoom } from "./text-room.js";
import { mountSongRoom } from "./song-room.js";
import { mountBoardRoom } from "./board-room.js";
import { mountDrawRoom } from "./draw-room.js";

/**
 * The halves of home. 레퍼런스 is not a half: it is a private sheet opened from
 * home and from every room's bar (ui/reference.js), kept on the device only.
 */
export const SIDES = {
  daily: { title: "일상", note: "가볍게, 매일" },
  creative: { title: "창작", note: "같이 만들기" },
};

export const ROOM_KINDS = [
  { kind: "daily-text", side: "daily", name: "텍스트", icon: "lines", note: "같은 종이에 같이 써요", mount: mountTextRoom },
  { kind: "daily-photo", side: "daily", name: "사진", icon: "photo", note: "시간대별 사진과 3초 영상" },
  { kind: "daily-both", side: "daily", name: "통합", icon: "mixed", note: "텍스트와 사진을 한 방에" },
  { kind: "creative-song", side: "creative", name: "노래 만들기", icon: "note", note: "흥얼거리면 피아노 음이 돼요", mount: mountSongRoom },
  { kind: "creative-writing", side: "creative", name: "글쓰기", icon: "pen", note: "같이 쓰는 문서" },
  { kind: "creative-board", side: "creative", name: "화이트보드", icon: "board", note: "노래 카드를 놓고 재생 순서를 이어요", mount: mountBoardRoom },
  { kind: "creative-draw", side: "creative", name: "그림", icon: "pen", note: "같이 그리는 종이, 레이어", mount: mountDrawRoom },
];

export function kindsOf(side) {
  return ROOM_KINDS.filter((k) => k.side === side);
}

/** The kind's entry; rooms made before kinds were recorded are text rooms. */
export function kindInfo(kind) {
  return ROOM_KINDS.find((k) => k.kind === (kind || "daily-text")) || null;
}

/** Which half of home a kind belongs to, also for kinds this version does not know. */
export function sideOf(kind) {
  return kindInfo(kind)?.side || (String(kind).startsWith("creative") ? "creative" : "daily");
}
