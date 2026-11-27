// Home's pictures of what is drawn in a room (the owner, 27 November: "미리보기 홈화면 ui에서 선이 이상하게
// 끈겨보인다던가, 어디는 약간 업데이트가 안돼었다던가, 직관적이게"). The line drawing kept with the room
// (core/preview.js, a few points a line) looked broken and kept what was rubbed out; these are painted
// with the room's own brushes (rubbing out, 불투명, 채우기, the layers as they show, the paper), so home
// shows what the room shows, and a flipbook's frames play in turn. They stay on this device only (not
// in the room list, not on my other devices), each small, the newest rooms' kept within a budget so the
// store never fills up for them.

import { paintLayers, fixedInk } from "./ink.js";
import { inkBox, boxMap, filmPlan } from "../core/preview.js";
import { BOARD_INK_UNIT } from "../core/ink.js";

const W = 240; // one picture, 5 : 3 like home's 100 × 60 map
const H = 144;
const FILM_W = 160; // one frame of a flipbook's
const FILM_H = 96;
const MAX_CHARS = 90000; // one picture, at most (a smaller film is made when it is larger)
const BUDGET = 900000; // all of them together
const MAX_KEPT = 30;
const INDEX = "pv-index";
const keyOf = (roomId) => "pv:" + roomId;

function canvasOf(w, hgt) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = hgt;
  return c;
}

// WebP where the browser writes it (a fraction of a PNG), else PNG.
function encode(canvas) {
  let url = "";
  try {
    url = canvas.toDataURL("image/webp", 0.86);
  } catch {
    url = "";
  }
  return url.startsWith("data:image/webp") ? url : canvas.toDataURL("image/png");
}

/** From page units to a picture w px wide, as boxMap placed the drawing in the 100 × 60 map. */
const placing = (m, w, unit = 1) => {
  const k = w / 100;
  const s = (m.scale * k) / unit;
  return [s, 0, 0, s, (m.ox - m.x0 * m.scale) * k, (m.oy - m.y0 * m.scale) * k];
};

/**
 * One drawing (its layers, bottom first: { strokes, visible, opacity, mode, clip }) as home's picture,
 * on its paper (null: see-through). Null when nothing is drawn.
 */
export function drawingPicture(layers, paper) {
  const m = boxMap(inkBox(layers.filter((l) => l.visible !== false).map((l) => l.strokes)));
  if (!m) return null;
  const c = canvasOf(W, H);
  const g = c.getContext("2d");
  if (!g) return null;
  if (paper) {
    g.fillStyle = paper;
    g.fillRect(0, 0, W, H);
  }
  paintLayers(g, layers, W, H, placing(m, W), fixedInk);
  return { img: encode(c), n: 1 };
}

/**
 * A flipbook as home's moving picture: its frames (as many as fit, spread from the first to the last)
 * side by side, which home shows one after another. layersOf(id): a frame's layers (the background
 * under it). Null when nothing is drawn.
 */
export function filmPicture(frames, fps, layersOf, paper) {
  for (const most of [12, 6, 3, 1]) {
    const plan = filmPlan(frames, fps, most);
    if (!plan) return null;
    const each = plan.ids.map((id) => layersOf(id));
    const m = boxMap(inkBox(each.flatMap((layers) => layers.filter((l) => l.visible !== false).map((l) => l.strokes))));
    if (!m) return null;
    const n = each.length;
    const c = canvasOf(FILM_W * n, FILM_H);
    const g = c.getContext("2d");
    if (!g) return null;
    each.forEach((layers, i) => {
      const one = canvasOf(FILM_W, FILM_H);
      const og = one.getContext("2d");
      if (!og) return;
      if (paper) {
        og.fillStyle = paper;
        og.fillRect(0, 0, FILM_W, FILM_H);
      }
      paintLayers(og, layers, FILM_W, FILM_H, placing(m, FILM_W), fixedInk);
      g.drawImage(one, i * FILM_W, 0);
    });
    const img = encode(c);
    if (img.length <= MAX_CHARS || most === 1) return { img, n, ms: plan.ms };
  }
  return null;
}

/**
 * What is drawn on a whiteboard, as the picture under home's map of its cards (`map` from
 * boardPreview: [x0, y0, scale, ox, oy], board px into the map). Painted as drawn, black as black;
 * home turns it for 어둡게 as the board turns its ink.
 */
export function boardInkPicture(strokes, map) {
  if (!strokes?.length || !map) return null;
  const [x0, y0, scale, ox, oy] = map;
  const c = canvasOf(W, H);
  const g = c.getContext("2d");
  if (!g) return null;
  paintLayers(g, [{ strokes }], W, H, placing({ x0: x0 * BOARD_INK_UNIT, y0: y0 * BOARD_INK_UNIT, scale: scale / BOARD_INK_UNIT, ox, oy }, W), fixedInk);
  return { img: encode(c), n: 1, ink: true };
}

/** Where the board's drawing lies, in board px ([x0, y0, x1, y1]), or null. */
export function boardInkBox(strokes) {
  const box = inkBox([strokes]);
  return box ? box.map((v) => v / BOARD_INK_UNIT) : null;
}

/** Keeps a room's picture (null takes it away), within the budget: the oldest rooms' go first. */
export function keepPicture(store, roomId, pic) {
  const index = (store.get(INDEX, []) || []).filter((e) => e && e.id !== roomId);
  if (!pic || typeof pic.img !== "string" || pic.img.length > MAX_CHARS * 1.5) {
    store.remove?.(keyOf(roomId));
    store.set(INDEX, index);
    return false;
  }
  const entry = { id: roomId, size: pic.img.length, at: Date.now() };
  index.push(entry);
  index.sort((a, b) => b.at - a.at);
  let total = 0;
  const kept = [];
  for (const e of index) {
    if (kept.length < MAX_KEPT && total + e.size <= BUDGET) {
      kept.push(e);
      total += e.size;
    } else store.remove?.(keyOf(e.id));
  }
  const fits = kept.includes(entry) && (store.trySet ? store.trySet(keyOf(roomId), { ...pic, at: entry.at }) : (store.set(keyOf(roomId), { ...pic, at: entry.at }), true));
  store.set(INDEX, fits ? kept : kept.filter((e) => e !== entry));
  return fits;
}

/** A room's kept picture, or null. */
export function pictureOf(store, roomId) {
  const p = store.get(keyOf(roomId), null);
  return p && typeof p.img === "string" && p.img.startsWith("data:image/") && Number.isInteger(p.n) && p.n >= 1 && p.n <= 12 ? p : null;
}
