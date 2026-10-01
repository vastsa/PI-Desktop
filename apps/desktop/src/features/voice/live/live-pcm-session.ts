import { decodePcm16, encodePcm16, StreamingPcmResampler } from "@pi-desktop/voice-runtime/live";
import type { LivePlaybackCursor } from "@pi-desktop/shared";
import { liveError } from "./live-voice-api";

const MAX_INPUT_CREDITS = 10;
const MAX_PCM_FRAME_SAMPLES = 2400;
const MAX_WORKLET_MESSAGE_SAMPLES = 48_000;

export class LivePcmSession {
  private readonly callId: string;
  private readonly portNonce: string;
  private readonly port: MessagePort;
  private readonly inputSampleRate: 16000 | 24000;
  private readonly onFailure: (error: unknown) => void;
  private readonly onPlayback: (cursors: LivePlaybackCursor[]) => void;
  private readonly context: AudioContext;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly node: AudioWorkletNode;
  private readonly resampler: StreamingPcmResampler;
  private inputCredits = 0;
  private portReady = false;
  private nextInputSequence = 1;
  private captureEpoch = 0;
  private muted = true;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private releasePromise: Promise<void> | null = null;
  private releaseSent = false;
  private disposed = false;

  static async create(input: {
    callId: string;
    portNonce: string;
    port: MessagePort;
    stream: MediaStream;
    inputSampleRate: 16000 | 24000;
    workletUrl: string;
    context: AudioContext;
    onFailure: (error: unknown) => void;
    onPlayback: (cursors: LivePlaybackCursor[]) => void;
  }): Promise<LivePcmSession> {
    const context = input.context;
    if (!context.audioWorklet) {
      await context.close().catch(() => undefined);
      throw liveError("LIVE_MEDIA_UNSUPPORTED", "AudioWorklet is unavailable");
    }
    try {
      await context.audioWorklet.addModule(input.workletUrl);
      return new LivePcmSession(input);
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  private constructor(input: {
    callId: string;
    portNonce: string;
    port: MessagePort;
    stream: MediaStream;
    inputSampleRate: 16000 | 24000;
    workletUrl: string;
    onFailure: (error: unknown) => void;
    onPlayback: (cursors: LivePlaybackCursor[]) => void;
    context: AudioContext;
  }) {
    this.callId = input.callId;
    this.portNonce = input.portNonce;
    this.port = input.port;
    this.inputSampleRate = input.inputSampleRate;
    this.onFailure = input.onFailure;
    this.onPlayback = input.onPlayback;
    this.context = input.context;
    this.resampler = new StreamingPcmResampler(this.context.sampleRate, this.inputSampleRate);
    this.source = this.context.createMediaStreamSource(input.stream);
    this.node = new AudioWorkletNode(this.context, "pi-live-pcm", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
    });
    this.source.connect(this.node);
    this.node.connect(this.context.destination);
    this.node.port.onmessage = (event: MessageEvent<unknown>) => this.handleWorkletMessage(event.data);
    this.port.onmessage = (event: MessageEvent<unknown>) => this.handleMainMessage(event.data);
    this.port.onmessageerror = () => this.onFailure(liveError("LIVE_PROTOCOL_ERROR"));
    this.port.start();
    this.port.postMessage({ kind: "hello", callId: this.callId, nonce: input.portNonce });
  }

  async start(workletReady: Promise<void>, signal: AbortSignal): Promise<void> {
    await workletReady;
    if (signal.aborted) throw liveError("LIVE_STALE_CALL");
    try {
      await this.context.resume();
    } catch (error) {
      throw Object.assign(liveError("LIVE_PLAYBACK_BLOCKED", "Audio playback could not be started"), { cause: error });
    }
    await this.waitForReady(signal);
  }

  applyGate(muted: boolean, captureEpoch: number): void {
    if (this.disposed || !Number.isSafeInteger(captureEpoch) || captureEpoch < this.captureEpoch) return;
    this.muted = muted;
    this.captureEpoch = captureEpoch;
    this.node.port.postMessage({ kind: "set-gate", muted, captureEpoch });
  }

  async resumePlayback(): Promise<void> {
    if (this.disposed) throw liveError("LIVE_STALE_CALL");
    try {
      await this.context.resume();
    } catch (error) {
      throw Object.assign(liveError("LIVE_PLAYBACK_BLOCKED", "Audio playback could not be resumed"), { cause: error });
    }
  }

  resetPlayback(playbackEpoch: number): void {
    if (this.disposed || !Number.isSafeInteger(playbackEpoch)) return;
    this.node.port.postMessage({ kind: "playback-reset", playbackEpoch });
  }

  async release(): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    this.releasePromise = (async () => {
      if (this.disposed) return;
      this.disposed = true;
      this.resampler.reset();
      this.source.disconnect();
      this.node.port.postMessage({ kind: "release" });
      this.node.disconnect();
      this.acknowledgeRelease();
      try {
        if (this.context.state !== "closed") await this.context.close();
      } catch {
        // The microphone track is stopped by the owning call controller before this closes the context.
      }
    })();
    return this.releasePromise;
  }

  private acknowledgeRelease(): void {
    if (this.releaseSent) return;
    this.releaseSent = true;
    try {
      this.port.postMessage({ kind: "released", callId: this.callId });
    } catch {
      // The main side may have closed the port after confirming capture stopped.
    }
  }

