// From the pitches found every 10 ms (poly.js) to lines: each a voice or an instrument's note
// held through time. One line at a time leads (the tune); the others sounding with it are the
// harmony (화음). Pure computation.
//
// A single window often shows things that are not there: the same sound again a semitone off,
// or one of its harmonics an octave or a twelfth up. What is real stays where it is from window
// to window; so candidates are first thinned window by window, then followed through time, and
// only lines that last are kept.

import { hzToMidi } from "./notes.js";

const HARMONIC_STEPS = [12, 19, 24, 28, 31, 34, 36]; // an octave, a twelfth, two octaves… above a pitch
const SAME_SOUND = 1.6; // within this many semitones of a stronger pitch: the same sound again
const NEAR_HARMONIC = 0.45;
const LOWER_WINS = 0.5; // of two an octave (a twelfth…) apart the lower is the pitch when it is this strong beside the upper
export const MIN_PEAK = 2; // the strongest pitch must stand this far above the usual candidate, or the window holds no pitch
const GATE = 0.1; // quieter than this share of the take's loud parts: nothing sounds
const START = 0.42; // a new line starts on a pitch this strong beside the window's strongest…
const KEEP = 0.16; // …and goes on while it is at least this strong
const REACH = 0.9; // a line moves at most this many semitones from one window to the next…
const REACH_PER_GAP = 0.35; // …and this much more for each window it was not seen
const MAX_GAP = 4; // windows a line may go unseen
const MIN_LINE = 8; // shorter lines (80 ms) are dropped
const MIN_HARMONY_LINE = 14; // a harmony line must last longer than a leading one
const HARMONY_STRENGTH = 0.3; // and be this strong beside the strongest, on average
const TAIL = 0.22; // a line's end is cut back to where it was still this loud beside its own peak
const SWITCH_COST = 1.2; // changing the leading line costs this many windows of the usual salience
const LOW_KEY = 43; // below G2 a line leads less readily (a bass under a tune)

/** One window's candidates without the ghosts: [{ key, hz, s, a, r (strength beside the strongest) }]. */
export function thin(found) {
  if (!found.length) return [];
  const all = found.map((c) => ({ key: hzToMidi(c.hz), hz: c.hz, s: c.s, a: c.a, r: c.s / found[0].s, out: false }));
  for (let i = 0; i < all.length; i++) {
    for (let j = 0; j < all.length; j++) {
      if (i === j || all[j].out || all[i].out) continue;
      const d = all[i].key - all[j].key; // i above j when positive
      if (Math.abs(d) < SAME_SOUND) {
        // The same sound twice: the stronger is it.
        if (all[i].s < all[j].s) all[i].out = true;
        continue;
      }
      if (d > 0 && HARMONIC_STEPS.some((h) => Math.abs(d - h) < NEAR_HARMONIC)) {
        // i sits on a harmonic of j: the lower is the pitch unless it is much the weaker.
        if (all[j].s >= LOWER_WINS * all[i].s) all[i].out = true;
        else all[j].out = true;
      }
    }
  }
  return all.filter((c) => !c.out);
}

/**
 * Lines through the frames of `trackPitches`: [{ first, key: [], s: [], a: [], r: [] }] (one
 * value per window from `first` on; a window it was not seen in is filled in from its neighbours).
 */
export function followLines(frames) {
  const loudSorted = frames.filter((f) => f.found.length && f.peak >= MIN_PEAK).map((f) => f.rms).sort((a, b) => a - b);
  const loud = loudSorted.length ? loudSorted[Math.floor(0.95 * (loudSorted.length - 1))] : 0;
  const gate = loud * GATE;
  const active = [];
  const done = [];
  const close = (line) => {
    // Drop the unseen windows at the end.
    line.key.length = line.s.length = line.a.length = line.r.length = line.lastSeen - line.first + 1;
    done.push(line);
  };
  frames.forEach((f, k) => {
    const cands = f.rms >= gate && f.peak >= MIN_PEAK ? thin(f.found) : [];
    const used = new Array(cands.length).fill(false);
    // Lines take their next point, the longest-standing first.
    active.sort((p, q) => p.first - q.first);
    for (const line of active) {
      const gap = k - line.lastSeen - 1;
      const reach = REACH + REACH_PER_GAP * gap;
      let best = -1;
      for (let i = 0; i < cands.length; i++) {
        if (used[i] || cands[i].r < KEEP) continue;
        const d = Math.abs(cands[i].key - line.lastKey);
        if (d <= reach && (best < 0 || d < Math.abs(cands[best].key - line.lastKey))) best = i;
      }
      if (best < 0) continue;
      used[best] = true;
      const c = cands[best];
      // Fill the windows it was not seen in.
      for (let g = 1; g <= gap; g++) {
        const u = g / (gap + 1);
        line.key.push(line.lastKey + (c.key - line.lastKey) * u);
        line.s.push(line.s[line.s.length - 1] * (1 - u) + c.s * u);
        line.a.push(line.a[line.a.length - 1] * (1 - u) + c.a * u);
        line.r.push(line.r[line.r.length - 1] * (1 - u) + c.r * u);
      }
      line.key.push(c.key);
      line.s.push(c.s);
      line.a.push(c.a);
      line.r.push(c.r);
      line.lastKey = c.key;
      line.lastSeen = k;
    }
    for (let i = active.length - 1; i >= 0; i--) {
      if (k - active[i].lastSeen > MAX_GAP) close(active.splice(i, 1)[0]);
    }
    cands.forEach((c, i) => {
      if (used[i] || c.r < START) return;
      active.push({ first: k, key: [c.key], s: [c.s], a: [c.a], r: [c.r], lastKey: c.key, lastSeen: k });
    });
  });
  for (const line of active) close(line);
  // A line's faint end (a room's echo of a note already left, a string dying away) is cut back.
  for (const line of done) {
    let peak = 0;
    for (const a of line.a) if (a > peak) peak = a;
    let end = line.a.length;
    while (end > 1 && line.a[end - 1] < TAIL * peak) end--;
    line.key.length = line.s.length = line.a.length = line.r.length = end;
  }
  return { lines: withoutShadows(done.filter((l) => l.key.length >= MIN_LINE).sort((p, q) => p.first - q.first)), loud };
}

