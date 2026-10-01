import { MessageChannelMain, type MessagePortMain, type WebFrameMain } from "electron";
import { randomUUID } from "node:crypto";
import type { LivePlaybackCursor } from "@pi-desktop/shared";
import { IPC } from "@pi-desktop/shared";

export type LivePcmBridge = {
  readonly portNonce: string;
  readonly ready: Promise<void>;
  setMuted(muted: boolean, captureEpoch: number): Promise<void>;
  sendOutput(input: { bytes: Uint8Array; playbackEpoch: number; responseId?: string; itemId?: string; contentIndex?: number }): void;
  reportPlayback(cursors: LivePlaybackCursor[]): void;
  isPlaybackIdle(): boolean;
  interrupt(): Promise<LivePlaybackCursor[]>;
  requestRelease(): Promise<void>;
  close(): void;
};

export type LivePcmBridgeOptions = {
  callId: string;
  ownerFrame: WebFrameMain;
  inputSampleRate: 16000 | 24000;
  outputSampleRate: 24000;
  onInput: (bytes: Uint8Array, captureEpoch: number) => void;
  onPlaybackPosition: (cursors: LivePlaybackCursor[]) => void;
  onPlaybackStateChanged?: () => void;
  onReleased: () => void;
  onFailure: (code: string) => void;
};

const MAX_INPUT_CREDITS = 10;
const MAX_OUTPUT_CREDITS = 10;
const MAX_PORT_FRAME_MS = 100;
const MAX_INTERRUPTION_ACK_MS = 120;
const MAX_RELEASE_ACK_MS = 1_000;

