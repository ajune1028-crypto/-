import test from "node:test";
import assert from "node:assert/strict";
import { findMatch, rankByName, snippet } from "../src/core/search.js";

const names = (list) => list.map((r) => r.item.name);
const rooms = (...list) => list.map((name, i) => ({ name, at: 100 - i }));

test("초성 alone: ㅅ finds 쇼타로; ㅅㅌ finds it too; ㅂ does not", () => {
  assert.deepEqual(findMatch("쇼타로", "ㅅ"), { at: 0, len: 1 });
  assert.deepEqual(findMatch("쇼타로", "ㅅㅌ"), { at: 0, len: 2 });
  assert.equal(findMatch("쇼타로", "ㅂ"), null);
});

test("a syllable still being typed matches what it can become: 쇼 finds 숀, 소 finds 솨, ㅌ as a last 받침 may begin the next syllable", () => {
  assert.deepEqual(findMatch("쇼타로", "쇼"), { at: 0, len: 1 });
  assert.deepEqual(findMatch("숀이", "쇼"), { at: 0, len: 1 });
  assert.deepEqual(findMatch("솨아", "소"), { at: 0, len: 1 });
  // Typing 쇼타 passes through 숕 (ㅌ attaches as 받침 until the vowel comes).
  assert.deepEqual(findMatch("쇼타로", "숕"), { at: 0, len: 2 });
  assert.deepEqual(findMatch("쇼타로", "쇼타"), { at: 0, len: 2 });
  assert.deepEqual(findMatch("쇼타로", "쇼탈"), { at: 0, len: 3 });
  // Only the last character may be unfinished: 쇼 in the middle of a query must be 쇼.
  assert.equal(findMatch("숀타로", "쇼타"), null);
  // A 받침 with two consonants, half typed: 닭 is on its way to 닭; 달 to 닭 too.
  assert.deepEqual(findMatch("닭갈비", "달"), { at: 0, len: 1 });
});

test("letters and spaces match as they are, any case", () => {
  assert.deepEqual(findMatch("Song Room", "room"), { at: 5, len: 4 });
  assert.deepEqual(findMatch("우리 보드", "리 보"), { at: 1, len: 3 });
  assert.equal(findMatch("우리 보드", ""), null);
});

test("ranking: names that begin with it first, then by how early it comes; the rest are left out", () => {
  const list = rooms("가을 산책", "쇼핑 목록", "우리 쇼타로", "쇼타로", "산", "노래 방");
  assert.deepEqual(names(rankByName(list, "ㅅ")), ["쇼핑 목록", "쇼타로", "산", "가을 산책", "우리 쇼타로"]);
  assert.deepEqual(names(rankByName(list, "쇼")), ["쇼핑 목록", "쇼타로", "우리 쇼타로"]);
  assert.deepEqual(names(rankByName(list, "쇼타")), ["쇼타로", "우리 쇼타로"]);
  assert.deepEqual(names(rankByName(list, "ㄴ")), ["노래 방"]);
});

test("snippet: the words around a match, the match marked", () => {
  const text = "어제는 바다에 갔다. 오늘은 쇼타로랑 산책을 하고 저녁에는 노래를 불렀다.";
  const s = snippet(text, "쇼타", 8);
  assert.equal(s.match, "쇼타");
  assert.ok(s.before.length <= 9 && s.before.endsWith("오늘은 "), JSON.stringify(s));
  assert.ok(s.after.startsWith("로랑"), JSON.stringify(s));
  assert.equal(snippet(text, "없는말"), null);
});
