// Finding rooms (and what they hold) by a few typed letters, the way Korean is typed.
//
// The owner: "쇼타로면 ㅅ만 쳐도 앞 초성이 ㅅ인 것부터 다 나오고, 그 다음 ㅅ이 뒤에 나오는 것, 쇼를 치면
// 앞에 쇼가 있는 것 먼저, 다음에 쇼가 어디 들어가는 것. 아닌 것은 다 안 보이게."
//
// So: a lone consonant (초성) stands for any syllable that begins with it; the last character of
// the query may still be on its way (쇼 is on the way to 숀, 소 to 솨, 숕 to 쇼타 — while typing
// 쇼타 the ㅌ sits as a 받침 until the vowel comes); everything else must be as typed. Matches that
// begin earlier come first.

const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
/** A 받침 of two consonants, as the two typed one after the other. */
const TWO = { ㄳ: ["ㄱ", "ㅅ"], ㄵ: ["ㄴ", "ㅈ"], ㄶ: ["ㄴ", "ㅎ"], ㄺ: ["ㄹ", "ㄱ"], ㄻ: ["ㄹ", "ㅁ"], ㄼ: ["ㄹ", "ㅂ"], ㄽ: ["ㄹ", "ㅅ"], ㄾ: ["ㄹ", "ㅌ"], ㄿ: ["ㄹ", "ㅍ"], ㅀ: ["ㄹ", "ㅎ"], ㅄ: ["ㅂ", "ㅅ"] };
/** A vowel typed in two strokes, by its first stroke (소 is on the way to 솨). */
const FIRST_STROKE = { ㅘ: "ㅗ", ㅙ: "ㅗ", ㅚ: "ㅗ", ㅝ: "ㅜ", ㅞ: "ㅜ", ㅟ: "ㅜ", ㅢ: "ㅡ" };

function parts(ch) {
  if (!ch) return null;
  const c = ch.charCodeAt(0) - 0xac00;
  if (ch.length !== 1 || c < 0 || c > 11171) return null;
  return { cho: CHO[Math.floor(c / 588)], jung: JUNG[Math.floor((c % 588) / 28)], jong: JONG[c % 28] };
}

const isConsonant = (ch) => ch.length === 1 && CHO.includes(ch);

/** A syllable's first sound (초성): 고 → ㄱ; anything else stays as it is. */
export function initialOf(ch) {
  return parts(ch)?.cho ?? ch;
}

/** How many characters of `text` from i the query character q takes (0: it does not match). */
function step(q, last, text, i) {
  const c = text[i];
  if (c === undefined) return 0;
  if (isConsonant(q)) {
    if (c === q) return 1;
    return parts(c)?.cho === q ? 1 : 0;
  }
  const pq = parts(q);
  if (!pq) return c.toLowerCase() === q.toLowerCase() ? 1 : 0;
  if (c === q) return 1;
  if (!last) return 0;
  const pc = parts(c);
  if (!pc || pc.cho !== pq.cho) return 0;
  if (!pq.jong) return pc.jung === pq.jung || FIRST_STROKE[pc.jung] === pq.jung ? 1 : 0;
  if (pc.jung !== pq.jung) return 0;
  // 달 on its way to 닭.
  if (TWO[pc.jong]?.[0] === pq.jong) return 1;
  // 숕 on its way to 쇼타: the 받침 begins the next syllable.
  const [first, second] = TWO[pq.jong] || [pq.jong, ""];
  const next = text[i + 1];
  const nextCho = parts(next)?.cho || next;
  if (!second && !pc.jong && nextCho === first) return 2;
  if (second && pc.jong === first && nextCho === second) return 2;
  return 0;
}

/** Where the query first appears in the text: { at, len } in characters, or null. */
export function findMatch(text, query) {
  const t = [...String(text || "")];
  const q = [...String(query || "")];
  if (!q.length) return null;
  for (let i = 0; i < t.length; i++) {
    let j = i;
    let ok = true;
    for (let k = 0; k < q.length; k++) {
      const n = step(q[k], k === q.length - 1, t, j);
      if (!n) {
        ok = false;
        break;
      }
      j += n;
    }
    if (ok) return { at: i, len: j - i };
  }
  return null;
}

/**
 * Things whose name holds the query, those where it comes earliest first (then the most recent):
 * [{ item, at, len }]. The rest are left out.
 */
export function rankByName(items, query, nameOf = (x) => x.name) {
  const found = [];
  for (const item of items) {
    const m = findMatch(nameOf(item), query);
    if (m) found.push({ item, ...m });
  }
  return found.sort((a, b) => a.at - b.at || (b.item.at || 0) - (a.item.at || 0));
}

/** The words around the first match: { before, match, after, at }, or null. */
export function snippet(text, query, around = 24) {
  const m = findMatch(text, query);
  if (!m) return null;
  const t = [...String(text)];
  const from = Math.max(0, m.at - around);
  const to = Math.min(t.length, m.at + m.len + around * 2);
  return {
    before: (from > 0 ? "…" : "") + t.slice(from, m.at).join(""),
    match: t.slice(m.at, m.at + m.len).join(""),
    after: t.slice(m.at + m.len, to).join("") + (to < t.length ? "…" : ""),
    at: m.at,
  };
}