export function createLivePcmBridge(options: LivePcmBridgeOptions): LivePcmBridge {
  const channel = new MessageChannelMain();
  const port = channel.port1;
  const portNonce = randomUUID();
  const maxInputBytes = options.inputSampleRate * 2 * MAX_PORT_FRAME_MS / 1000;
  const maxOutputBytes = options.outputSampleRate * 2 * MAX_PORT_FRAME_MS / 1000;
  let closed = false;
  let readyState: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let muted = true;
  let captureEpoch = 0;
  let expectedInputSequence = 1;
  let nextOutputSequence = 1;
  let outputCredits = 0;
  const outstandingOutputCredits = new Map<number, number>();
  let playbackEpoch = 0;
  let releaseResolve: (() => void) | null = null;
  const interruptRequests = new Map<string, { resolve: (cursors: LivePlaybackCursor[]) => void; timer: ReturnType<typeof setTimeout> }>();
  const mutedWaiters = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let downlinkSamples = 0;
  const outputOffsets = new Map<string, number>();

  const ready = new Promise<void>((resolve, reject) => {
    readyState = resolve;
    readyReject = reject;
  });

  function post(data: unknown): void {
    if (closed) return;
    port.postMessage(data);
  }

  function fail(code: string): void {
    options.onFailure(code);
    close();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    readyReject?.(new Error("Live PCM port closed"));
    readyReject = null;
    releaseResolve?.();
    releaseResolve = null;
    for (const waiter of interruptRequests.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    interruptRequests.clear();
    for (const waiter of mutedWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Live PCM port closed"));
    }
    mutedWaiters.clear();
    outputOffsets.clear();
    port.removeAllListeners();
    port.close();
    channel.port2.close();
  }

  function handleMessage(raw: unknown): void {
    if (closed || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail("LIVE_PROTOCOL_ERROR");
      return;
    }
    const message = raw as Record<string, unknown>;
    if (message.callId !== options.callId || typeof message.kind !== "string") {
      fail("LIVE_INVALID_OWNER");
      return;
    }
    switch (message.kind) {
      case "hello":
        if (readyState === null) return;
        if (message.nonce !== portNonce) return fail("LIVE_INVALID_OWNER");
        outputCredits = MAX_OUTPUT_CREDITS;
        post({ kind: "ready", callId: options.callId, nonce: portNonce, inputCredits: MAX_INPUT_CREDITS, outputSampleRate: options.outputSampleRate });
        readyState();
        readyState = null;
        return;
      case "input-pcm": {
        const data = message.pcm16;
        const sequence = message.sequence;
        const epoch = message.captureEpoch;
        if (!(data instanceof ArrayBuffer) || data.byteLength < 2 || data.byteLength > maxInputBytes || data.byteLength % 2 !== 0 || !Number.isSafeInteger(sequence) || sequence !== expectedInputSequence || !Number.isSafeInteger(epoch)) {
          fail("LIVE_PROTOCOL_ERROR");
          return;
        }
        expectedInputSequence += 1;
        const accepted = !muted && epoch === captureEpoch;
        if (accepted) options.onInput(new Uint8Array(data), captureEpoch);
        post({ kind: "credit", callId: options.callId, direction: "uplink", consumedSequence: sequence, accepted });
        return;
      }
      case "gate-applied": {
        const epoch = message.captureEpoch;
        const value = message.muted;
        if (!Number.isSafeInteger(epoch) || typeof value !== "boolean" || epoch !== captureEpoch || value !== muted) return;
        const waiter = mutedWaiters.get(epoch as number);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        mutedWaiters.delete(epoch as number);
        waiter.resolve();
        return;
      }
      case "credit": {
        const sequence = message.consumedSequence;
        if (message.direction !== "downlink" || !Number.isSafeInteger(sequence)) return;
        const creditedSamples = outstandingOutputCredits.get(sequence as number);
        if (creditedSamples === undefined) return;
        outstandingOutputCredits.delete(sequence as number);
        downlinkSamples = Math.max(0, downlinkSamples - creditedSamples);
        outputCredits = Math.min(MAX_OUTPUT_CREDITS, outputCredits + 1);
        options.onPlaybackStateChanged?.();
        return;
      }
      case "playback-position": {
        const cursors = parseCursors(message.cursors);
        if (!cursors) return fail("LIVE_PROTOCOL_ERROR");
        options.onPlaybackPosition(cursors);
        return;
      }
      case "interruption-applied": {
        const id = message.requestId;
        const cursors = parseCursors(message.cursors);
        if (typeof id !== "string" || !cursors) return fail("LIVE_PROTOCOL_ERROR");
        const waiter = interruptRequests.get(id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        interruptRequests.delete(id);
        options.onPlaybackPosition(cursors);
        playbackEpoch = Number.isSafeInteger(message.playbackEpoch) ? message.playbackEpoch as number : playbackEpoch + 1;
        downlinkSamples = 0;
        outstandingOutputCredits.clear();
        outputCredits = MAX_OUTPUT_CREDITS;
        outputOffsets.clear();
        options.onPlaybackStateChanged?.();
        post({ kind: "playback-reset", callId: options.callId, playbackEpoch });
        waiter.resolve(cursors);
        return;
      }
      case "released":
        options.onReleased();
        releaseResolve?.();
        releaseResolve = null;
        return;
      default:
        fail("LIVE_PROTOCOL_ERROR");
    }
  }

  port.on("message", (event: { data: unknown }) => handleMessage(event.data));
  port.start();
  try {
    options.ownerFrame.postMessage(IPC.event.liveVoicePort, { callId: options.callId, nonce: portNonce }, [channel.port2]);
  } catch {
    close();
    throw Object.assign(new Error("Live audio port could not be transferred to the owner frame"), { errorCode: "LIVE_INVALID_OWNER" });
  }

  function setMuted(nextMuted: boolean, nextEpoch: number): Promise<void> {
    if (closed) return Promise.reject(new Error("Live PCM port closed"));
    if (!Number.isSafeInteger(nextEpoch) || nextEpoch < captureEpoch || (nextEpoch === captureEpoch && muted !== nextMuted)) {
      return Promise.reject(Object.assign(new Error("Live capture epoch is stale"), { errorCode: "LIVE_STALE_CALL" }));
    }
    captureEpoch = nextEpoch;
    muted = nextMuted;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        mutedWaiters.delete(nextEpoch);
        reject(Object.assign(new Error("Live capture gate acknowledgement timed out"), { errorCode: "LIVE_TIMEOUT" }));
      }, 1_000);
      mutedWaiters.set(nextEpoch, { resolve, reject, timer });
      post({ kind: "set-gate", callId: options.callId, muted: nextMuted, captureEpoch: nextEpoch });
    });
  }

  function sendOutput(input: { bytes: Uint8Array; playbackEpoch: number; responseId?: string; itemId?: string; contentIndex?: number }): void {
    if (closed) return;
    if (input.bytes.byteLength === 0 || input.bytes.byteLength % 2 !== 0) return fail("LIVE_PROTOCOL_ERROR");
    const key = `${input.responseId ?? ""}:${input.itemId ?? ""}:${input.contentIndex ?? 0}`;
    if (input.itemId && outputOffsets.size >= 256 && !outputOffsets.has(key)) return fail("LIVE_AUDIO_BACKPRESSURE");
    let offset = outputOffsets.get(key) ?? 0;
    for (let start = 0; start < input.bytes.length; start += maxOutputBytes) {
      const end = Math.min(input.bytes.length, start + maxOutputBytes);
      if (outputCredits <= 0 || downlinkSamples + (end - start) / 2 > options.outputSampleRate) return fail("LIVE_AUDIO_BACKPRESSURE");
      const data = input.bytes.slice(start, end);
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      const sequence = nextOutputSequence++;
      outputCredits -= 1;
      outstandingOutputCredits.set(sequence, data.byteLength / 2);
      downlinkSamples += data.byteLength / 2;
      post({
        kind: "output-pcm",
        callId: options.callId,
        sequence,
        playbackEpoch: input.playbackEpoch,
        responseKey: key,
        itemId: input.itemId,
        contentIndex: input.contentIndex ?? 0,
        sampleOffset: offset,
        pcm16: buffer,
      });
      offset += data.byteLength / 2;
    }
    outputOffsets.set(key, offset);
    options.onPlaybackStateChanged?.();
  }

  function reportPlayback(cursors: LivePlaybackCursor[]): void {
    if (closed) return;
    if (cursors.length > 64 || cursors.some((cursor) => cursor.sampleRate !== options.outputSampleRate || !Number.isSafeInteger(cursor.playedSamples) || cursor.playedSamples < 0)) {
      return fail("LIVE_PROTOCOL_ERROR");
    }
    options.onPlaybackPosition(cursors);
  }

  function interrupt(): Promise<LivePlaybackCursor[]> {
    if (closed) return Promise.reject(new Error("Live PCM port closed"));
    const requestId = randomUUID();
    return new Promise<LivePlaybackCursor[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        interruptRequests.delete(requestId);
        reject(Object.assign(new Error("Live playback did not confirm interruption"), { errorCode: "LIVE_TIMEOUT" }));
      }, MAX_INTERRUPTION_ACK_MS);
      interruptRequests.set(requestId, { resolve, timer });
      post({ kind: "interrupt", callId: options.callId, requestId, playbackEpoch: playbackEpoch + 1 });
    });
  }

  function requestRelease(): Promise<void> {
    if (closed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        releaseResolve = null;
        reject(Object.assign(new Error("Live microphone release was not confirmed"), { errorCode: "LIVE_MEDIA_RELEASE_UNCONFIRMED" }));
      }, MAX_RELEASE_ACK_MS);
      releaseResolve = () => { clearTimeout(timer); resolve(); };
      post({ kind: "release", callId: options.callId });
    });
  }

  return {
    portNonce,
    ready,
    setMuted,
    sendOutput,
    reportPlayback,
    isPlaybackIdle: () => downlinkSamples === 0 && outstandingOutputCredits.size === 0,
    interrupt,
    requestRelease,
    close,
  };
}

function parseCursors(value: unknown): LivePlaybackCursor[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const result: LivePlaybackCursor[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.itemId !== "string" || item.itemId.length > 256 || !Number.isSafeInteger(item.contentIndex) || !Number.isSafeInteger(item.playedSamples) || (item.playedSamples as number) < 0 || item.sampleRate !== 24000) return null;
    result.push({ itemId: item.itemId, contentIndex: item.contentIndex as number, playedSamples: item.playedSamples as number, sampleRate: 24000 });
  }
  return result;
}
