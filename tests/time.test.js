import test from "node:test";
import assert from "node:assert/strict";
import { dayKey, dayLabel, hourLabel } from "../src/core/time.js";

const at = (iso) => Date.parse(iso);

test("dayKey respects the room time zone", () => {
  assert.equal(dayKey(at("2026-11-10T15:30:00Z"), "Asia/Seoul"), "2026-11-11");
  assert.equal(dayKey(at("2026-11-10T15:30:00Z"), "UTC"), "2026-11-10");
  assert.equal(dayKey(at("2026-11-10T14:59:59Z"), "Asia/Seoul"), "2026-11-10");
});

test("an unknown time zone falls back to UTC instead of throwing", () => {
  assert.equal(dayKey(at("2026-11-10T15:30:00Z"), "Nowhere/Land"), "2026-11-10");
});

test("dayLabel reads as month, day and weekday", () => {
  assert.equal(dayLabel("2026-11-10"), "11월 10일 화요일");
  assert.equal(dayLabel("2026-01-04"), "1월 4일 일요일");
});

test("hourLabel uses 오전 and 오후 with a 12-hour number", () => {
  assert.equal(hourLabel(at("2026-11-10T06:00:00Z"), "Asia/Seoul"), "오후 3시");
  assert.equal(hourLabel(at("2026-11-10T15:10:00Z"), "Asia/Seoul"), "오전 12시");
  assert.equal(hourLabel(at("2026-11-10T03:00:00Z"), "Asia/Seoul"), "오후 12시");
  assert.equal(hourLabel(at("2026-11-10T00:59:00Z"), "Asia/Seoul"), "오전 9시");
});

