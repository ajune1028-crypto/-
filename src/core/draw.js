// 그림 방's layers: which layers there are, in which order, and how each is shown. What is drawn on
// a layer lives in its own drawing document (`k:L<layer id>`, an InkDoc), so strokes and their
// erasing work as everywhere else; this document holds only the layers themselves.
//
// The model follows Klecks (bitbof, MIT License): a layer has a name, is shown or hidden, has an
// opacity and a blend mode (the canvas' own composite operations), and there are at most 16. Here
// everything is an op that gives the same layers in whatever order it arrives:
//
//   layer  { id, name, by, at }                 a new layer (on top, by its id's counter)
//   lset   { id, l: layer id, f: { name?, opacity?, visible?, mode?, order? } }   each field: the later op wins
//   lrm    { id, l: layer id, n }                taken away while n is odd (undo brings it back)

import { cmpId, validId } from "./crdt.js";

export const BLEND_MODES = ["source-over", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"];
export const MAX_LAYERS = 16;
const MAX_UNKNOWN = 300;
const FIELDS = ["name", "opacity", "visible", "mode", "order"];

/** The drawing document that holds a layer's strokes. */
export function inkDocOf(layerId) {
  return "k:L" + layerId;
}

const counterOf = (id) => Number(id.slice(0, id.indexOf("@")));
const nameOk = (v) => typeof v === "string" && v.length <= 30;
const fieldOk = {
  name: nameOk,
  opacity: (v) => typeof v === "number" && v >= 0 && v <= 1,
  visible: (v) => typeof v === "boolean",
  mode: (v) => BLEND_MODES.includes(v),
  order: (v) => typeof v === "number" && Number.isFinite(v),
};

export class DrawDoc {
  constructor() {
    this.version = 0;
    this.byId = new Map();
    this.waiting = new Map();
    this.seen = new Set();
    this.unknown = [];
    this.maxN = 0;
  }

  apply(op) {
    if (!op || typeof op !== "object" || !validId(op.id)) return this.setAside(op);
    if (this.seen.has(op.id)) return "dup";
    if (op.t === "layer") {
      if (!nameOk(op.name) || typeof op.by !== "string" || op.by.length > 40 || !Number.isFinite(op.at)) return this.setAside(op);
      this.byId.set(op.id, { id: op.id, name: op.name, by: op.by, at: op.at, rm: 0, rmBy: "", fields: new Map() });
      this.done(op);
      for (const later of this.waiting.get(op.id) || []) this.apply(later);
      this.waiting.delete(op.id);
      return "applied";
    }
    if (op.t === "lset") {
      if (!validId(op.l) || !op.f || typeof op.f !== "object") return this.setAside(op);
      const keys = Object.keys(op.f);
      if (!keys.length || keys.some((k) => !FIELDS.includes(k) || !fieldOk[k](op.f[k]))) return this.setAside(op);
      const layer = this.byId.get(op.l);
      if (!layer) return this.wait(op);
      for (const k of keys) {
        const had = layer.fields.get(k);
        if (!had || cmpId(op.id, had.at) > 0) layer.fields.set(k, { v: op.f[k], at: op.id });
      }
      return this.done(op);
    }
    if (op.t === "lrm") {
      if (!validId(op.l) || !Number.isInteger(op.n) || op.n < 1 || op.n > 1e9) return this.setAside(op);
      const layer = this.byId.get(op.l);
      if (!layer) return this.wait(op);
      if (op.n > layer.rm) layer.rm = op.n;
      return this.done(op);
    }
    return this.setAside(op);
  }

  applyAll(ops) {
    const before = this.version;
    for (const op of ops) this.apply(op);
    return this.version !== before;
  }

  wait(op) {
    if (!this.waiting.has(op.l)) this.waiting.set(op.l, []);
    this.waiting.get(op.l).push(op);
    return "pending";
  }

  done(op) {
    this.seen.add(op.id);
    this.version++;
    const n = counterOf(op.id);
    if (n > this.maxN) this.maxN = n;
    return "applied";
  }

  setAside(op) {
    if (this.unknown.length < MAX_UNKNOWN) this.unknown.push(op);
    return "unknown";
  }

  /** A layer as shown: its fields with their defaults, or null. */
  layer(id) {
    const l = this.byId.get(id);
    if (!l) return null;
    const f = (k, d) => (l.fields.has(k) ? l.fields.get(k).v : d);
    return { id: l.id, by: l.by, at: l.at, removed: l.rm % 2 === 1, rm: l.rm, name: f("name", l.name), visible: f("visible", true), opacity: f("opacity", 1), mode: f("mode", "source-over"), order: f("order", counterOf(l.id)) };
  }

  /** The layers there are, bottom first. A layer made without a name is called by its place. */
  layers() {
    const all = [...this.byId.keys()].map((id) => this.layer(id)).filter((l) => !l.removed);
    all.sort((a, b) => a.order - b.order || cmpId(a.id, b.id));
    all.forEach((l, i) => { if (!l.name) l.name = `레이어 ${i + 1}`; });
    return all;
  }
}

export function addLayerOps(clock, doc, { name = "", by, at = Date.now() }) {
  clock.atLeast(doc.maxN);
  const op = { t: "layer", id: clock.next(), name: String(name || "").slice(0, 30), by, at };
  return { ops: [op], atoms: [{ k: "lay+", l: op.id }], id: op.id };
}

/** Changes some of a layer's fields; the atom remembers what they were, for undo. */
export function setLayerOps(clock, doc, id, fields) {
  const now = doc.layer(id);
  if (!now) return { ops: [], atoms: [] };
  const f = {};
  const before = {};
  for (const k of FIELDS) {
    if (fields[k] === undefined || !fieldOk[k](fields[k]) || fields[k] === now[k]) continue;
    f[k] = fields[k];
    before[k] = now[k];
  }
  if (!Object.keys(f).length) return { ops: [], atoms: [] };
  clock.atLeast(doc.maxN);
  return { ops: [{ t: "lset", id: clock.next(), l: id, f }], atoms: [{ k: "lset", l: id, before, after: f }] };
}

export function removeLayerOps(clock, doc, id) {
  const now = doc.layer(id);
  if (!now || now.removed) return { ops: [], atoms: [] };
  clock.atLeast(doc.maxN);
  return { ops: [{ t: "lrm", id: clock.next(), l: id, n: now.rm + 1 }], atoms: [{ k: "lay-", l: id }] };
}

/** Moves a layer `delta` places up (toward the top) or down; past the ends it stays at the end. */
export function moveLayerOps(clock, doc, id, delta) {
  const list = doc.layers();
  const at = list.findIndex((l) => l.id === id);
  if (at < 0 || !delta) return { ops: [], atoms: [] };
  const rest = list.filter((l) => l.id !== id);
  const to = Math.max(0, Math.min(rest.length, at + delta));
  if (to === at) return { ops: [], atoms: [] };
  const below = rest[to - 1];
  const above = rest[to];
  const order = !below ? above.order - 1 : !above ? below.order + 1 : (below.order + above.order) / 2;
  return setLayerOps(clock, doc, id, { order });
}

/** Undo or redo of layer changes, judged against the layers as they are now. */
export function invertDrawOps(doc, clock, atoms, dir) {
  const ops = [];
  const flip = (id, wantRemoved) => {
    const now = doc.layer(id);
    if (!now || now.removed === wantRemoved) return;
    clock.atLeast(doc.maxN);
    ops.push({ t: "lrm", id: clock.next(), l: id, n: now.rm + 1 });
  };
  const list = dir === "undo" ? atoms.slice().reverse() : atoms;
  for (const atom of list) {
    if (atom.k === "lay+") flip(atom.l, dir === "undo");
    else if (atom.k === "lay-") flip(atom.l, dir !== "undo");
    else if (atom.k === "lset") {
      const fields = dir === "undo" ? atom.before : atom.after;
      clock.atLeast(doc.maxN);
      const now = doc.layer(atom.l);
      if (now) ops.push({ t: "lset", id: clock.next(), l: atom.l, f: { ...fields } });
    }
  }
  return ops;
}
