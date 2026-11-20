import test from "node:test";
import assert from "node:assert/strict";
import {
  PALETTE, INK, PAPER, memberColor, hexToOklch, oklchToHex, contrast, mixColors,
  splitWords, paintFor, paintCss,
} from "../src/core/paint.js";

const THEMES = ["light", "dark"];
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** Visible chars for a string; `who` maps each index to an author, ids rise with `order`. */
function chars(text, who = () => "A", order = (i) => i + 1) {
  return [...text].map((v, i) => ({ id: order(i) + "@x", v, by: who(i), at: 0 }));
}
const opts = (over = {}) => ({
  color: (by) => ({ A: "#aa0000", B: "#0000aa", C: "#00aa00", D: "#aaaa00" })[by],
  level: 0, colors: true, mixing: true, ink: "#111111", theme: "light", ...over,
});

test("every palette colour reads at 4.5:1 on paper, light and dark", () => {
  assert.equal(PALETTE.length, 8);
  for (const theme of THEMES) {
    for (let i = 0; i < 8; i++) assert.ok(contrast(memberColor(i, theme), PAPER[theme]) >= 4.5, `${theme} ${i}`);
    assert.ok(contrast(INK[theme], PAPER[theme]) >= 7);
  }
});

test("palette colours are at least 30 degrees of hue apart and wrap after eight", () => {
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) assert.ok(hueGap(PALETTE[i].h, PALETTE[j].h) >= 30, `${i} ${j}`);
  assert.equal(memberColor(8, "light"), memberColor(0, "light"));
});

test("hex ↔ oklch round-trips within 1/255", () => {
  for (const hex of ["#000000", "#ffffff", "#d83a34", "#2f6fde", "#e5b800", "#3aa57a", "#808080"]) {
    const { l, c, h } = hexToOklch(hex);
    const back = oklchToHex(l, c, h);
    for (let k = 1; k < 7; k += 2) assert.ok(Math.abs(parseInt(hex.slice(k, k + 2), 16) - parseInt(back.slice(k, k + 2), 16)) <= 1, hex + " " + back);
  }
});

test("red and blue mix to purple, blue and yellow mix to green", () => {
  const purple = hexToOklch(mixColors(["#d83a34", "#2f6fde"], "light")).h;
  assert.ok(purple >= 280 && purple <= 345, "purple hue " + purple);
  const green = hexToOklch(mixColors(["#2f6fde", "#e5b800"], "light")).h;
  assert.ok(green >= 125 && green <= 200, "green hue " + green);
  assert.equal(mixColors(["#d83a34", "#2f6fde"], "light"), mixColors(["#d83a34", "#2f6fde"], "light"));
});

test("a mixed colour still reads at 4.5:1 in both themes", () => {
  for (const theme of THEMES) {
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) for (let k = 0; k < 8; k += 3) {
      const mixed = mixColors([memberColor(i, theme), memberColor(j, theme), memberColor(k, theme)], theme);
      assert.ok(contrast(mixed, PAPER[theme]) >= 4.5, `${theme} ${i} ${j} ${k} ${mixed}`);
    }
  }
});

test("splitWords: spaces and newlines separate, lines count up", () => {
  const words = splitWords(chars("ab cd\nef"));
  assert.deepEqual(words.map((w) => [w.start, w.end, w.line]), [[0, 2, 0], [3, 5, 0], [6, 8, 1]]);
  assert.equal(words[0].anchor, "1@x");
  assert.deepEqual(splitWords(chars("  \n ")), []);
});

test("authors are ordered by who wrote first, top is whoever wrote most", () => {
  // "abcd": B wrote b,c,d later; A wrote a first.
  const [w] = splitWords(chars("abcd", (i) => (i === 0 ? "A" : "B")));
  assert.deepEqual(w.authors, ["A", "B"]);
  assert.equal(w.top, "B");
  // B's char has the lowest id although it stands last.
  const [v] = splitWords(chars("ab", (i) => (i === 0 ? "A" : "B"), (i) => (i === 0 ? 9 : 2)));
  assert.deepEqual(v.authors, ["B", "A"]);
  assert.equal(v.top, "B");
});

test("one author is solid, two split with the first writer on top, three or more a wheel", () => {
  const one = splitWords(chars("ab"))[0];
  assert.deepEqual(paintFor(one, null, null, opts()), { k: "solid", c: "#aa0000" });
  const two = splitWords(chars("ab", (i) => "AB"[i]))[0];
  assert.deepEqual(paintFor(two, null, null, opts()), { k: "split", top: "#aa0000", bottom: "#0000aa" });
  const four = splitWords(chars("abcd", (i) => "ABCD"[i]))[0];
  assert.deepEqual(paintFor(four, null, null, opts()), { k: "wheel", cs: ["#aa0000", "#0000aa", "#00aa00", "#aaaa00"] });
});

test("mixing off gives the majority colour and ignores levels", () => {
  const w = splitWords(chars("abc", (i) => "ABB"[i]))[0];
  assert.deepEqual(paintFor(w, null, null, opts({ mixing: false, level: 2 })), { k: "solid", c: "#0000aa" });
});

