// Light and dark, and the scale that keeps the layout at a 360-wide column.

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

/** Everything is sized in rem, so one number scales the whole column: 1 to 1.4. */
export function fitScale() {
  const set = () => root.style.setProperty("--k", String(Math.min(1.4, Math.max(1, window.innerWidth / 360))));
  set();
  window.addEventListener("resize", set);
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
