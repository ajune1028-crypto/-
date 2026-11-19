// The light at the screen's edge where something is thrown. The owner (17 November): "안 보이는 공이
// 가서 터지면 가장 가까운 곳이 먼저 드러나고 점점 퍼지고, 변 끝까지는 안 가고 세기에 따라 달라지는
// 미묘한 맛, 활성화된 변의 끝부분은 그라데이션으로 빛나고, 내가 지정한 색으로, 네온 느낌도, 완전 예쁘게",
// with a very small buzz; and again (20 November): "그 애니메이션 더 좋게, 내가 말한 대로".
//
// So, drawn on a thin strip of canvas along that edge:
// - the invisible ball takes a moment to fly there (further and softer: a little longer);
// - where it lands: a flash, a few sparks into the screen, and the buzz;
// - a neon tube lights from that point (a hot core in my glass colour's glow), flickering once
//   the way neon does when it comes on;
// - the light spreads along the edge like ink in water (a bell that widens), further the harder the
//   throw, and never into the corners: its ends fade into the glass;
// - a soft light comes in from the edge; it lingers, then fades as what came out settles.
// While aiming, a small light on the edge shows where the ball will land (aimMarker).

import { h } from "./dom.js";
import { currentTheme } from "./theme.js";

const STRIP = 72; // how far into the screen the light reaches, CSS px
const STEPS = 48; // points along the edge for the light's shape
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const easeOut = (p) => 1 - (1 - p) ** 3;

/** My glass colour as [r, g, b], resolved through the page's own colour variables. */
function tintRGB() {
  const probe = h("span", { style: { color: "var(--tint)", position: "fixed", visibility: "hidden", pointerEvents: "none" } });
  document.body.append(probe);
  const css = getComputedStyle(probe).color;
  probe.remove();
  const nums = (css.match(/-?[\d.]+/g) || []).map(Number);
  if (css.startsWith("color(")) return nums.slice(0, 3).map((v) => Math.round(clamp(v, 0, 1) * 255));
  return nums.length >= 3 ? nums.slice(0, 3) : [36, 102, 220];
}

const mix = (c, to, k) => c.map((v, i) => Math.round(v + (to[i] - v) * k));

/** The neon tube coming on: on, a quick dip, on, a smaller dip, steady. */
function flicker(t) {
  const keys = [[0, 0], [24, 1], [46, 0.32], [70, 1], [96, 0.64], [126, 1]];
  if (t >= 126) return 1;
  for (let i = 1; i < keys.length; i++) {
    if (t > keys[i][0]) continue;
    const [t0, v0] = keys[i - 1];
    const [t1, v1] = keys[i];
    return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
  }
  return 1;
}

/**
 * Lights the edge: edge "left" | "right" | "top" | "bottom", at 0..1 along it, strength 0..1; the
 * ball lands after `delay` ms (onImpact then). Settles when what comes out of the edge should
 * start to come: just after the flash, while the light still spreads.
 */
