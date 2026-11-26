// Light and dark, and the scale that keeps the layout at a 360-wide column.

import { accentColors, nearestPeopleColor, filmImage } from "../core/paint.js";

const root = document.documentElement;
const hostTheme = root.dataset.theme || null;

/** "light" or "dark" overrides; "system" follows the host page or the device. */
export function applyTheme(choice) {
  if (choice === "light" || choice === "dark") root.dataset.theme = choice;
  else if (hostTheme) root.dataset.theme = hostTheme;
  else delete root.dataset.theme;
  repaintFloating();
}

/**
 * Glass that floats over the page (레퍼런스, sheets, 찾기와 집) is drawn on a layer of its own; some
 * phones keep that layer's old colours after 밝게/어둡게 changes (the owner: "레퍼런스는 안 바뀌거든").
 * Taking its frosting off for one frame makes them draw it again.
 */
function repaintFloating() {
  if (typeof document === "undefined") return;
  const layers = document.querySelectorAll(".float, .panel, .home-panel, .house-dock, .toolbar, .room > .bar");
  for (const el of layers) el.classList.add("repaint");
  requestAnimationFrame(() => requestAnimationFrame(() => { for (const el of layers) el.classList.remove("repaint"); }));
}

export function currentTheme() {
  const set = root.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function onThemeChange(fn) {
  const media = matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", fn);
  const observer = new MutationObserver(fn);
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    media.removeEventListener("change", fn);
    observer.disconnect();
  };
}

/**
 * Everything is sized in rem, so one number scales the whole layout. Upright
 * (세로), the app is a 360-wide column scaled to the screen: 0.8 to 1.4.
 * Lying down (가로) or on a computer, it takes the width (up to 75 rem) and is
 * scaled by the height instead, so a phone on its side keeps room for the
 * timeline. Writing sheets keep their 360 column either way.
 */
export function fitScale() {
  const set = () => {
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const landscape = w > hgt * 1.05;
    root.dataset.orient = landscape ? "landscape" : "portrait";
    // A phone grows with its width; a tablet or a computer is the phone made bigger (the owner, 21
    // November: "폰에서 화면만 키운 느낌으로"): the same screens, their type and buttons larger.
    const k = landscape ? Math.min(1.35, Math.max(0.85, hgt / 560)) : w <= 520 ? Math.min(1.2, Math.max(0.8, w / 360)) : Math.min(1.4, Math.max(1.05, w / 600));
    root.style.setProperty("--k", String(k));
  };
  set();
  window.addEventListener("resize", set);
  window.addEventListener("orientationchange", set);
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- your own colour and text size ---------------------------------------------------
// The accent colour is chosen per device and stays the same in light and dark:
// it is written on the page itself, over both themes' defaults.


/**
 * [key, Korean name, colour]: 빨주노초파남보, 갈색, 핑크, 흑백. 파랑 is the app's own.
 * The chosen one tints the glass, the buttons and the sky under both halves.
 */
export const ACCENTS = [
  ["red", "빨강", "#d93a3a"],
  ["orange", "주황", "#e0701f"],
  ["yellow", "노랑", "#d4a514"],
  ["green", "초록", "#2e9a4f"],
  ["blue", "파랑", "#2466dc"],
  ["indigo", "남색", "#3346b8"],
  ["violet", "보라", "#7a4ad8"],
  ["brown", "갈색", "#8a5a36"],
  ["pink", "핑크", "#e05298"],
  ["graphite", "흑백", "#3a3d46"],
  // Clear glass (the owner: "투명 색깔도"): no colour of its own, the room shows through; its
  // buttons take the black-and-white accent.
  ["clear", "투명", "clear"],
];
const CLEAR_ACCENT = "#3a3d46";

export const TEXT_SIZES = [[0.9, "작게"], [1, "보통"], [1.15, "크게"], [1.3, "아주 크게"]];

const ACCENT_VARS = ["--accent", "--accent-top", "--accent-bottom", "--accent-2", "--accent-ink", "--ring", "--on-accent"];

/** The app's own colour, when none is chosen (theme.css --accent). */
const APP_ACCENT = "#2466dc";

/** null puts the app's own colours back. */
export function applyAccent(hex) {
  for (const name of ACCENT_VARS) root.style.removeProperty(name);
  if (hex === "clear") root.dataset.glass = "clear";
  else delete root.dataset.glass;
  if (hex === "clear") hex = CLEAR_ACCENT;
  const own = !!hex && /^#[0-9a-f]{6}$/i.test(hex);
  const colors = accentColors((own ? hex : APP_ACCENT).toLowerCase());
  // 모래: a little sand of my colour in the coloured glass buttons (theme.css says which).
  root.style.setProperty("--sand-light", filmImage(colors["--accent"], colors["--accent-2"], false));
  root.style.setProperty("--sand-dark", filmImage(colors["--accent"], colors["--accent-2"], true));
  if (!own) return;
  for (const [name, value] of Object.entries(colors)) root.style.setProperty(name, value);
}

/**
 * 색 세기 (the owner: "자기의 ui색유리의 색… 가라데이션 되어있는부분의 끝부분부터 색깔을 줄이면서. 원본
 * 버전이있고… 눈안아프게끔. 검정 부분을 더 늘리고싶다거나… 다시 늘릴 수 있고"): how much of my glass
 * colour the glass, the sky at the corners and the shadows carry, 0..1 (1 = as it was made). Less
 * colour leaves more white in 밝게 and more black in 어둡게; the buttons keep their colour.
 */
export function tintAmount(value) {
  const v = Number(value);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

export function applyTintAmount(value) {
  root.style.setProperty("--tint-amount", String(tintAmount(value)));
}

export function applyTextScale(scale) {
  const ok = TEXT_SIZES.some(([v]) => v === scale);
  root.style.setProperty("--text-scale", String(ok ? scale : 1));
}

/** My glass colour as a hex: the one I chose, else the blue one. */
export function glassHex(settings) {
  if (settings?.accent === "clear") return CLEAR_ACCENT;
  return settings?.accent || ACCENTS.find(([key]) => key === "blue")[2];
}

/**
 * The people colour I would like in a room (an index into PALETTE): the one nearest my glass
 * colour that nobody there has yet, so my words and recordings come in "my colour". Null for a
 * grey glass (no preference).
 */
export function myPeopleColor(settings, room = null) {
  const taken = new Set(room ? room.members().map((m) => m.color) : []);
  return nearestPeopleColor(glassHex(settings), taken);
}
