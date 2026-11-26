// Two fingers on a surface always mean zoom, never an edit.
//
// A screen's one-finger gestures (drag a clip, move a note, move a card, tap,
// double tap) check `pinching` before they begin and follow only their own
// pointer. onPinch() runs the moment a second finger lands, so the screen can
// put back whatever the first finger had begun. `pinching` then stays true
// until a fresh touch starts, so the lifts that end a pinch are never read as
// taps or double taps.

/**
 * Two or three fingers that land together and lift without moving: Procreate's taps (two =
 * 되돌리기, three = 다시하기), the way people who draw on a tablet already undo. A pinch moves, so
 * it is never one; fingers that land far apart in time are a hold and a tap, not one either.
 * Held still a moment, two or three fingers go on undoing or redoing, quicker and quicker, until
 * they lift (Procreate's hold); four fingers tapped together hide or show the tools (`four`).
 * Returns stop().
 */
export function watchFingerTaps(el, { two = null, three = null, four = null, hold = 520, slop = 14, within = 360, together = 160 } = {}) {
  const down = new Map();
  let most = 0;
  let start = 0;
  let spoiled = false;
  let timer = 0;
  let held = false;
  const quiet = () => { clearTimeout(timer); timer = 0; };
  // Two or three still fingers: again and again while they stay.
  const again = (n) => {
    const fn = down.size === 2 ? two : down.size === 3 ? three : null;
    if (spoiled || !fn || down.size !== most) return;
    held = true;
    fn();
    timer = setTimeout(() => again(n + 1), Math.max(80, 280 - n * 30));
  };
  const press = (e) => {
    if (e.pointerType !== "touch") return;
    if (!down.size) {
      start = e.timeStamp;
      most = 0;
      spoiled = false;
      held = false;
    } else if (e.timeStamp - start > together) spoiled = true;
    down.set(e.pointerId, [e.clientX, e.clientY]);
    most = Math.max(most, down.size);
    quiet();
    if (!spoiled && (down.size === 2 || down.size === 3)) timer = setTimeout(() => again(0), hold);
  };
  const move = (e) => {
    const at = down.get(e.pointerId);
    if (at && Math.hypot(e.clientX - at[0], e.clientY - at[1]) > slop) {
      spoiled = true;
      quiet();
    }
  };
  const lift = (e) => {
    if (!el.isConnected) return stop();
    if (!down.has(e.pointerId)) return;
    if (e.type === "pointercancel") spoiled = true;
    down.delete(e.pointerId);
    quiet();
    if (down.size) return;
    if (!spoiled && !held && e.timeStamp - start <= within) {
      if (most === 2) two?.();
      else if (most === 3) three?.();
      else if (most === 4) four?.();
    }
    most = 0;
    held = false;
  };
  function stop() {
    quiet();
    el.removeEventListener("pointerdown", press, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", lift, true);
    window.removeEventListener("pointercancel", lift, true);
  }
  el.addEventListener("pointerdown", press, true);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", lift, true);
  window.addEventListener("pointercancel", lift, true);
  return stop;
}

/**
 * Four fingers tapped together (Procreate's 전체 화면): the room's tools step out of the way and
 * come back the same way. Only when asked, never on its own while drawing.
 */
export function toggleBare(room, hint) {
  if (!room) return;
  const bare = room.classList.toggle("bare");
  hint?.(bare ? "네 손가락으로 톡: 도구 다시 보기" : "도구 보기");
}

/** Watches the touch points that begin on el. Returns { pinching, stop }. */
export function watchFingers(el, onPinch = () => {}) {
  const down = new Set();
  let pinching = false;
  const press = (e) => {
    if (e.pointerType !== "touch") {
      if (!down.size) pinching = false;
      return;
    }
    if (e.isPrimary) {
      // The first finger of a new touch: anything counted before is over,
      // even if its lift was never heard.
      down.clear();
      pinching = false;
    }
    down.add(e.pointerId);
    if (down.size >= 2 && !pinching) {
      pinching = true;
      onPinch();
    }
  };
  const lift = (e) => {
    if (!el.isConnected) return stop();
    down.delete(e.pointerId);
  };
  // Lifts are heard on the window: a finger may leave the surface before it lets go.
  function stop() {
    el.removeEventListener("pointerdown", press, true);
    window.removeEventListener("pointerup", lift, true);
    window.removeEventListener("pointercancel", lift, true);
  }
  el.addEventListener("pointerdown", press, true);
  window.addEventListener("pointerup", lift, true);
  window.addEventListener("pointercancel", lift, true);
  return {
    /** From a second finger landing until the next fresh touch. */
    get pinching() {
      return pinching;
    },
    stop,
  };
}