/**
 * Which line leads at each window (-1: none): the strongest, without hopping to another line for
 * a moment. Returns { lead: Int32Array (index into lines per frame), share: [0..1 per line] }.
 */
export function leadOf(lines, nFrames) {
  // Lines per frame.
  const at = Array.from({ length: nFrames }, () => []);
  lines.forEach((line, i) => {
    for (let k = 0; k < line.key.length; k++) if (line.first + k < nFrames) at[line.first + k].push(i);
  });
  const sal = [];
  for (const line of lines) for (const s of line.s) sal.push(s);
  sal.sort((a, b) => a - b);
  const usual = sal.length ? sal[sal.length >> 1] : 1;
  const cost = SWITCH_COST * usual;
  const worth = (i, k) => {
    const line = lines[i];
    const key = line.key[k - line.first];
    const low = key < LOW_KEY ? Math.max(0.5, 1 - (LOW_KEY - key) * 0.05) : 1;
    return line.s[k - line.first] * low;
  };
  // The best path through the lines alive at each window (no line: -1). Moving from one line
  // straight to another costs; starting after a silence does not.
  const lead = new Int32Array(nFrames).fill(-1);
  let prev = [{ id: -1, total: 0, from: -1 }];
  const hist = [];
  for (let k = 0; k < nFrames; k++) {
    const ids = at[k].length ? at[k] : [-1];
    const now = ids.map((id) => {
      let best = -Infinity;
      let from = -1;
      for (let pi = 0; pi < prev.length; pi++) {
        const p = prev[pi];
        const total = p.total - (id === p.id || p.id === -1 || id === -1 ? 0 : cost);
        if (total > best) { best = total; from = pi; }
      }
      return { id, total: best + (id >= 0 ? worth(id, k) : 0), from };
    });
    hist.push(now);
    prev = now;
  }
  let idx = 0;
  for (let i = 1; i < prev.length; i++) if (prev[i].total > prev[idx].total) idx = i;
  for (let k = nFrames - 1; k >= 0; k--) {
    lead[k] = hist[k][idx].id;
    idx = hist[k][idx].from;
  }
  const share = lines.map((line, i) => {
    let n = 0;
    for (let k = 0; k < line.key.length; k++) if (lead[line.first + k] === i) n++;
    return n / line.key.length;
  });
  return { lead, share };
}

const SHADOW_SHARE = 0.6; // a line this much of whose length sits on a harmonic of a stronger line is that line's shadow

/**
 * Shadows: a line that runs an octave (a twelfth, two octaves…) above a stronger line for most of
 * its length is that line's own harmonics, not another voice; one that runs so far below a
 * stronger line is its echo underneath. Returns the lines without them.
 */
export function withoutShadows(lines) {
  const mean = (a) => { let t = 0; for (const v of a) t += v; return t / a.length; };
  const strength = lines.map((l) => mean(l.s));
  const out = new Set();
  lines.forEach((b, bi) => {
    for (let ai = 0; ai < lines.length; ai++) {
      if (ai === bi || out.has(ai)) continue;
      const a = lines[ai];
      const from = Math.max(a.first, b.first);
      const to = Math.min(a.first + a.key.length, b.first + b.key.length);
      if (to - from < SHADOW_SHARE * b.key.length) continue;
      let on = 0;
      for (let k = from; k < to; k++) {
        const d = Math.abs(b.key[k - b.first] - a.key[k - a.first]);
        if (HARMONIC_STEPS.some((h) => Math.abs(d - h) < 0.6)) on++;
      }
      if (on < SHADOW_SHARE * b.key.length) continue;
      const above = mean(b.key) > mean(a.key);
      // Above a line at least half as strong: its harmonics. Below a stronger line: its echo.
      if (above ? strength[ai] >= LOWER_WINS * strength[bi] : strength[ai] > strength[bi] / LOWER_WINS) {
        out.add(bi);
        break;
      }
    }
  });
  return lines.filter((_, i) => !out.has(i));
}

/** Lines that are not the tune must last and be strong enough to be a harmony worth playing. */
export function worthKeeping(line, share) {
  if (share >= 0.5) return true;
  if (line.key.length < MIN_HARMONY_LINE) return false;
  let r = 0;
  for (const v of line.r) r += v;
  return r / line.r.length >= HARMONY_STRENGTH;
}
