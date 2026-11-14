// Day sheets and time stamps, always in the room's time zone.

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const formats = new Map();

function format(tz) {
  if (!formats.has(tz)) {
    const options = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" };
    let f;
    try {
      f = new Intl.DateTimeFormat("en-US", { ...options, timeZone: tz });
    } catch {
      f = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
    }
    formats.set(tz, f);
  }
  return formats.get(tz);
}

function parts(ms, tz) {
  const out = {};
  for (const { type, value } of format(tz).formatToParts(ms)) out[type] = value;
  return { year: out.year, month: out.month, day: out.day, hour: Number(out.hour) % 24 };
}

/** "YYYY-MM-DD" of the moment in the given time zone. */
export function dayKey(ms, tz) {
  const p = parts(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

function monthDay(key) {
  const [, m, d] = key.split("-").map(Number);
  return `${m}월 ${d}일`;
}

/** "11월 10일 화요일" */
export function dayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  return `${monthDay(key)} ${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}요일`;
}

/** "오후 3시" */
export function hourLabel(ms, tz) {
  const { hour } = parts(ms, tz);
  return `${hour < 12 ? "오전" : "오후"} ${hour % 12 === 0 ? 12 : hour % 12}시`;
}

/**
 * One label per line, or null. A line gets a label when its hour differs from
 * the labelled line above it; empty lines (`at: null`) never do. A line written
 * on a day other than the sheet's own carries the date too.
 */
export function lineStamps(lines, tz, sheetDay) {
  let last = null;
  return lines.map(({ at }) => {
    if (at === null || at === undefined) return null;
    const day = dayKey(at, tz);
    const bucket = day + " " + parts(at, tz).hour;
    if (bucket === last) return null;
    last = bucket;
    return (day === sheetDay ? "" : monthDay(day) + " ") + hourLabel(at, tz);
  });
}
