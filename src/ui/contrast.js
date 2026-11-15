// Words and icons that lie straight on a room's background (the clock, the zoom buttons,
// 원본 | 피아노…) read what is behind them and take white, black or a deeper black (the
// owner: "뒤에 거를 보고 판단해서… 픽셀 단위로"), with a soft halo of the other kind. The
// background is drawn into a small canvas the way the page shows it (a preset's gradient,
// or the photo covering the room), and the pixels under each one are measured.

// The presets' gradients, as in theme.css (--bg-1 … --bg-6): 165deg, three stops.
export const PRESET_STOPS = {
  1: [[0, "#ffd6a5"], [0.55, "#ff9a8b"], [1, "#c779d0"]],
  2: [[0, "#c2e9fb"], [0.6, "#81a4fd"], [1, "#4b6cb7"]],
  3: [[0, "#e0f7c8"], [0.55, "#8fd3a6"], [1, "#3b8d6e"]],
  4: [[0, "#f3e7ff"], [0.55, "#c8b6ff"], [1, "#8b7fe8"]],
  5: [[0, "#2b3a67"], [0.6, "#1b1f3b"], [1, "#0b0d1a"]],
  6: [[0, "#fff1e6"], [0.55, "#ffcdb2"], [1, "#e5989b"]],
};
const ANGLE = 165;

/** Relative luminance of an sRGB colour (0..255 each), 0 black … 1 white. */
export function luminance(r, g, b) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Which ink reads best on a backdrop this bright: "dark" (the backdrop is dark: white ink),
 * "light" (black ink), "bright" (a deeper black, for the brightest). The line sits where white
 * and black are equally readable (about 0.18).
 */
export function inkFor(lum) {
  if (lum < 0.18) return "dark";
  return lum < 0.6 ? "light" : "bright";
}

/** The CSS gradient line of an angle over a w×h box: [x0, y0, x1, y1] (as canvas wants it). */
export function gradientLine(w, h, deg = ANGLE) {
  const a = (deg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  return [w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half];
}

const SCALE = 0.25; // the backdrop is measured at a quarter of its size: plenty for words

/**
 * Watches a room: `backdrop` is its .room-bg; `room` the element it covers. Every element
 * inside with [data-contrast] gets data-on="dark|light|bright" while the room has a
 * background (and none without one: the theme's own colours stand). Returns { update, stop }.
 */
export function watchContrast(room, backdrop) {
  let canvas = null;
  let ctx = null;
  let key = "";
  let photo = null;
  let photoUrl = "";
  let timer = 0;

  async function paint() {
    const r = room.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * SCALE));
    const hgt = Math.max(1, Math.round(r.height * SCALE));
    const preset = backdrop.dataset.bg;
    const url = (/url\("?(.*?)"?\)/.exec(backdrop.style.backgroundImage || "") || [])[1] || "";
    const want = [w, hgt, preset || "", url].join("|");
    if (want === key && ctx) return true;
    if (!preset && !url) return false;
    canvas = canvas || document.createElement("canvas");
    canvas.width = w;
    canvas.height = hgt;
    ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    if (preset && PRESET_STOPS[preset]) {
      const g = ctx.createLinearGradient(...gradientLine(w, hgt));
      for (const [at, colour] of PRESET_STOPS[preset]) g.addColorStop(at, colour);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, hgt);
    } else if (url) {
      if (photoUrl !== url) {
        photoUrl = url;
        photo = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = url;
        });
      }
      if (!photo) return false;
      // As background-size: cover; background-position: center.
      const s = Math.max(w / photo.naturalWidth, hgt / photo.naturalHeight);
      const pw = photo.naturalWidth * s;
      const ph = photo.naturalHeight * s;
      ctx.drawImage(photo, (w - pw) / 2, (hgt - ph) / 2, pw, ph);
    }
    key = want;
    return true;
  }

  async function update() {
    const marked = [...room.querySelectorAll("[data-contrast]")];
    if (!room.classList.contains("has-bg") || !(await paint())) {
      for (const el of marked) delete el.dataset.on;
      return;
    }
    const r = room.getBoundingClientRect();
    for (const el of marked) {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const x = Math.max(0, Math.floor((b.left - r.left) * SCALE));
      const y = Math.max(0, Math.floor((b.top - r.top) * SCALE));
      const w = Math.max(1, Math.min(canvas.width - x, Math.ceil(b.width * SCALE)));
      const hh = Math.max(1, Math.min(canvas.height - y, Math.ceil(b.height * SCALE)));
      if (w <= 0 || hh <= 0 || x >= canvas.width || y >= canvas.height) continue;
      const px = ctx.getImageData(x, y, w, hh).data;
      // The brightness most of the backdrop under it has (the middle of the pixels' brightness).
      const lums = [];
      for (let i = 0; i < px.length; i += 4) lums.push(luminance(px[i], px[i + 1], px[i + 2]));
      lums.sort((a, b) => a - b);
      const on = inkFor(lums[Math.floor(lums.length / 2)]);
      if (el.dataset.on !== on) el.dataset.on = on;
    }
  }

  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 60);
  };
  const resize = new ResizeObserver(soon);
  resize.observe(room);
  const watch = new MutationObserver(soon);
  watch.observe(backdrop, { attributes: true, attributeFilter: ["style", "data-bg"] });
  watch.observe(room, { attributes: true, attributeFilter: ["class"] });
  addEventListener("orientationchange", soon);
  soon();
  return {
    update: soon,
    stop() {
      clearTimeout(timer);
      resize.disconnect();
      watch.disconnect();
      removeEventListener("orientationchange", soon);
    },
  };
}
