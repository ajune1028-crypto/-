// An example take: a sung 도레미파솔미도 made right here (no file, no microphone), so a
// recording can be tried on any device, the Claude page too, where nothing can be recorded.
// It goes through the same reading as a real take (pitch, notes, waveform).

// Vowel "아": formant centres and widths in Hz, so it sounds like a voice, not a beep.
const FORMANTS = [[800, 90], [1200, 110], [2500, 160], [3400, 200]];
const gain = (f) => {
  let g = 0.06;
  for (const [c, b] of FORMANTS) g += 1 / (1 + ((f - c) / b) ** 2);
  return g;
};
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** The melody: [midi, seconds]. */
export const EXAMPLE_MELODY = [[60, 0.45], [62, 0.45], [64, 0.45], [65, 0.45], [67, 0.7], [64, 0.45], [60, 0.8]];

/** The example take as mono samples at `rate`, with a short breath between notes. */
export function exampleTake(rate = 24000) {
  const lead = 0.15;
  const gap = 0.06;
  const tail = 0.25;
  const total = lead + tail + EXAMPLE_MELODY.reduce((sum, [, d]) => sum + d + gap, 0);
  const out = new Float32Array(Math.round(total * rate));
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let t = lead;
  for (const [midi, dur] of EXAMPLE_MELODY) {
    const s0 = Math.round(t * rate);
    const s1 = Math.round((t + dur) * rate);
    let phase = 0;
    for (let s = s0; s < s1 && s < out.length; s++) {
      const time = (s - s0) / rate;
      // A little vibrato once a long note settles, as a voice does.
      const vib = dur > 0.6 && time > 0.25 ? 0.12 * Math.sin(2 * Math.PI * 5.5 * (time - 0.25)) : 0;
      const f = hz(midi + vib);
      phase += (2 * Math.PI * f) / rate;
      let v = 0;
      for (let k = 1; k <= 18; k++) {
        const fk = k * f;
        if (fk > rate / 2 - 200) break;
        v += (gain(fk) / k ** 0.6) * Math.sin(k * phase);
      }
      const env = Math.min(1, time / 0.02, (dur - time) / 0.03);
      out[s] = 0.16 * env * v + 0.002 * noise();
    }
    t += dur + gap;
  }
  return out;
}
