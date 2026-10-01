const PLAYBACK_SAMPLE_RATE = 24000;
const CAPTURE_FRAME_MS = 20;

class PiLivePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.captureMuted = true;
    this.captureEpoch = 0;
    this.captureFrameSize = Math.max(1, Math.round(sampleRate * CAPTURE_FRAME_MS / 1000));
    this.captureFrame = new Float32Array(this.captureFrameSize);
    this.captureOffset = 0;
    this.playbackEpoch = 0;
    this.playbackQueue = [];
    this.currentChunk = null;
    this.playbackCursors = new Map();
    this.renderedSinceReport = 0;
    this.stopped = false;
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.kind === "set-gate") {
      if (!Number.isSafeInteger(message.captureEpoch) || message.captureEpoch < this.captureEpoch || typeof message.muted !== "boolean") return;
      this.captureEpoch = message.captureEpoch;
      this.captureMuted = message.muted;
      this.captureOffset = 0;
      this.port.postMessage({ kind: "gate-applied", captureEpoch: this.captureEpoch, muted: this.captureMuted });
      return;
    }
    if (message.kind === "output-pcm") {
      if (!(message.samples instanceof ArrayBuffer) || !Number.isSafeInteger(message.sequence) || !Number.isSafeInteger(message.playbackEpoch)) return;
      const chunk = {
        samples: new Float32Array(message.samples),
        sequence: message.sequence,
        playbackEpoch: message.playbackEpoch,
        responseKey: typeof message.responseKey === "string" ? message.responseKey : "",
        itemId: typeof message.itemId === "string" ? message.itemId : "",
        contentIndex: Number.isSafeInteger(message.contentIndex) && message.contentIndex >= 0 ? message.contentIndex : 0,
        sampleOffset: Number.isSafeInteger(message.sampleOffset) && message.sampleOffset >= 0 ? message.sampleOffset : 0,
        position: 0,
      };
      if (chunk.playbackEpoch !== this.playbackEpoch || this.stopped) {
        this.port.postMessage({ kind: "chunk-dropped", sequence: chunk.sequence });
        return;
      }
      this.playbackQueue.push(chunk);
      return;
    }
    if (message.kind === "interrupt") {
      this.playbackEpoch = Number.isSafeInteger(message.playbackEpoch) ? message.playbackEpoch : this.playbackEpoch + 1;
      const cursors = this.cursorSnapshot();
      this.dropQueuedPlayback();
      this.port.postMessage({ kind: "interruption-applied", requestId: message.requestId, playbackEpoch: this.playbackEpoch, cursors });
      return;
    }
    if (message.kind === "playback-reset") {
      if (Number.isSafeInteger(message.playbackEpoch) && message.playbackEpoch >= this.playbackEpoch) {
        this.playbackEpoch = message.playbackEpoch;
        this.playbackCursors.clear();
        this.dropQueuedPlayback();
      }
      return;
    }
    if (message.kind === "release") {
      this.stopped = true;
      this.captureMuted = true;
      this.captureOffset = 0;
      this.dropQueuedPlayback();
      this.port.postMessage({ kind: "media-stopped" });
    }
  }

  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (!this.stopped && !this.captureMuted) this.capture(inputs[0]?.[0]);
    if (!this.stopped && output) this.render(output);
    return true;
  }

  capture(input) {
    if (!input) return;
    let sourceOffset = 0;
    while (sourceOffset < input.length) {
      const count = Math.min(this.captureFrameSize - this.captureOffset, input.length - sourceOffset);
      this.captureFrame.set(input.subarray(sourceOffset, sourceOffset + count), this.captureOffset);
      this.captureOffset += count;
      sourceOffset += count;
      if (this.captureOffset === this.captureFrameSize) {
        const samples = this.captureFrame;
        this.captureFrame = new Float32Array(this.captureFrameSize);
        this.captureOffset = 0;
        this.port.postMessage({ kind: "input-frame", sampleRate, captureEpoch: this.captureEpoch, samples: samples.buffer }, [samples.buffer]);
      }
    }
  }

  render(output) {
    const sourceStep = PLAYBACK_SAMPLE_RATE / sampleRate;
    for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
      if (!this.currentChunk) this.currentChunk = this.playbackQueue.shift() ?? null;
      const chunk = this.currentChunk;
      if (!chunk) break;
      if (chunk.playbackEpoch !== this.playbackEpoch) {
        this.finishChunk(chunk, true);
        this.currentChunk = null;
        outputIndex -= 1;
        continue;
      }
      const position = chunk.position;
      const leftIndex = Math.floor(position);
      const rightIndex = Math.min(chunk.samples.length - 1, leftIndex + 1);
      const fraction = position - leftIndex;
      const left = chunk.samples[leftIndex] ?? 0;
      const right = chunk.samples[rightIndex] ?? left;
      output[outputIndex] = left + (right - left) * fraction;
      chunk.position += sourceStep;
      if (chunk.itemId) {
        const cursorKey = `${chunk.itemId}\u0000${chunk.contentIndex}`;
        const playedSamples = chunk.sampleOffset + Math.min(chunk.samples.length, Math.floor(chunk.position));
        const previous = this.playbackCursors.get(cursorKey);
        this.playbackCursors.set(cursorKey, {
          itemId: chunk.itemId,
          contentIndex: chunk.contentIndex,
          playedSamples: Math.max(previous?.playedSamples ?? 0, playedSamples),
          sampleRate: PLAYBACK_SAMPLE_RATE,
        });
        while (this.playbackCursors.size > 64) {
          const oldestKey = this.playbackCursors.keys().next().value;
          if (oldestKey === undefined) break;
          this.playbackCursors.delete(oldestKey);
        }
      }
      if (chunk.position >= chunk.samples.length) {
        this.finishChunk(chunk, false);
        this.currentChunk = null;
      }
    }
    this.renderedSinceReport += output.length;
    if (this.renderedSinceReport >= sampleRate / 10) {
      this.renderedSinceReport = 0;
      this.port.postMessage({ kind: "playback-position", cursors: this.cursorSnapshot() });
    }
  }

  finishChunk(chunk, dropped) {
    this.port.postMessage({ kind: dropped ? "chunk-dropped" : "chunk-played", sequence: chunk.sequence });
  }

  dropQueuedPlayback() {
    if (this.currentChunk) this.finishChunk(this.currentChunk, true);
    this.currentChunk = null;
    for (const chunk of this.playbackQueue) this.finishChunk(chunk, true);
    this.playbackQueue.length = 0;
  }

  cursorSnapshot() {
    return [...this.playbackCursors.values()].slice(-64);
  }
}

registerProcessor("pi-live-pcm", PiLivePcmProcessor);
