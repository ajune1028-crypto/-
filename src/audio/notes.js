// From a pitch curve to notes: where each note starts, how long it lasts, which
// piano key it is and how loud. Pure computation.
//
// A note is { t, d, p, v }: start and length in seconds, `p` the MIDI key
// number (60 = 가온 도), `v` loudness 0..1. Starts and lengths stay as sung;
// nothing is pulled onto a beat.

import { HOP_SECONDS, frameTime } from "./pitch.js";

export const SPLIT_SEMITONES = 0.6; // a pitch this far from the note's centre…
export const SPLIT_FRAMES = 6; // …for this many frames (60 ms) starts a new note
export const MIN_NOTE_FRAMES = 8; // shorter than 80 ms is not a note of its own
const MIN_CONF = 0.6;
const GATE = 0.1; // quieter than this share of the take's loud parts is not singing
// Quieter than this is never singing (about -66 dB). Everything else is measured against
// the take itself, so a quiet take (the phone far away) is read like a loud one.
const FLOOR_RMS = 5e-4;
const QUIET_TAKE = 1e-3; // a take whose loud parts stay under this (-60 dB) has no singing in it
// A loudness dip below this share of the loudness on both sides starts a new
// note (the l of 라-라 sinks to about a third). Vibrato also swells and sinks,
// but only to about 0.55, so the line sits between the two.
const DIP = 0.45;
const DIP_REACH = 10;
// Measured over 72 synthetic notes: with no shift the starts came out 6.6 ms
// early on average; this cancels it.
const ONSET_SHIFT = 0;

const NAMES = ["도", "도♯", "레", "레♯", "미", "파", "파♯", "솔", "솔♯", "라", "라♯", "시"];

export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);
/** "도", "도♯", "레"… */
export const solfege = (p) => NAMES[((p % 12) + 12) % 12];
/** "도4": 가온 도 is 도4. */
export const noteLabel = (p) => solfege(p) + (Math.floor(p / 12) - 1);

function median(values) {
  const a = Float64Array.from(values).sort();
  const n = a.length;
  if (!n) return NaN;
  return n % 2 ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

function percentile(values, q) {
  const a = Float64Array.from(values).sort();
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))];
}

/** Which frames are sung, and their pitch in semitones (NaN where silent). */
function voicedPitch(frames) {
  const loud = percentile(frames.filter((f) => f.hz > 0).map((f) => f.rms), 0.95);
  const gate = loud < QUIET_TAKE ? Infinity : Math.max(FLOOR_RMS, loud * GATE);
  const m = new Float64Array(frames.length).fill(NaN);
  frames.forEach((f, k) => {
    if (f.hz > 0 && f.conf >= MIN_CONF && f.rms >= gate) m[k] = hzToMidi(f.hz);
  });
  // A single missing frame inside a held note is a dropout, not a break.
  for (let k = 1; k < m.length - 1; k++) {
    if (Number.isNaN(m[k]) && !Number.isNaN(m[k - 1]) && !Number.isNaN(m[k + 1]) && Math.abs(m[k - 1] - m[k + 1]) < 1 && frames[k].rms >= gate * 0.5) {
      m[k] = (m[k - 1] + m[k + 1]) / 2;
    }
  }
  return { m, loud: loud || 1 };
}

/** Runs of consecutive sung frames: [first, last]. */
function runsOf(m) {
  const runs = [];
  let start = -1;
  for (let k = 0; k <= m.length; k++) {
    const on = k < m.length && !Number.isNaN(m[k]);
    if (on && start < 0) start = k;
    if (!on && start >= 0) {
      runs.push([start, k - 1]);
      start = -1;
    }
  }
  return runs;
}

/** Smooths single-frame spikes and puts frames that jumped an octave back. */
function clean(m, a, b) {
  const raw = Array.from(m.subarray(a, b + 1));
  const out = raw.map((_, i) => median(raw.slice(Math.max(0, i - 2), i + 3)));
  for (let i = 0; i < out.length; i++) {
    const near = median(out.slice(Math.max(0, i - 12), i + 13));
    const off = out[i] - near;
    if (Math.abs(off) > 10 && Math.abs(Math.abs(off) - 12) < 1.5) out[i] -= 12 * Math.sign(off);
  }
  return out;
}

/** Splits a run where the loudness dips and comes back: a syllable sung again. */
function dipSplits(frames, a, b) {
  const level = [];
  for (let k = a; k <= b; k++) level.push(frames[k].level ?? frames[k].rms);
  const cuts = [];
  for (let i = MIN_NOTE_FRAMES; i < level.length - MIN_NOTE_FRAMES; i++) {
    if (!(level[i] <= level[i - 1] && level[i] <= level[i + 1])) continue;
    const before = Math.max(...level.slice(Math.max(0, i - DIP_REACH), i));
    const after = Math.max(...level.slice(i + 1, i + 1 + DIP_REACH));
    if (level[i] < DIP * Math.min(before, after) && (!cuts.length || i - cuts[cuts.length - 1] >= MIN_NOTE_FRAMES)) cuts.push(i);
  }
  return cuts.map((i) => a + i);
}