  private waitForReady(signal: AbortSignal): Promise<void> {
    if (this.portReady) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.readyResolve = null;
        this.readyReject = null;
      };
      const onAbort = () => {
        cleanup();
        reject(liveError("LIVE_STALE_CALL"));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(liveError("LIVE_TIMEOUT", "Live audio port did not become ready", true));
      }, 3_000);
      this.readyResolve = () => {
        cleanup();
        resolve();
      };
      this.readyReject = (error) => {
        cleanup();
        reject(error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private handleMainMessage(value: unknown): void {
    const message = asRecord(value);
    if (!message || message.callId !== this.callId || typeof message.kind !== "string") {
      this.onFailure(liveError("LIVE_PROTOCOL_ERROR"));
      return;
    }
    switch (message.kind) {
      case "ready":
        if (message.nonce !== this.portNonce || !Number.isSafeInteger(message.inputCredits) || (message.inputCredits as number) < 0 || (message.inputCredits as number) > MAX_INPUT_CREDITS || message.outputSampleRate !== 24000) {
          this.onFailure(liveError("LIVE_PROTOCOL_ERROR"));
          return;
        }
        this.inputCredits = message.inputCredits as number;
        this.portReady = true;
        this.readyResolve?.();
        return;
      case "credit":
        if (message.direction === "uplink" && Number.isSafeInteger(message.consumedSequence)) {
          this.inputCredits = Math.min(MAX_INPUT_CREDITS, this.inputCredits + 1);
        }
        return;
      case "set-gate":
        if (typeof message.muted !== "boolean" || !Number.isSafeInteger(message.captureEpoch)) return;
        this.applyGate(message.muted, message.captureEpoch as number);
        return;
      case "output-pcm": {
        if (!(message.pcm16 instanceof ArrayBuffer) || message.pcm16.byteLength === 0 || message.pcm16.byteLength > MAX_PCM_FRAME_SAMPLES * 2 || message.pcm16.byteLength % 2 !== 0) {
          this.onFailure(liveError("LIVE_PROTOCOL_ERROR"));
          return;
        }
        const samples = decodePcm16(new Uint8Array(message.pcm16));
        const buffer = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer;
        this.node.port.postMessage({
          kind: "output-pcm",
          sequence: message.sequence,
          playbackEpoch: message.playbackEpoch,
          responseKey: message.responseKey,
          itemId: message.itemId,
          contentIndex: message.contentIndex,
          sampleOffset: message.sampleOffset,
          samples: buffer,
        }, [buffer]);
        return;
      }
      case "interrupt":
        if (typeof message.requestId !== "string" || !Number.isSafeInteger(message.playbackEpoch)) return;
        this.node.port.postMessage({ kind: "interrupt", requestId: message.requestId, playbackEpoch: message.playbackEpoch });
        return;
      case "playback-reset":
        if (Number.isSafeInteger(message.playbackEpoch)) this.node.port.postMessage({ kind: "playback-reset", playbackEpoch: message.playbackEpoch });
        return;
      case "release":
        void this.release().catch(this.onFailure);
        return;
      default:
        this.onFailure(liveError("LIVE_PROTOCOL_ERROR"));
    }
  }

  private handleWorkletMessage(value: unknown): void {
    const message = asRecord(value);
    if (!message || typeof message.kind !== "string") return this.onFailure(liveError("LIVE_PROTOCOL_ERROR"));
    switch (message.kind) {
      case "input-frame":
        if (!(message.samples instanceof ArrayBuffer) || !Number.isSafeInteger(message.sampleRate) || message.sampleRate !== this.context.sampleRate || !Number.isSafeInteger(message.captureEpoch)) {
          this.onFailure(liveError("LIVE_PROTOCOL_ERROR"));
          return;
        }
        this.sendInput(new Float32Array(message.samples), message.captureEpoch as number);
        return;
      case "gate-applied":
        if (typeof message.muted !== "boolean" || !Number.isSafeInteger(message.captureEpoch)) return;
        this.port.postMessage({ kind: "gate-applied", callId: this.callId, muted: message.muted, captureEpoch: message.captureEpoch });
        return;
      case "playback-position":
        if (!Array.isArray(message.cursors)) return;
        this.onPlayback(message.cursors as LivePlaybackCursor[]);
        this.port.postMessage({ kind: "playback-position", callId: this.callId, cursors: message.cursors });
        return;
      case "chunk-played":
      case "chunk-dropped":
        if (Number.isSafeInteger(message.sequence)) this.port.postMessage({ kind: "credit", callId: this.callId, direction: "downlink", consumedSequence: message.sequence });
        return;
      case "interruption-applied":
        if (typeof message.requestId !== "string" || !Array.isArray(message.cursors) || !Number.isSafeInteger(message.playbackEpoch)) return;
        this.onPlayback(message.cursors as LivePlaybackCursor[]);
        this.port.postMessage({ kind: "interruption-applied", callId: this.callId, requestId: message.requestId, playbackEpoch: message.playbackEpoch, cursors: message.cursors });
        return;
      case "media-stopped":
        return;
      default:
        this.onFailure(liveError("LIVE_PROTOCOL_ERROR"));
    }
  }

  private sendInput(samples: Float32Array, captureEpoch: number): void {
    if (this.disposed || this.muted || captureEpoch !== this.captureEpoch || this.inputCredits <= 0) return;
    const converted = this.resampler.push(samples);
    for (let offset = 0; offset < converted.length; offset += MAX_PCM_FRAME_SAMPLES) {
      const chunk = converted.subarray(offset, Math.min(converted.length, offset + MAX_PCM_FRAME_SAMPLES));
      if (chunk.length === 0 || this.inputCredits <= 0) return;
      const pcm16 = encodePcm16(chunk);
      const buffer = pcm16.buffer.slice(pcm16.byteOffset, pcm16.byteOffset + pcm16.byteLength) as ArrayBuffer;
      const sequence = this.nextInputSequence++;
      this.inputCredits -= 1;
      this.port.postMessage({ kind: "input-pcm", callId: this.callId, sequence, captureEpoch, pcm16: buffer });
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
