// The microphone. Hands over raw samples while recording (for live notes and
// the waveform) and the whole take at the end.
//
// The browser only lets a page use the microphone on a secure address
// (https or localhost) and, inside a frame, only when the frame allows it.
// The Claude trial page does not, so there the song room offers importing a
// file instead.

// Runs on the audio thread: copies the input in blocks and posts them out.
const TAP = `
class HamkkeTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(2048);
    this.n = 0;
    this.port.onmessage = () => {
      this.port.postMessage(this.block.slice(0, this.n));
      this.n = 0;
      this.port.postMessage("flushed");
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.block[this.n++] = ch[i];
        if (this.n === this.block.length) {
          this.port.postMessage(this.block);
          this.block = new Float32Array(2048);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("hamkke-tap", HamkkeTap);
`;

import { soundFor } from "./engine.js";

const ready = new WeakSet();

/** Whether this page can ask for the microphone at all, and if not, why. */
export function micSupport() {
  if (globalThis.isSecureContext === false) return { ok: false, reason: "insecure" };
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) return { ok: false, reason: "unsupported" };
  const policy = globalThis.document?.permissionsPolicy || globalThis.document?.featurePolicy;
  try {
    if (policy && typeof policy.allowsFeature === "function" && !policy.allowsFeature("microphone")) return { ok: false, reason: "blocked" };
  } catch {
    // Some browsers throw for features they do not know; asking will tell.
  }
  return { ok: true, reason: null };
}

/** A short Korean reason for a refused microphone. */
export function micProblem(err) {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") return "마이크를 쓸 수 없어요. 브라우저 주소창의 권한에서 마이크를 허용해 주세요.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "마이크를 찾지 못했어요.";
  if (name === "NotReadableError" || name === "AbortError") return "다른 앱이 마이크를 쓰고 있어요.";
  return "마이크를 켜지 못했어요.";
}

export class MicRecorder {
  constructor(ctx) {
    this.ctx = ctx;
    this.chunks = [];
    this.count = 0;
    this.stream = null;
    this.source = null;
    this.node = null;
    this.sink = null;
  }

  /** Asks for the microphone and starts taking samples. Throws when refused. */
  async start(onChunk = () => {}) {
    // iPhone and iPad: a page that records says so (and plays music again once done).
    soundFor("recording");
    try {
      this.stream = await this.ask();
    } catch (err) {
      soundFor("playing");
      throw err;
    }
    await this.begin(onChunk);
  }

  ask() {
    return navigator.mediaDevices.getUserMedia({
      // Echo and noise cancelling and automatic level help calls but bend sung notes.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  }

  async begin(onChunk) {
    const ctx = this.ctx;
    this.source = ctx.createMediaStreamSource(this.stream);
    const take = (data) => {
      if (!data.length) return;
      this.chunks.push(data);
      this.count += data.length;
      onChunk(data);
    };
    try {
      if (!ctx.audioWorklet || typeof AudioWorkletNode === "undefined") throw new Error("no worklet");
      if (!ready.has(ctx)) {
        const url = URL.createObjectURL(new Blob([TAP], { type: "text/javascript" }));
        try {
          await ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        ready.add(ctx);
      }
      this.node = new AudioWorkletNode(ctx, "hamkke-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
      this.node.port.onmessage = (e) => {
        if (e.data === "flushed") this.flushed?.();
        else if (e.data instanceof Float32Array) take(e.data);
      };
    } catch {
      // Older browsers: the deprecated but widely available script processor.
      this.node = ctx.createScriptProcessor(2048, 1, 1);
      this.node.onaudioprocess = (e) => take(Float32Array.from(e.inputBuffer.getChannelData(0)));
    }
    // Nothing is heard from the microphone; the silent sink only keeps the tap running.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(ctx.destination);
  }

  get seconds() {
    return this.count / this.ctx.sampleRate;
  }

  /** Forgets what was taken so far (the count-in before a take is not part of it). */
  discard() {
    this.chunks = [];
    this.count = 0;
  }

  /**
   * How late the take lands compared with what was playing: the time sound
   * takes to come out of the speaker and back in through the microphone.
   */
  latency() {
    const settings = this.stream?.getAudioTracks?.()[0]?.getSettings?.() || {};
    return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0) + (typeof settings.latency === "number" ? settings.latency : 0);
  }

  /** Stops and returns { samples, rate }. */
  async stop() {
    if (this.node?.port) {
      await new Promise((resolve) => {
        this.flushed = resolve;
        this.node.port.postMessage("flush");
        setTimeout(resolve, 300);
      });
    }
    for (const node of [this.source, this.node, this.sink]) {
      try {
        node?.disconnect();
      } catch {
        // Already apart.
      }
    }
    for (const track of this.stream?.getTracks?.() || []) track.stop();
    soundFor("playing");
    const samples = new Float32Array(this.count);
    let at = 0;
    for (const c of this.chunks) {
      samples.set(c, at);
      at += c.length;
    }
    return { samples, rate: this.ctx.sampleRate };
  }
}
