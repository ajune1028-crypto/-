// Plays a recording faster or slower without changing its pitch.
//
// WSOLA (waveform-similarity overlap-add): the recording is cut into short
// overlapping windows taken at the new pace; each window is nudged a few
// milliseconds to where it best continues the one before, so the voice's
// waves line up and no new pitch appears. Pure computation.

const windows = new Map();

function hann(n) {
  if (!windows.has(n)) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    windows.set(n, w);
  }
  return windows.get(n);
}

/**
 * The samples played at `speed` (2 = twice as fast), same pitch. 1 returns a
 * copy. The result lasts length / speed.
 */
export function timeStretch(input, rate, speed, { frameMs = 40, searchMs = 12 } = {}) {
  if (speed === 1) return Float32Array.from(input);
  const n = Math.max(64, Math.round((rate * frameMs) / 1000) & ~1);
  const hop = n / 2;
  const step = hop * speed;
  const reach = Math.round((rate * searchMs) / 1000);
  const outLen = Math.max(1, Math.round(input.length / speed));
  const out = new Float32Array(outLen + n);
  const sum = new Float32Array(outLen + n);
  const win = hann(n);
  let prev = 0;
  for (let k = 0; k * hop < outLen; k++) {
    let pos = Math.round(k * step);
    if (k > 0) {
      // Where the last window would naturally have gone on; find the nearby
      // start that looks most like it.
      const follow = prev + hop;
      let best = -Infinity;
      let bestPos = pos;
      for (let d = -reach; d <= reach; d++) {
        const cand = pos + d;
        if (cand < 0 || cand + hop > input.length) continue;
        let c = 0;
        for (let j = 0; j < hop; j += 2) c += input[cand + j] * (follow + j < input.length ? input[follow + j] : 0);
        if (c > best) {
          best = c;
          bestPos = cand;
        }
      }
      pos = bestPos;
    }
    const o = k * hop;
    for (let j = 0; j < n; j++) {
      const x = pos + j < input.length ? input[pos + j] : 0;
      out[o + j] += x * win[j];
      sum[o + j] += win[j];
    }
    prev = pos;
  }
  for (let i = 0; i < outLen; i++) out[i] = sum[i] > 1e-3 ? out[i] / sum[i] : out[i];
  return out.slice(0, outLen);
}