test("colours off gives ink", () => {
  const w = splitWords(chars("ab", (i) => "AB"[i]))[0];
  assert.deepEqual(paintFor(w, null, null, opts({ colors: false, level: 1 })), { k: "ink" });
});

test("level 1 seeps the neighbours in; a missing side stays as it is", () => {
  const [l, m, r] = splitWords(chars("b a c", (i) => "B A C"[i]));
  assert.deepEqual(paintFor(m, l, r, opts({ level: 1 })), { k: "seep", base: { k: "solid", c: "#aa0000" }, l: "#0000aa", r: "#00aa00" });
  assert.deepEqual(paintFor(m, null, r, opts({ level: 1 })), { k: "seep", base: { k: "solid", c: "#aa0000" }, l: null, r: "#00aa00" });
  assert.deepEqual(paintFor(m, null, null, opts({ level: 1 })), { k: "solid", c: "#aa0000" });
});

test("a neighbour written by several people lends its first writer's colour", () => {
  const [l, m] = splitWords(chars("bc a", (i) => "BC A"[i]));
  assert.equal(paintFor(m, l, null, opts({ level: 1 })).l, "#0000aa");
});

test("level 2 is one solid colour mixed from the word and its neighbours", () => {
  const [l, m, r] = splitWords(chars("b a c", (i) => "B A C"[i]));
  const p = paintFor(m, l, r, opts({ level: 2 }));
  assert.equal(p.k, "solid");
  assert.equal(p.c, mixColors(["#aa0000", "#0000aa", "#00aa00"], "light"));
  assert.deepEqual(paintFor(m, null, null, opts({ level: 2 })), { k: "solid", c: "#aa0000" });
});