/** Splits where the pitch moves away from the note's centre and stays away. */
function pitchSplits(p, offset) {
  const cuts = [];
  let start = 0;
  let cand = -1;
  let side = 0;
  for (let i = 1; i < p.length; i++) {
    const ref = median(p.slice(start, cand >= 0 ? cand : i));
    const off = p[i] - ref;
    if (Math.abs(off) > SPLIT_SEMITONES) {
      if (cand < 0 || Math.sign(off) !== side) {
        cand = i;
        side = Math.sign(off);
      }
      if (i - cand + 1 >= SPLIT_FRAMES) {
        cuts.push(offset + cand);
        start = cand;
        cand = -1;
      }
    } else cand = -1;
  }
  return cuts;
}

const WOBBLE_FRAMES = 13; // a vibrato half-swing lasts 70–130 ms
const WOBBLE_SEMITONES = 3;

/**
 * Vibrato: the pitch swings up and down around one note several times a
 * second, and the splitter above sees short notes taking turns above and below.
 * A chain of joined pieces whose middle ones are short and whose steps keep
 * changing direction is one note.
 */
function joinWobbles(notes) {
  const key = (n) => median(n.own);
  const out = [];
  let i = 0;
  while (i < notes.length) {
    let j = i;
    while (j + 1 < notes.length) {
      const a = notes[j];
      const b = notes[j + 1];
      const step = key(b) - key(a);
      const joined = b.link === "pitch" && a.last + 1 === b.first;
      const shortMiddle = j === i || a.own.length <= WOBBLE_FRAMES;
      const turns = j === i || Math.sign(step) !== Math.sign(key(a) - key(notes[j - 1]));
      if (!joined || !shortMiddle || !turns || Math.abs(step) > WOBBLE_SEMITONES) break;
      j++;
    }
    // Two swings at least: three pieces with a short one in the middle.
    if (j - i >= 2) {
      const chain = notes.slice(i, j + 1);
      out.push({ first: chain[0].first, last: chain[chain.length - 1].last, own: chain.flatMap((n) => n.own), link: chain[0].link });
    } else out.push(...notes.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

/**
 * Notes from frames ({ hz, conf, rms } every 10 ms, as `trackPitch` gives them).
 */
export function segmentNotes(frames) {
  if (!frames.length) return [];
  const { m, loud } = voicedPitch(frames);
  // Pieces: stretches of steady pitch. `link` says what separated a piece from
  // the one before it inside the same run: a pitch move or a loudness dip.
  const pieces = [];
  for (const [a, b] of runsOf(m)) {
    const pitch = clean(m, a, b);
    const bounds = [a, ...dipSplits(frames, a, b), b + 1];
    for (let s = 0; s < bounds.length - 1; s++) {
      const from = bounds[s];
      const to = bounds[s + 1];
      const cuts = [from, ...pitchSplits(pitch.slice(from - a, to - a), from), to];
      for (let c = 0; c < cuts.length - 1; c++) {
        pieces.push({
          first: cuts[c],
          last: cuts[c + 1] - 1,
          own: pitch.slice(cuts[c] - a, cuts[c + 1] - a),
          link: c > 0 ? "pitch" : s > 0 ? "dip" : null,
        });
      }
    }
  }
  // Pieces too short to be notes are a glide's way between two notes or a scoop
  // into one. Such a piece is held on the note sung just before when the voice
  // ran straight on from it, else it starts the note right after; alone, it is
  // dropped. The note's key is judged on its own frames only.
  const notes = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece.own.length >= MIN_NOTE_FRAMES) {
      notes.push(piece);
      continue;
    }
    const prev = notes[notes.length - 1];
    const next = pieces[i + 1];
    if (prev && piece.link === "pitch" && prev.last + 1 === piece.first) prev.last = piece.last;
    else if (next && next.link === "pitch" && piece.last + 1 === next.first) {
      next.first = piece.first;
      next.link = piece.link;
    }
  }
  const joined = joinWobbles(notes);
  // The take's own tuning: a singer who is a little flat (or sharp) all through means the notes a
  // little above (below) where they land. Its offset from the piano's keys is read from all the
  // notes together (weighted by length) and taken off before each note is rounded to a key.
  const centres = joined.map((note) => ({ c: median(note.own), w: note.own.length }));
  const tune = tuningOffset(centres);
  return joined.map((note, i) => {
    let level = 0;
    for (let k = note.first; k <= note.last; k++) level += frames[k].rms;
    level /= note.last - note.first + 1;
    return {
      t: Math.max(0, frameTime(note.first) - HOP_SECONDS / 2 + ONSET_SHIFT),
      d: (note.last - note.first + 1) * HOP_SECONDS,
      p: Math.round(centres[i].c - tune),
      v: Math.min(1, Math.max(0.05, level / loud)),
    };
  });
}

/**
 * How far (in semitones, -0.5..0.5) a take sits from the piano's tuning: the mean of each note's
 * distance to its nearest key, taken round the circle and weighted by length. Few or short notes
 * say too little: then 0.
 */
export function tuningOffset(centres) {
  let x = 0;
  let y = 0;
  let total = 0;
  for (const { c, w } of centres) {
    if (!Number.isFinite(c)) continue;
    const a = 2 * Math.PI * (c - Math.round(c));
    x += Math.cos(a) * w;
    y += Math.sin(a) * w;
    total += w;
  }
  if (centres.length < 3 || total < 3 * MIN_NOTE_FRAMES) return 0;
  // The notes must agree on it; scattered distances mean the take is simply in tune, loosely.
  if (Math.hypot(x, y) / total < 0.6) return 0;
  return Math.atan2(y, x) / (2 * Math.PI);
}
