// A file chooser that never opens. Some app views (the Claude app among them)
// ignore <input type=file>: a tap on 폰 녹음 앱 or 파일에서 가져오기 does
// nothing, or the input reports a cancel at once. A chooser that really opens
// always takes the page out of view or out of focus first, so after a tap:
//   - the page losing focus or going out of view: the chooser opened (a later
//     cancel is the person backing out, which is fine);
//   - a file arriving: done;
//   - a cancel with no such moment before it, or nothing at all for a while:
//     the chooser never showed, and onSilent() offers another way in.

export const PICKER_PATIENCE_MS = 2500;

/** Watches the inputs (opened by their <label>s). Returns stop(). */
export function watchPickers(inputs, onSilent, patience = PICKER_PATIENCE_MS) {
  const ac = new AbortController();
  const signal = ac.signal;
  let pending = null; // { input, left, timer } from a tap until the chooser shows or is done with
  const settle = () => {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  };
  const silent = () => {
    const input = pending?.input;
    settle();
    if (input) onSilent(input);
  };
  const left = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.left = true;
  };
  for (const input of inputs) {
    // A tap on a label reaches its input as a click, just before the chooser would open.
    input.addEventListener("click", () => {
      settle();
      pending = { input, left: false, timer: setTimeout(silent, patience) };
    }, { signal });
    input.addEventListener("change", settle, { signal });
    input.addEventListener("cancel", () => {
      if (pending && !pending.left) silent();
      else settle();
    }, { signal });
  }
  window.addEventListener("blur", left, { signal });
  document.addEventListener("visibilitychange", () => { if (document.hidden) left(); }, { signal });
  return () => {
    settle();
    ac.abort();
  };
}
