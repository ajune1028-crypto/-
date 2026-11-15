import test from "node:test";
import assert from "node:assert/strict";
import { soundTitle } from "../src/ui/names.js";

test("a recording's name says what it came from: an mp3, a camera video, a take made here", () => {
  assert.deepEqual(soundTitle("우리 노래.mp3"), { title: "우리 노래", kind: "mp3", long: "mp3 파일" });
  assert.deepEqual(soundTitle("IMG_0042.MOV"), { title: "IMG_0042", kind: "영상", long: "영상의 소리" });
  assert.deepEqual(soundTitle("Voice 001.m4a"), { title: "Voice 001", kind: "m4a", long: "m4a 파일" });
  assert.deepEqual(soundTitle(null, "녹음 3"), { title: "녹음 3", kind: "녹음", long: "이 앱에서 녹음" });
  assert.deepEqual(soundTitle("예시 녹음 · 도레미파솔미도"), { title: "예시 녹음 · 도레미파솔미도", kind: null, long: null });
});
