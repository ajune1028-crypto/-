// Little sounds and touches that say something happened (the owner: "효과음도 색이 섞이는 띠리링").
// Each can be turned off in the settings (효과음, 진동). Sound only after a tap (browsers allow
// sound from a tap); the vibration only where the phone can.

import { audioContext } from "../audio/engine.js";
import { getSettings } from "../identity.js";

/** "띠리링": three quick bright bells going up, softly, with a little shimmer. */
export async function chime(app) {
  if (getSettings(app.store).soundEffects === false) return;
  const ctx = await audioContext();
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.01;
  const out = ctx.createGain();
  out.gain.value = 0.18;
  out.connect(ctx.destination);
  // E6, G#6, B6, then E7 a hair later: a major arpeggio that rises like a spark.
  [1318.5, 1661.2, 1975.5, 2637].forEach((f, i) => {
    const at = t0 + i * 0.065;
    for (const [mult, level] of [[1, 1], [2.76, 0.18], [5.4, 0.06]]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f * mult;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(level * (i === 3 ? 0.6 : 1), at + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, at + (i === 3 ? 0.9 : 0.5) / mult);
      osc.connect(g);
      g.connect(out);
      osc.start(at);
      osc.stop(at + 1);
      osc.onended = () => g.disconnect();
    }
  });
  setTimeout(() => out.disconnect(), 1500);
}

/** A short buzz (a thing lifted or put in its place), where the phone can. */
export function buzz(app, ms = 8) {
  if (getSettings(app.store).haptics === false) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    // Not every device can buzz.
  }
}
