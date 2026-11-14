// A stand-in for the browser's AudioContext that records what would sound when.
// Test-only. Time moves only when the test says so.

class Param {
  constructor(value = 1) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(v, t) { this.events.push(["set", v, t]); return this; }
  linearRampToValueAtTime(v, t) { this.events.push(["ramp", v, t]); return this; }
  setTargetAtTime(v, t, c) { this.events.push(["target", v, t, c]); return this; }
}

class Node {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.outputs = new Set();
  }
  connect(node) { this.outputs.add(node); return node; }
  disconnect() { this.outputs.clear(); }
}

class Buffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(c) { return this.data[c]; }
}

class Source extends Node {
  constructor(ctx) {
    super(ctx, "source");
    this.buffer = null;
    this.onended = null;
    this.started = null;
    this.stoppedAt = null;
  }
  start(when = 0, offset = 0, duration) {
    this.started = { when, offset, duration };
    this.ctx.started.push(this);
  }
  stop(when) {
    this.stoppedAt = when ?? this.ctx.currentTime;
  }
}

export class FakeAudioContext {
  constructor({ sampleRate = 48000 } = {}) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.state = "running";
    this.baseLatency = 0.01;
    this.outputLatency = 0.02;
    this.destination = new Node(this, "destination");
    this.started = [];
  }
  createGain() { const n = new Node(this, "gain"); n.gain = new Param(1); return n; }
  createConvolver() { const n = new Node(this, "convolver"); n.buffer = null; return n; }
  createBufferSource() { return new Source(this); }
  createBuffer(channels, length, rate) { return new Buffer(channels, length, rate); }
  resume() { this.state = "running"; return Promise.resolve(); }
}
