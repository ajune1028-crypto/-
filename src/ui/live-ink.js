// Friends' lines while they are being drawn, and the light of their pointer (가리키기), the way
// Excalidraw and Figma show other people's strokes and cursors as they move: the owner asked for
// drawing together "실시간으로", and a line that appears only after the hand lifts is not together.
//
// They go by presence (what each screen tells the others about itself, beside the room's own):
//   ink    { d: drawing document, id, c, w, b, n, t, done? }  the line being drawn, in pieces
//          (core/live.js); `done` is the finished stroke's op id: the live line stays until that
//          op is here, so nothing blinks.
//   laser  { d, id, n, t }                                   the pointer's light; it fades by itself
// Nothing of this is kept. Each drawing layer asks for what lies on its own document.

import { liveTail, mergeLive } from "../core/live.js";
import { memberColor } from "../core/paint.js";
import { currentTheme } from "./theme.js";

const SEND_MS = 66; // at most about fifteen pieces a second
export const LIGHT_MS = 1100; // how long a pointer's light lasts
const DONE_HOLD_MS = 3000; // how long a finished line's id is told, for slow screens

let lineCount = 0;
const newId = () => `${Date.now().toString(36)}${(lineCount++).toString(36)}`;

export class LiveInk {
  constructor(session) {
    this.session = session;
    this.lines = new Map(); // peer key → { m, d, id, c, w, b, state, done, ended }
    this.lights = new Map(); // peer key → { m, d, id, state, times, ended }
    this.layers = new Map(); // doc → Set of layers to draw again
    this.sending = { ink: null, laser: null };
    this.timers = { ink: 0, laser: 0 };
    this.offs = [
      session.on("peers", (peers) => this.read(peers || [])),
      // A finished line's op has come: its live picture can go.
      session.on("change", ({ doc }) => this.settle(doc)),
    ];
    this.read(session.peers || []);
    // The room's one live view (also what the screen scenarios look at).
    session.liveInk = this;
  }

  read(peers) {
    const now = performance.now();
    const seen = new Set();
    const touched = new Set();
    for (const p of peers) {
      if (p.isMe) continue;
      seen.add(p.key);
      const s = p.state || {};
      const ink = s.ink;
      const had = this.lines.get(p.key);
      if (ink && typeof ink.d === "string" && ink.id) {
        const line = had && had.id === ink.id ? had : { m: s.m, d: ink.d, id: ink.id, c: ink.c, w: ink.w, b: ink.b, state: null, done: null, ended: 0 };
        if (had && had !== line) touched.add(had.d);
        line.state = mergeLive(line.state, ink);
        line.m = s.m;
        if (ink.done) line.done = ink.done;
        this.lines.set(p.key, line);
        touched.add(line.d);
      } else if (had) {
        // Put away without a finished stroke (a zoom began), or told long enough: it goes.
        if (!had.done || this.arrived(had)) this.lines.delete(p.key);
        else had.ended = had.ended || now;
        touched.add(had.d);
      }
      const laser = s.laser;
      const was = this.lights.get(p.key);
      if (laser && typeof laser.d === "string" && laser.id) {
        const light = was && was.id === laser.id ? was : { m: s.m, d: laser.d, id: laser.id, state: null, times: [], ended: 0 };
        if (was && was !== light) touched.add(was.d);
        light.state = mergeLive(light.state, laser);
        const count = light.state.pts.length / 3;
        light.times.length = Math.min(light.times.length, count);
        while (light.times.length < count) light.times.push(now);
        light.m = s.m;
        light.ended = 0;
        this.lights.set(p.key, light);
        touched.add(light.d);
      } else if (was && !was.ended) {
        was.ended = now;
        touched.add(was.d);
      }
    }
    // Screens that went: their lines and lights go with them.
    for (const [key, line] of this.lines) if (!seen.has(key)) { this.lines.delete(key); touched.add(line.d); }
    for (const [key, light] of this.lights) if (!seen.has(key)) { this.lights.delete(key); touched.add(light.d); }
    for (const d of touched) this.redraw(d);
  }

  arrived(line) {
    const doc = this.session.doc(line.d);
    return !!(line.done && doc?.get?.(line.done));
  }

  settle(doc) {
    let gone = false;
    for (const [key, line] of this.lines) {
      if (line.d !== doc || !line.done || !this.arrived(line)) continue;
      this.lines.delete(key);
      gone = true;
    }
    if (gone) this.redraw(doc);
  }

