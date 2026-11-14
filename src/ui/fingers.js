// Two fingers on a surface always mean zoom, never an edit.
//
// A screen's one-finger gestures (drag a clip, move a note, move a card, tap,
// double tap) check `pinching` before they begin and follow only their own
// pointer. onPinch() runs the moment a second finger lands, so the screen can
// put back whatever the first finger had begun. `pinching` then stays true
// until a fresh touch starts, so the lifts that end a pinch are never read as
// taps or double taps.

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
