// Small motions on what already exists (the owner, 22 November: "애니메이션… 절대로 뭐 바꾸지 말고 시스템을…
// 그냥 뭔가 좋을 것 같은 '애니메이션'", and with the references sent: "모드 바꿀 때 사람 말이 아닌 것 같은
// 느낌을 아주 조금"). Nothing here changes what a control says or does: the words stay the words (a
// scramble is drawn over them, never written into them), a number is set at once and only rolls in.
// Ideas from the references the owner sent (Kokonut UI, MIT: dynamic text, ai-text-loading; NumberFlow,
// MIT: rolling numbers), written anew for this app.

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Shapes that read as no one's letters (the owner: "사람 말이 아닌 것 같은 느낌").
const GLYPHS = "░▒▓▖▗▘▙▚▛▜▝▞▟◐◑◒◓◆◇";

/**
 * A chosen mode's name settles out of a brief scramble, left to right (about a quarter second). The
 * label itself never changes: the scramble lies over it and goes.
 */
export function decodeLabel(el, ms = 240) {
  if (!el || still()) return;
  const text = el.textContent;
  if (!text || el.children.length) return; // icons only, or a label with parts: leave it be
  cancelAnimationFrame(el._decode || 0);
  el.style.setProperty("--scramble-color", getComputedStyle(el).color);
  el.classList.add("decoding");
  const chars = [...text];
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const solid = Math.floor(t * (chars.length + 1));
    el.dataset.scramble = chars.map((c, i) => (i < solid || c === " " ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join("");
    if (t < 1 && el.isConnected) el._decode = requestAnimationFrame(step);
    else {
      el.classList.remove("decoding");
      delete el.dataset.scramble;
      el._decode = 0;
    }
  };
  el._decode = requestAnimationFrame(step);
}

/** A number or a short count changes and rolls in from below (the text is right at once). */
export function rollTo(el, text) {
  if (!el || el.textContent === text) return;
  el.textContent = text;
  if (still()) return;
  el.classList.remove("rolling");
  void el.offsetWidth;
  el.classList.add("rolling");
}

/** Done (copied): a check draws itself at the start of the button, then goes. */
export function drawCheck(button, ms = 1400) {
  if (!button || still()) return;
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
  if (!el || still()) return;
  el.classList.remove("bursting");
  void el.offsetWidth;
  el.classList.add("bursting");
  setTimeout(() => el.classList.remove("bursting"), 700);
}