export function glowEdge({ edge, at, strength = 0.5, delay = 0, onImpact = null }) {
  const s = clamp(strength, 0, 1);
  const vertical = edge === "left" || edge === "right";
  const W = innerWidth;
  const H = innerHeight;
  const L = vertical ? H : W;
  const u0 = clamp(at, 0.06, 0.94) * L;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = h("canvas", { class: "edge-glow", data: { edge }, "aria-hidden": "true" });
  canvas.width = Math.round((vertical ? STRIP : L) * dpr);
  canvas.height = Math.round((vertical ? L : STRIP) * dpr);
  canvas.style.width = (vertical ? STRIP : L) + "px";
  canvas.style.height = (vertical ? L : STRIP) + "px";
  document.body.append(canvas);
  const g = canvas.getContext("2d");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dark = currentTheme() === "dark";
  const tint = tintRGB();
  const core = mix(tint, [255, 255, 255], dark ? 0.62 : 0.22);
  const halo = `rgba(${tint.join(",")},0.95)`;
  // Drawing is done along the edge (u) and into the screen (v): one transform per edge.
  const [a, b, c, d, e, f] = {
    top: [1, 0, 0, 1, 0, 0],
    bottom: [1, 0, 0, -1, 0, STRIP],
    left: [0, 1, 1, 0, 0, 0],
    right: [0, 1, -1, 0, STRIP, 0],
  }[edge];
  const sparks = Array.from({ length: 7 + Math.round(5 * s) }, () => ({
    angle: Math.PI * (0.12 + 0.76 * Math.random()),
    speed: (0.1 + 0.22 * Math.random()) * (0.6 + 0.8 * s),
    life: 240 + 200 * Math.random(),
    r: 0.9 + 1.3 * Math.random(),
  }));
  const hold = 420 + 380 * s;
  const fade = 760;
  const tau = 150 + 170 * s;
  const reach = (0.045 + 0.16 * s) * L;
  const end = 0.07 * L;
  const alphas = new Float64Array(STEPS + 1);

  const along = (k, rgb) => {
    const gr = g.createLinearGradient(0, 0, L, 0);
    for (let i = 0; i <= STEPS; i++) gr.addColorStop(i / STEPS, `rgba(${rgb.join(",")},${(alphas[i] * k).toFixed(3)})`);
    return gr;
  };

  function paint(t) {
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (t < 0) return;
    g.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
    const fading = t > hold ? (t - hold) / fade : 0;
    const level = (reduced ? 1 : flicker(t)) * (1 - easeOut(clamp(fading, 0, 1)));
    const sigma = 8 + reach * (reduced ? 1 : 1 - Math.exp(-t / tau)) * (1 + 0.3 * fading);
    for (let i = 0; i <= STEPS; i++) {
      const u = (i / STEPS) * L;
      alphas[i] = level * Math.exp(-((u - u0) ** 2) / (2 * sigma * sigma)) * smooth(u / end) * smooth((L - u) / end);
    }
    // A soft light coming in from the edge: along × across.
    g.globalCompositeOperation = "source-over";
    g.fillStyle = along(dark ? 0.6 : 0.46, tint);
    g.fillRect(0, 0, L, STRIP);
    g.globalCompositeOperation = "destination-in";
    const inward = g.createLinearGradient(0, 0, 0, STRIP);
    inward.addColorStop(0, "rgba(0,0,0,1)");
    inward.addColorStop(0.05, "rgba(0,0,0,0.8)");
    inward.addColorStop(0.22, "rgba(0,0,0,0.3)");
    inward.addColorStop(0.55, "rgba(0,0,0,0.07)");
    inward.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = inward;
    g.fillRect(0, 0, L, STRIP);
    // The neon tube at the very edge: a hot core inside my colour's glow.
    g.globalCompositeOperation = dark ? "lighter" : "source-over";
    g.lineCap = "round";
    g.shadowColor = halo;
    g.shadowBlur = 16 * dpr;
    g.strokeStyle = along(0.9, tint);
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(0, 2);
    g.lineTo(L, 2);
    g.stroke();
    g.shadowBlur = 6 * dpr;
    g.strokeStyle = along(1, core);
    g.lineWidth = 1.8;
    g.beginPath();
    g.moveTo(0, 1.4);
    g.lineTo(L, 1.4);
    g.stroke();
    g.shadowBlur = 0;
    if (!reduced) {
      // The flash where the ball landed, and its sparks flying into the screen.
      if (t < 460) {
        const p = t / 460;
        const R = (30 + 70 * s) * (0.25 + 0.75 * easeOut(p));
        const k = (1 - p) ** 2 * 0.95;
        const flash = g.createRadialGradient(u0, 0, 0, u0, 0, R);
        flash.addColorStop(0, `rgba(${core.join(",")},${k})`);
        flash.addColorStop(0.3, `rgba(${tint.join(",")},${k * 0.7})`);
        flash.addColorStop(1, `rgba(${tint.join(",")},0)`);
        g.fillStyle = flash;
        g.fillRect(u0 - R, 0, 2 * R, R);
      }
      for (const sp of sparks) {
        if (t > sp.life) continue;
        const p = t / sp.life;
        const dist = (sp.speed * sp.life * easeOut(p)) / 1.6;
        g.fillStyle = `rgba(${core.join(",")},${((1 - p) * 0.9).toFixed(3)})`;
        g.beginPath();
        g.arc(u0 + Math.cos(sp.angle) * dist, Math.sin(sp.angle) * dist, sp.r * (1 - 0.5 * p), 0, Math.PI * 2);
        g.fill();
      }
    }
    g.globalCompositeOperation = "source-over";
  }

  const total = delay + hold + fade + 40;
  const start = performance.now();
  let landed = false;
  const step = (now) => {
    if (!canvas.isConnected) return;
    const t = now - start - delay;
    if (!landed && t >= 0) {
      landed = true;
      onImpact?.();
    }
    paint(reduced ? Math.min(t, 200) : t);
    if (now - start < total) requestAnimationFrame(step);
    else canvas.remove();
  };
  requestAnimationFrame(step);
  // If frames stop (a page in the background), the light still goes away.
  setTimeout(() => {
    canvas.remove();
    if (!landed) {
      landed = true;
      onImpact?.();
    }
  }, total + 400);
  return new Promise((resolve) => setTimeout(resolve, reduced ? delay : delay + 90 + 80 * s));
}

/** A small light on the edge where a throw would land, shown while aiming. */
export function aimMarker() {
  let el = null;
  return {
    show(hit) {
      if (!hit) return this.hide();
      if (!el) {
        el = h("div", { class: "edge-aim", "aria-hidden": "true" });
        document.body.append(el);
      }
      el.dataset.edge = hit.edge;
      el.style.left = hit.x + "px";
      el.style.top = hit.y + "px";
    },
    hide() {
      el?.remove();
      el = null;
    },
  };
}
