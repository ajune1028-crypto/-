// The keys a person meant: hummed and half-spoken tunes are sung flat, sharp, drifting and with the
// leaps squeezed, yet the tune they mean is in a key (the owner: "흥얼 거여도 완전 똑같고 좋은 …
// 똑같은 그런 음", "조화도 좋아야해"). Measured on 120 real hums (HumTrans), 18% of hummed note time lies
// more than half a semitone from the key meant, while the tunes themselves keep 98% of their time on
// their key's scale. A listener writing the tune down hears the key and the line together; so does this.
//
// One Viterbi pass per key (24: Krumhansl–Kessler profiles, squared), over states (key K, the singer's
// tuning τ just now):
//   sung pitch m  ~ Normal(K + τ, σ)   σ = 0.3 semitone for a 0.3 s note, wider for shorter notes
//   K             ~ the key's profile (scale tones likely, the tonic most)
//   K − K_prev    ~ how tunes move (same note 15%, a whole step 41%, …; HumTrans' 895 training tunes),
//                   at half weight; after a rest longer than a second, anything
//   τ             within ±0.5 semitone (beyond that it would be a different key), drifting 0.08 a note,
//                 starting a little flat (−0.2 ± 0.3): people sing flat more often than sharp
// The best key's path gives the keys; the key is the one whose path is most likely. Tuned on HumTrans'
// validation hums (notes in order right, F: 0.784 → 0.864), then checked on its test hums: 0.764 → 0.832,
// semitone errors 11.8% → 6.4%. A note sung clearly and long stays as sung even outside the key.
// The same notes rounded plainly (after the take's own tuning) are `sung`: 부른 그대로.
// Pure computation.

import { tuningOffset } from "./notes.js";

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// Percent of melodic steps by size in semitones (up and down together).
const STEPS = [14.6, 5.1, 20.4, 7.6, 2.5, 3.6, 0.3, 2.0, 0.4, 0.6, 0.2, 0.1, 0.3];
const GAMMA = 2;
const STEP_WEIGHT = 0.5;
const SIGMA = 0.3;
const DRIFT = 0.08;
const TAU_MAX = 0.5;
const TAU_STEP = 0.1;
const TAU_FIRST = 0.3;
const FLAT = -0.2; // untrained singers sing flat more often than sharp (HumTrans: 38% of hummed note time 0.25–0.75 low, 18% high)
const REST = 1.0;
const MIN_NOTES = 4;

const NAMES = [
  ["다", "올림다"], ["내림라", "올림다"], ["라", "라"], ["내림마", "내림마"], ["마", "마"], ["바", "바"],
  ["올림바", "올림바"], ["사", "사"], ["내림가", "올림사"], ["가", "가"], ["내림나", "내림나"], ["나", "나"],
];
/** A key's Korean name: keyName(9, true) → "가단조". */
export function keyName(tonic, minor) {
  return NAMES[((tonic % 12) + 12) % 12][minor ? 1 : 0] + (minor ? "단조" : "장조");
}

const pc = (k) => ((k % 12) + 12) % 12;

/**
 * notes: [{ t, d, m (sung pitch, semitones) }] in time order. Returns { keys (meant), sung (plain
 * rounding), tonic (0-11, or null when there is too little to hear a key), minor, tuning }.
 */
export function intendedKeys(notes) {
  const tuning = tuningOffset(notes.map((n) => ({ c: n.m, w: n.d / 0.01 })));
  const sung = notes.map((n) => Math.round(n.m - tuning));
  if (notes.length < MIN_NOTES) return { keys: sung.slice(), sung, tonic: null, minor: false, tuning };
  const ms = notes.map((n) => n.m);
  const lo = Math.floor(Math.min(...ms) - 1.5);
  const hi = Math.ceil(Math.max(...ms) + 1.5);
  const nK = hi - lo + 1;
  const taus = [];
  for (let t = -TAU_MAX; t <= TAU_MAX + 1e-9; t += TAU_STEP) taus.push(Math.round(t * 100) / 100);
  const nT = taus.length;
  const stepLog = (d) => STEP_WEIGHT * Math.log((STEPS[Math.abs(d)] ?? 0.02) / 100 + 1e-4);
  const driftLog = taus.map((a) => taus.map((b) => -0.5 * ((a - b) / DRIFT) ** 2));
  const widths = notes.map((n) => SIGMA * Math.sqrt(0.3 / Math.max(0.08, n.d)));
  let best = null;
  const V = new Float64Array(nK * nT);
  const W = new Float64Array(nK * nT);
  const Wb = new Int16Array(nK * nT);
  for (const [minor, profile] of [[false, KK_MAJOR], [true, KK_MINOR]]) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const raw = profile.map((_, i) => profile[pc(i - tonic)] ** GAMMA);
      const sum = raw.reduce((a, b) => a + b, 0);
      const keyLog = raw.map((v) => Math.log(v / sum));
      const emit = (i, K, ti) => { const z = (ms[i] - (lo + K) - taus[ti]) / widths[i]; return -0.5 * z * z + keyLog[pc(lo + K)]; };
      for (let K = 0; K < nK; K++) for (let ti = 0; ti < nT; ti++) V[K * nT + ti] = emit(0, K, ti) - 0.5 * ((taus[ti] - FLAT) / TAU_FIRST) ** 2;
      const back = [];
      for (let i = 1; i < notes.length; i++) {
        for (let Kp = 0; Kp < nK; Kp++) for (let ti = 0; ti < nT; ti++) {
          let bv = -Infinity, bt = 0;
          for (let tp = Math.max(0, ti - 3); tp <= Math.min(nT - 1, ti + 3); tp++) {
            const v = V[Kp * nT + tp] + driftLog[ti][tp];
            if (v > bv) { bv = v; bt = tp; }
          }
          W[Kp * nT + ti] = bv;
          Wb[Kp * nT + ti] = bt;
        }
        const rest = notes[i].t - (notes[i - 1].t + notes[i - 1].d) > REST;
        const B = new Int32Array(nK * nT);
        for (let K = 0; K < nK; K++) for (let ti = 0; ti < nT; ti++) {
          let bv = -Infinity, bk = 0;
          for (let Kp = Math.max(0, K - 12); Kp <= Math.min(nK - 1, K + 12); Kp++) {
            const v = W[Kp * nT + ti] + (rest ? Math.log(1 / 25) : stepLog(K - Kp));
            if (v > bv) { bv = v; bk = Kp; }
          }
          V[K * nT + ti] = bv + emit(i, K, ti);
          B[K * nT + ti] = bk * nT + Wb[bk * nT + ti];
        }
        back.push(B);
      }
      let score = -Infinity, end = 0;
      for (let s = 0; s < V.length; s++) if (V[s] > score) { score = V[s]; end = s; }
      if (!best || score > best.score) {
        const path = [end];
        for (let i = back.length - 1; i >= 0; i--) path.push(back[i][path[path.length - 1]]);
        path.reverse();
        best = { score, tonic, minor, keys: path.map((s) => lo + Math.floor(s / nT)) };
      }
    }
  }
  return { keys: best.keys, sung, tonic: best.tonic, minor: best.minor, tuning };
}