  redraw(doc) {
    for (const layer of this.layers.get(doc) || []) layer.renderSoon();
  }

  /** Friends' lines on one drawing document now: [{ pts, c, w, b, color, name }]. */
  linesOn(doc) {
    const out = [];
    const now = performance.now();
    for (const [key, line] of this.lines) {
      if (line.d !== doc || !line.state?.pts.length) continue;
      if (line.ended && now - line.ended > DONE_HOLD_MS) { this.lines.delete(key); continue; }
      out.push({ ...this.who(line.m), pts: line.state.pts, c: line.c, w: line.w, b: line.b, live: !line.done });
    }
    return out;
  }

  /** Friends' pointer lights on one document: [{ pts, times, color, ended }]. */
  lightsOn(doc) {
    const out = [];
    const now = performance.now();
    for (const [key, light] of this.lights) {
      if (light.d !== doc) continue;
      const last = light.times.at(-1) || 0;
      if (light.ended && now - Math.max(last, light.ended - LIGHT_MS) > LIGHT_MS * 1.2) { this.lights.delete(key); continue; }
      out.push({ ...this.who(light.m), pts: light.state?.pts || [], times: light.times });
    }
    return out;
  }

  who(m) {
    const member = m ? this.session.room.member(m) : null;
    return { color: member ? memberColor(member.color, currentTheme()) : "#8c919c", name: member?.name || "" };
  }

  // ---- what this screen sends -----------------------------------------------------------------

  /** A line begins (kind "ink") or a pointer is pressed (kind "laser"): its id. */
  begin(kind, base) {
    const id = newId();
    this.sending[kind] = { ...base, id, pts: [] };
    return id;
  }

  /** The points so far; sent in a piece at most every SEND_MS. */
  grow(kind, pts) {
    const now = this.sending[kind];
    if (!now) return;
    now.pts = pts;
    if (this.timers[kind]) return void (now.again = true);
    this.flush(kind);
    this.timers[kind] = setTimeout(() => {
      this.timers[kind] = 0;
      if (this.sending[kind]?.again) {
        this.sending[kind].again = false;
        this.grow(kind, this.sending[kind].pts);
      }
    }, SEND_MS);
  }

  flush(kind, extra = {}) {
    const now = this.sending[kind];
    if (!now) return;
    const { pts, again, ...base } = now;
    this.session.setPresencePart(kind, { ...base, ...liveTail(pts), ...extra });
  }

  /** The line is finished as the stroke op `opId` (null: put away without one). */
  end(kind, opId = null) {
    const now = this.sending[kind];
    clearTimeout(this.timers[kind]);
    this.timers[kind] = 0;
    if (!now) return;
    if (kind === "ink" && opId) {
      this.flush(kind, { done: opId });
      const id = now.id;
      setTimeout(() => { if (this.sending.ink?.id === id) { this.sending.ink = null; this.session.setPresencePart("ink", null); } }, DONE_HOLD_MS);
    } else if (kind === "laser") {
      this.flush(kind);
      const id = now.id;
      setTimeout(() => { if (this.sending.laser?.id === id) { this.sending.laser = null; this.session.setPresencePart("laser", null); } }, 120);
    } else {
      this.sending[kind] = null;
      this.session.setPresencePart(kind, null);
    }
  }

  /** What one drawing layer on document `doc` needs. */
  on(doc) {
    const docName = typeof doc === "function" ? doc : () => doc;
    return {
      lines: () => this.linesOn(docName()),
      lights: () => this.lightsOn(docName()),
      mine: () => this.who(this.session.memberId),
      begin: (kind, base) => this.begin(kind, { d: docName(), ...base }),
      grow: (kind, pts) => this.grow(kind, pts),
      end: (kind, opId) => this.end(kind, opId),
      attach: (layer) => {
        const d = docName();
        if (!this.layers.has(d)) this.layers.set(d, new Set());
        this.layers.get(d).add(layer);
      },
      detach: (layer) => { for (const set of this.layers.values()) set.delete(layer); },
    };
  }

  close() {
    if (this.session.liveInk === this) this.session.liveInk = null;
    for (const off of this.offs) off();
    for (const kind of ["ink", "laser"]) {
      clearTimeout(this.timers[kind]);
      if (this.sending[kind]) this.session.setPresencePart(kind, null);
      this.sending[kind] = null;
    }
  }
}
