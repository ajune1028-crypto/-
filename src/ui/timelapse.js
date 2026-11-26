// 타임랩스 on screen (그림 방's 과정): the drawing made again from its first line, every layer, each
// line drawn along its path with the name of the one who drew it at the pen in their colour, as
// Procreate replays a painting — ours shows everyone who drew it together. ▶/❚❚, 1·2·4배, a bar to
// jump along it, and 영상으로 저장 where the browser can record a canvas.

import { h, toast } from "./dom.js";
import { paintStroke, fixedInk } from "./ink.js";
import { brushOf, widthOf, opacityOf } from "../core/ink.js";
import { replayPlan, strokePart } from "../core/timelapse.js";

const SPEEDS = [1, 2, 4];

/**
 * layers: [{ strokes, opacity, mode }] bottom first; pageW/pageH in stroke units; paper: its colour;
 * nameOf(member), colorOf(member); title for a saved video. Returns { close }.
 */
export function openTimelapse({ root, layers, pageW, pageH, paper, nameOf, colorOf, title = "그림", fixed = false }) {
  const plan = replayPlan(layers.map((l, i) => ({ layer: i, strokes: l.strokes })));
  const canvas = h("canvas", { class: "tl-canvas", id: "tl-canvas", "aria-label": "그린 과정" });
  const fill = h("span", { class: "tl-fill" });
  const bar = h("div", { class: "tl-bar", id: "tl-bar", role: "slider", "aria-label": "어디까지", "aria-valuemin": "0", "aria-valuemax": "100" }, fill);
  const play = h("button", { class: "chip primary tl-play", id: "tl-play", type: "button" });
  const speed = h("button", { class: "chip", id: "tl-speed", type: "button" });
  const canRecord = typeof canvas.captureStream === "function" && typeof window.MediaRecorder === "function";
  const save = canRecord ? h("button", { class: "chip", id: "tl-save", type: "button", text: "영상 저장", title: "그린 과정을 영상으로 저장" }) : null;
  const close = h("button", { class: "chip", id: "tl-close", type: "button", text: "닫기" });
  const card = h("div", { class: "tl-card", role: "dialog", "aria-label": "그린 과정" },
    h("div", { class: "game-head" }, h("span", { class: "game-title", text: "그린 과정" }), h("span", { class: "relay-sub", id: "tl-count", text: `선 ${plan.items.length}개` })),
    h("div", { class: "tl-stage" }, canvas), bar,
    h("div", { class: "game-foot" }, play, speed, save, close));
  const layer = h("div", { class: "tl-layer", id: "timelapse" }, card);
  root.append(layer);

  // The picture: one canvas per layer, each line painted on its own layer once it is done.
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const pad = parseFloat(getComputedStyle(card).paddingLeft) || 0;
  const cssW = Math.max(120, Math.min(card.clientWidth - 2 * pad - 2, 480, ((innerHeight - 230) * pageW) / pageH));
  const W = Math.round(cssW * ratio);
  const H = Math.round((cssW * pageH) / pageW * ratio);
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = cssW + "px";
  canvas.style.height = (cssW * pageH) / pageW + "px";
  const g = canvas.getContext("2d");
  const made = layers.map(() => { const c = document.createElement("canvas"); c.width = W; c.height = H; return c; });
  const scratch = document.createElement("canvas");
  scratch.width = W;
  scratch.height = H;
  const k = W / pageW;
  let painted = 0; // items painted onto their layer
  let t = 0; // replay time, ms
  let rate = 1;
  let running = false;
  let last = 0;
  let frame = 0;

  function reset() {
    for (const c of made) c.getContext("2d").clearRect(0, 0, W, H);
    painted = 0;
  }

  function paintOn(c, item, pts) {
    const lg = c.getContext("2d");
    lg.setTransform(k, 0, 0, k, 0, 0);
    paintStroke(lg, pts, fixed ? fixedInk(item.stroke.c) : item.stroke.c, widthOf(item.stroke), brushOf(item.stroke), !!item.stroke.q, opacityOf(item.stroke));
    lg.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** The picture at replay time t. */
  function render() {
    if (t < (plan.items[painted - 1]?.end ?? 0)) reset();
    while (painted < plan.items.length && plan.items[painted].end <= t) {
      paintOn(made[plan.items[painted].layer], plan.items[painted], plan.items[painted].stroke.pts);
      painted++;
    }
    const now = plan.items[painted];
    const drawing = now && now.start <= t ? now : null;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.fillStyle = paper;
    g.fillRect(0, 0, W, H);
    let tip = null;
    layers.forEach((l, i) => {
      let src = made[i];
      if (drawing && drawing.layer === i) {
        // The line being drawn: its part so far, over what its layer already has.
        const sg = scratch.getContext("2d");
        sg.clearRect(0, 0, W, H);
        sg.drawImage(made[i], 0, 0);
        const f = (t - drawing.start) / (drawing.end - drawing.start);
        const s = drawing.stroke;
        const whole = brushOf(s) === "fill" || !!s.q;
        const part = strokePart(s.pts, f, { whole });
        paintOn(scratch, drawing, part);
        src = scratch;
        if (brushOf(s) !== "erase") tip = { x: part[part.length - 3] * k, y: part[part.length - 2] * k, by: s.by };
      }
      g.globalAlpha = l.opacity ?? 1;
      g.globalCompositeOperation = l.mode || "source-over";
      g.drawImage(src, 0, 0);
    });
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    if (tip) nameTag(tip);
    const done = plan.total ? Math.min(1, t / plan.total) : 1;
    fill.style.width = done * 100 + "%";
    bar.setAttribute("aria-valuenow", String(Math.round(done * 100)));
  }

  /** The name of the one drawing, at the pen, in their colour. */
  function nameTag({ x, y, by }) {
    const name = nameOf(by);
    g.font = `700 ${12 * ratio}px system-ui, sans-serif`;
    const w = g.measureText(name).width + 12 * ratio;
    const hh = 18 * ratio;
    const bx = Math.min(W - w - 2, Math.max(2, x + 8 * ratio));
    const by2 = Math.min(H - hh - 2, Math.max(2, y - hh - 6 * ratio));
    g.fillStyle = colorOf(by);
    g.beginPath();
    g.roundRect?.(bx, by2, w, hh, hh / 2);
    if (!g.roundRect) g.rect(bx, by2, w, hh);
    g.fill();
    g.fillStyle = "#fff";
    g.textBaseline = "middle";
    g.fillText(name, bx + 6 * ratio, by2 + hh / 2);
    g.beginPath();
    g.arc(x, y, 3 * ratio, 0, Math.PI * 2);
    g.fillStyle = colorOf(by);
    g.fill();
  }

  function step(now) {
    frame = 0;
    if (!running) return;
    t = Math.min(plan.total, t + (now - last) * rate);
    last = now;
    render();
    if (t >= plan.total) return void pause(true);
    frame = requestAnimationFrame(step);
  }

  function start() {
    if (t >= plan.total) t = 0;
    running = true;
    last = performance.now();
    play.textContent = "❚❚ 멈춤";
    play.setAttribute("aria-label", "멈추기");
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(step);
  }

  function pause(ended = false) {
    running = false;
    cancelAnimationFrame(frame);
    play.textContent = ended ? "▶ 처음부터" : "▶ 이어 보기";
    layer.dataset.ended = String(ended);
    onEnd?.();
  }

  let onEnd = null;
  play.addEventListener("click", () => (running ? pause() : start()));
  const paintSpeed = () => { speed.textContent = rate + "배"; };
  speed.addEventListener("click", () => { rate = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length]; paintSpeed(); });
  paintSpeed();
  // A press on the bar goes there.
  const seek = (e) => {
    const r = bar.getBoundingClientRect();
    t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * plan.total;
    render();
  };
  bar.addEventListener("pointerdown", (e) => {
    seek(e);
    bar.setPointerCapture?.(e.pointerId);
    const moveOn = (ev) => seek(ev);
    const up = () => { bar.removeEventListener("pointermove", moveOn); bar.removeEventListener("pointerup", up); bar.removeEventListener("pointercancel", up); };
    bar.addEventListener("pointermove", moveOn);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
  });

  // 영상으로 저장: the whole replay at 2배, recorded from the canvas.
  save?.addEventListener("click", () => {
    if (save.disabled) return;
    const type = ["video/mp4", "video/webm;codecs=vp9", "video/webm"].find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
    let rec;
    try {
      rec = new MediaRecorder(canvas.captureStream(30), type ? { mimeType: type } : {});
    } catch {
      return void toast(root, "이 브라우저에서는 영상으로 저장할 수 없어요");
    }
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data?.size) parts.push(e.data); };
    rec.onstop = () => {
      save.disabled = false;
      save.textContent = "영상 저장";
      const blob = new Blob(parts, { type: rec.mimeType || type || "video/webm" });
      layer.dataset.saved = String(blob.size);
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: `${title} 과정.${(rec.mimeType || type).includes("mp4") ? "mp4" : "webm"}` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
      toast(root, "그린 과정을 영상으로 저장했어요");
    };
    save.disabled = true;
    save.textContent = "저장 중…";
    rate = 2;
    paintSpeed();
    t = 0;
    reset();
    onEnd = () => { onEnd = null; setTimeout(() => rec.state !== "inactive" && rec.stop(), 300); };
    rec.start(250);
    start();
  });

  function shut() {
    running = false;
    cancelAnimationFrame(frame);
    layer.remove();
  }
  close.addEventListener("click", shut);
  render();
  start();
  return { close: shut };
}
