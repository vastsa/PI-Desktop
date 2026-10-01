import { MAX_LIVE_JSON_BYTES } from "@pi-desktop/voice-runtime/live";
import { WebSocket } from "ws";

const MAX_BUFFERED_JSON_BYTES = 128 * 1024;
const SOCKET_READY_TIMEOUT_MS = 15_000;

export function websocketJson(data: unknown, maxBytes = MAX_LIVE_JSON_BYTES): unknown {
  let text: string;
  if (typeof data === "string") text = data;
  else if (Buffer.isBuffer(data)) text = data.toString("utf8");
  else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
  else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  else throw new Error("Live provider sent a non-text event");
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("Live provider event exceeded the size limit");
  return JSON.parse(text) as unknown;
}

function boundedJsonBody(socket: WebSocket, value: unknown): string {
  const body = JSON.stringify(value);
  const byteLength = Buffer.byteLength(body, "utf8");
  if (byteLength > MAX_LIVE_JSON_BYTES || socket.bufferedAmount + byteLength > MAX_BUFFERED_JSON_BYTES) {
    throw Object.assign(new Error("Live audio transport queue is full"), { errorCode: "LIVE_AUDIO_BACKPRESSURE" });
  }
  return body;
}

export function sendJsonBounded(socket: WebSocket, value: unknown): void {
  socket.send(boundedJsonBody(socket, value), (error) => {
    if (error) socket.terminate();
  });
}

/** A receipt is sent only after the local socket write succeeds, not when it is queued. */
export async function sendJsonConfirmed(socket: WebSocket, value: unknown, signal: AbortSignal): Promise<void> {
  const body = boundedJsonBody(socket, value);
  if (socket.readyState !== WebSocket.OPEN || signal.aborted) {
    throw Object.assign(new Error("Live provider message was not sent"), { errorCode: "LIVE_WORK_FEEDBACK_UNDELIVERED" });
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const failure = () => Object.assign(new Error("Live provider message was not sent"), { errorCode: "LIVE_WORK_FEEDBACK_UNDELIVERED" });
    const onFailure = () => finish(failure());
    const timer = setTimeout(onFailure, 1_000);
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("close", onFailure);
      socket.off("error", onFailure);
      signal.removeEventListener("abort", onFailure);
      if (error) reject(error);
      else resolve();
    }
    socket.once("close", onFailure);
    socket.once("error", onFailure);
    signal.addEventListener("abort", onFailure, { once: true });
    try {
      socket.send(body, (error) => {
        finish(error ? failure() : undefined);
        if (error) socket.terminate();
      });
    } catch {
      finish(failure());
    }
  });
}

export async function waitForSocketReady(socket: WebSocket, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw Object.assign(new Error("Live provider connection was cancelled"), { errorCode: "LIVE_STALE_CALL" });
  }
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(Object.assign(new Error("Live provider socket timed out"), { errorCode: "LIVE_TIMEOUT" })), SOCKET_READY_TIMEOUT_MS);
    const onOpen = () => finish();
    const onError = () => finish(Object.assign(new Error("Live provider socket failed"), { errorCode: "LIVE_NETWORK_ERROR" }));
    const onClose = () => finish(Object.assign(new Error("Live provider closed during handshake"), { errorCode: "LIVE_NETWORK_ERROR" }));
    const onAbort = () => finish(Object.assign(new Error("Live provider connection was cancelled"), { errorCode: "LIVE_STALE_CALL" }));
    function cleanup(): void {
      clearTimeout(timeout);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    }
    function finish(error?: Error): void {
      cleanup();
      if (error) reject(error);
      else resolve();
    }
    if (signal.aborted) return onAbort();
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForReady(
  promise: Promise<void>,
  signal: AbortSignal,
  timeoutMs: number,
  message: string,
): Promise<void> {
  if (signal.aborted) throw Object.assign(new Error("Live setup was cancelled"), { errorCode: "LIVE_STALE_CALL" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(Object.assign(new Error("Live setup was cancelled"), { errorCode: "LIVE_STALE_CALL" }));
    signal.addEventListener("abort", abortListener, { once: true });
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { errorCode: "LIVE_TIMEOUT" })), timeoutMs);
  });
  try {
    await Promise.race([promise, aborted, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}
