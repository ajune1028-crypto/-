// The app's home-screen icon, drawn here as a PNG without any tools (for the manifest the share
// sheet needs: src/sw.js, src/ui/share-in.js). A glass of the deep graphite the app wears in 어둡게,
// with the home's two halves meeting in it: 일상's warm orange and 창작's soft lilac (theme.css
// --daily-b, --creative-b), and a small house on them (집과 방 = 주소). Full bleed, so it is also a
// maskable icon: what matters sits inside the middle 80% circle.

import { deflateSync } from "node:zlib";

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const DAILY = hex("#ffb27d");
const CREATIVE = hex("#b9c6ff");
const GRAPHITE = hex("#16161b");
const LIFT = hex("#2a2a33");

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const over = (dst, src, alpha) => mix(dst, src, Math.max(0, Math.min(1, alpha)));

/** Whether (x, y) in 0..1 lies inside the small house: a roof triangle on a square body, with a door. */
function inHouse(x, y) {
  const cx = 0.5;
  const roofTop = 0.33;
  const eave = 0.5;
  const base = 0.68;
  const half = 0.15;
  const roofHalf = 0.2;
  const inRoof = y >= roofTop && y <= eave && Math.abs(x - cx) <= ((y - roofTop) / (eave - roofTop)) * roofHalf;
  const inBody = y > eave - 0.001 && y <= base && Math.abs(x - cx) <= half;
  const inDoor = y > 0.565 && y <= base && Math.abs(x - cx) <= 0.04;
  return (inRoof || inBody) && !inDoor;
}

/** One pixel's colour, from a few samples inside it (smooth edges). */
function shade(px, py, size) {
  const n = 4;
  let acc = [0, 0, 0];
  for (let sy = 0; sy < n; sy++) {
    for (let sx = 0; sx < n; sx++) {
      const x = (px + (sx + 0.5) / n) / size;
      const y = (py + (sy + 0.5) / n) / size;
      // The glass: graphite, lit a little from above.
      let c = mix(LIFT, GRAPHITE, Math.min(1, y * 1.25));
      // The two halves meeting in a round light (orange from the lower right, lilac from the upper left).
      const d = Math.hypot(x - 0.5, y - 0.5);
      if (d < 0.36) {
        const t = Math.max(0, Math.min(1, (x + (1 - y)) / 2 - 0.25) / 0.5);
        const glow = mix(CREATIVE, DAILY, t);
        const edge = Math.max(0, Math.min(1, (0.36 - d) / 0.012));
        c = over(c, glow, edge * (0.92 - 0.25 * Math.max(0, d - 0.22) / 0.14));
      }
      // The house on it, in the graphite (a door into the light).
      if (inHouse(x, y)) c = over(c, GRAPHITE, 0.9);
      acc = [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]];
    }
  }
  return acc.map((v) => Math.round(v / (n * n)));
}

/** The icon as PNG bytes, size × size. */
export function appIcon(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(shade(x, y, size), y * (size * 3 + 1) + 1 + x * 3);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** The manifest: the app's name and icon on the home screen, and its place in the share sheet for sounds. */
export function manifest() {
  return {
    name: "hamkke · 작은 우주를 기록해 보자",
    short_name: "hamkke",
    description: "친구와 링크로 같이 쓰는 방. 작은 우주를 기록해 보자.",
    lang: "ko",
    start_url: "./",
    scope: "./",
    display: "standalone",
    background_color: "#16161b",
    theme_color: "#16161b",
    icons: [
      { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    share_target: {
      action: "./share",
      method: "POST",
      enctype: "multipart/form-data",
      params: { files: [{ name: "sound", accept: ["audio/*", ".m4a", ".mp3", ".wav", ".aac", ".ogg", ".opus", ".amr", ".3gp", ".webm", ".flac"] }] },
    },
  };
}
