// Small motions on what already exists (the owner, 22 November: "애니메이션… 절대로 뭐 바꾸지 말고 시스템을…
// 그냥 뭔가 좋을 것 같은 '애니메이션'"), in my colour (27 November: "애니메이션도 막 그런 걸로 색이 나와야
// 되는데 하나도 안 나오고"). Nothing here changes what a control says or does: a light is drawn over the
// words and goes, a number is set at once and only rolls in. With 동작 줄이기 (reduce motion) on, nothing
// moves but my colour still comes and goes (a fade is not motion).
// Ideas from the references the owner sent (Kokonut UI, MIT: ai-text-loading's light over words;
// NumberFlow, MIT: rolling numbers), written anew for this app.

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A chosen mode's name: a light in my colour passes over it once, left to right (under a second).
 * The words never change shape (the owner, 27 November: "글자가 잠시 이상하게 됨" of the scramble that was
 * here); the light is drawn over them and goes. Still screens: my colour fades in and out instead.
 */
export function shineLabel(el, ms = 700) {
  if (!el) return;
  const text = el.textContent;
  if (!text || el.children.length) return; // icons only, or a label with parts: leave it be
  clearTimeout(el._shine);
  el.classList.remove("shine", "shine-still");
  el.dataset.shine = text;
  void el.offsetWidth;
  el.classList.add(still() ? "shine-still" : "shine");
  el._shine = setTimeout(() => {
    el.classList.remove("shine", "shine-still");
    delete el.dataset.shine;
  }, ms + 40);
}

/** A number or a short count changes and rolls in from below (the text is right at once). */
export function rollTo(el, text) {
  if (!el || el.textContent === text) return;
  el.textContent = text;
  el.classList.remove("rolling");
  void el.offsetWidth;
  el.classList.add("rolling");
}

/** Done (copied): a check draws itself at the start of the button, then goes. */
export function drawCheck(button, ms = 1400) {
  if (!button) return;
  button.querySelector(":scope > .drawn-check")?.remove();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "drawn-check");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4.5 12.5l4.6 4.6L19.5 6.8");
  svg.append(path);
  button.prepend(svg);
  setTimeout(() => svg.remove(), ms);
}

/** A star turned on: it springs and a ring of small lights goes out from it. */
export function burst(el) {
  if (!el) return;
  el.classList.remove("bursting");
  void el.offsetWidth;
  el.classList.add("bursting");
  setTimeout(() => el.classList.remove("bursting"), 700);
}
