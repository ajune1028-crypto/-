// Light and dark, and the scale that keeps the layout at a 360-wide column.

import { accentColors } from "../core/paint.js";

const root = document.documentElement;
const hostTheme = root.dataset.theme || null;

/** "light" or "dark" overrides; "system" follows the host page or the device. */
export function applyTheme(choice) {
  if (choice === "light" || choice === "dark") root.dataset.theme = choice;
  else if (hostTheme) root.dataset.theme = hostTheme;
  else delete root.dataset.theme;
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

/** Everything is sized in rem, so one number scales the whole 360-wide column: down to 0.8 on narrow screens, up to 1.4 on wide ones. */
export function fitScale() {
  const set = () => root.style.setProperty("--k", String(Math.min(1.4, Math.max(0.8, window.innerWidth / 360))));
  set();
  window.addEventListener("resize", set);
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- your own colour and text size ---------------------------------------------------
// The accent colour is chosen per device and stays the same in light and dark:
// it is written on the page itself, over both themes' defaults.


/** [key, Korean name, colour]. The first one is the app's own blue. */
export const ACCENTS = [
  ["blue", "파랑", "#2466dc"],
  ["violet", "보라", "#6d4ae0"],
  ["pink", "분홍", "#d03d78"],
  ["green", "초록", "#16865a"],
  ["orange", "주황", "#c8550f"],
  ["teal", "청록", "#0d7d8f"],
  ["graphite", "흑백", "#3a3d46"],
];

export const TEXT_SIZES = [[0.9, "작게"], [1, "보통"], [1.15, "크게"], [1.3, "아주 크게"]];

const ACCENT_VARS = ["--accent", "--accent-top", "--accent-bottom", "--accent-2", "--accent-ink", "--ring", "--on-accent"];

/** null puts the app's own colours back. */
export function applyAccent(hex) {
  for (const name of ACCENT_VARS) root.style.removeProperty(name);
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return;
  for (const [name, value] of Object.entries(accentColors(hex.toLowerCase()))) root.style.setProperty(name, value);
}

export function applyTextScale(scale) {
  const ok = TEXT_SIZES.some(([v]) => v === scale);
  root.style.setProperty("--text-scale", String(ok ? scale : 1));
}