test("paintCss: ink is empty, solid a colour, split vertical, wheel conic, seep layered", () => {
  assert.deepEqual(paintCss({ k: "ink" }), {});
  assert.deepEqual(paintCss({ k: "solid", c: "#aa0000" }), { color: "#aa0000" });
  const split = paintCss({ k: "split", top: "#aa0000", bottom: "#0000aa" }).background;
  assert.match(split, /^linear-gradient\(to bottom, #aa0000 0%, #aa0000 \d+%, #0000aa \d+%, #0000aa 100%\)$/);
  const wheel = paintCss({ k: "wheel", cs: ["#aa0000", "#0000aa", "#00aa00"] }).background;
  assert.equal(wheel, "conic-gradient(from var(--spin, 0deg) at 50% 50%, #aa0000 0deg, #aa0000 30deg, #0000aa 90deg, #0000aa 150deg, #00aa00 210deg, #00aa00 270deg, #aa0000 330deg, #aa0000 360deg)");
  const seep = paintCss({ k: "seep", base: { k: "solid", c: "#aa0000" }, l: "#0000aa", r: null }).background;
  assert.match(seep, /^linear-gradient\(to right, #0000aa 0%, #0000aa00 \d+%\), linear-gradient\(#aa0000, #aa0000\)$/);
});

/** Share of a w×h box that each colour of a conic gradient covers (blends split at their midpoint). */
function wheelShares(css, w, h) {
  const stops = [...css.matchAll(/(#[0-9a-f]{6}) ([\d.]+)deg/g)].map((m) => ({ c: m[1], a: Number(m[2]) }));
  const share = new Map();
  let total = 0;
  for (let x = -w / 2 + 0.25; x < w / 2; x += 0.5) {
    for (let y = -h / 2 + 0.25; y < h / 2; y += 0.5) {
      const angle = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
      let k = 0;
      while (k < stops.length - 2 && stops[k + 1].a < angle) k++;
      const c = angle - stops[k].a < stops[k + 1].a - angle ? stops[k].c : stops[k + 1].c;
      share.set(c, (share.get(c) || 0) + 1);
      total++;
    }
  }
  return [...share.values()].map((n) => n / total);
}

test("a wheel on a wide word still gives every writer a fair share of the letters", () => {
  const colours = ["#aa0000", "#0000aa", "#00aa00", "#aaaa00", "#00aaaa"];
  for (const n of [3, 4, 5]) {
    for (const aspect of [1, 2.5, 4, 7]) {
      const css = paintCss({ k: "wheel", cs: colours.slice(0, n) }, aspect).background;
      const shares = wheelShares(css, 20 * aspect, 20);
      assert.equal(shares.length, n);
      // Fair means no slivers: on a square, equal angles already differ a little because corners reach further.
      for (const s of shares) assert.ok(s > 0.6 / n && s < 1.5 / n, `n=${n} aspect=${aspect} shares=${shares.map((x) => x.toFixed(2))}`);
    }
  }
});

test("a seeping wheel keeps its fair shares too", () => {
  const css = paintCss({ k: "seep", base: { k: "wheel", cs: ["#aa0000", "#0000aa", "#00aa00"] }, l: "#aaaa00", r: null }, 4).background;
  assert.match(css, /^linear-gradient\(to right, #aaaa00 0%, #aaaa0000 \d+%\), conic-gradient\(/);
  assert.notEqual(css, paintCss({ k: "seep", base: { k: "wheel", cs: ["#aa0000", "#0000aa", "#00aa00"] }, l: "#aaaa00", r: null }, 1).background);
});

test("an accent of your own: text on it reads, and its icons show on both papers", async () => {
  const { accentColors, contrast, PAPER } = await import("../src/core/paint.js");
  for (const hex of ["#2466dc", "#6d4ae0", "#d03d78", "#16865a", "#c8550f", "#0d7d8f", "#3a3d46", "#ffe14d", "#a0f0ff", "#000000", "#ffffff"]) {
    const c = accentColors(hex);
    assert.equal(c["--accent"], hex, "the colour itself is kept as chosen");
    // White or near-black, whichever reads better; a mid-grey can reach no more than about 4.4.
    assert.ok(contrast(c["--on-accent"], hex) >= 4.4, `${hex}: text on it ${contrast(c["--on-accent"], hex).toFixed(2)}`);
    for (const paper of [PAPER.light, PAPER.dark]) {
      if (hex === "#000000" || hex === "#ffffff") continue;
      assert.ok(contrast(c["--accent-ink"], paper) >= 3, `${hex}: icon colour ${c["--accent-ink"]} on ${paper} is ${contrast(c["--accent-ink"], paper).toFixed(2)}`);
    }
  }
  assert.equal(accentColors("#2466dc")["--on-accent"], "#ffffff");
  assert.equal(accentColors("#ffe14d")["--on-accent"], "#111216", "dark text on a light yellow");
});

test("my people colour is the one nearest my glass colour, among those nobody has; grey has no preference", async () => {
  const { nearestPeopleColor } = await import("../src/core/paint.js");
  const index = (key) => PALETTE.findIndex((p) => p.key === key);
  assert.equal(nearestPeopleColor("#2466dc"), index("blue"), "파랑 glass: blue");
  assert.equal(nearestPeopleColor("#e05298"), index("pink"), "핑크 glass: pink");
  assert.equal(nearestPeopleColor("#d93a3a"), index("coral"), "빨강 glass: coral");
  assert.equal(nearestPeopleColor("#2e9a4f"), index("green"), "초록 glass: green");
  const next = nearestPeopleColor("#2466dc", new Set([index("blue")]));
  assert.ok(next !== index("blue") && next >= 0, "blue taken: the next nearest");
  assert.equal(nearestPeopleColor("#3a3d46"), null, "흑백: no preference");
  assert.equal(nearestPeopleColor(null), null);
});

test("모래 필름: grains in my colour and its neighbour, with pale (light) or bright (dark) sand; a picture the browser can tile", async () => {
  const { filmImage } = await import("../src/core/paint.js");
  const light = filmImage("#e0559a", "#e07a55", false);
  const dark = filmImage("#e0559a", "#e07a55", true);
  assert.match(light, /^url\("data:image\/svg\+xml;utf8,<svg /);
  assert.ok(light.endsWith('</svg>")'));
  // My colour (0.878 0.333 0.604) and its neighbour are in it.
  assert.ok(light.includes("0.878") && light.includes("0.333") && light.includes("0.604"), "my colour's grains");
  assert.ok(light.includes("0.878 ") && light.includes("0.478"), "the neighbour's grains");
  assert.notEqual(light, dark, "the dark film has bright sand");
  assert.ok(!/[#"]/.test(light.slice(5, -2)), "nothing that would end the picture early (# as %23, no double quotes)");
  assert.equal(filmImage("nonsense", "#000000", false), filmImage("#8c919c", "#000000", false), "a colour it cannot read is grey");
});

// 사람 색을 직접 고르기 (roadmap 7): a colour of my own, not only the palette's eight. It keeps its hue
// and strength; only its lightness moves, as far as it must, for the words to read on either paper.
test("personColor: a member's own colour reads on the light and the dark paper (4.5:1), keeps its hue, and without one the palette colour is used", async () => {
  const { personColor, memberColor, contrast, PAPER, hexToOklch } = await import("../src/core/paint.js");
  for (const hex of ["#ff7a00", "#00c2a8", "#8a2be2", "#ffe066", "#111111", "#f5f5f5"]) {
    for (const theme of ["light", "dark"]) {
      const c = personColor({ color: 2, hex }, theme);
      assert.ok(contrast(c, PAPER[theme]) >= 4.5, `${hex} on ${theme}: ${c} ${contrast(c, PAPER[theme]).toFixed(2)}`);
      const a = hexToOklch(hex), b = hexToOklch(c);
      if (a.c > 0.04) assert.ok(Math.abs(((a.h - b.h + 540) % 360) - 180) < 12, `${hex} keeps its hue on ${theme}: ${c}`);
    }
  }
  assert.equal(personColor({ color: 3 }, "light"), memberColor(3, "light"));
  assert.equal(personColor({ color: 3, hex: null }, "dark"), memberColor(3, "dark"));
  assert.equal(personColor(null, "light"), memberColor(0, "light"));
});
