import { randomUUID } from "node:crypto";
import type { LiveBinding } from "@pi-desktop/shared";
import { geminiAudioEndMessage, geminiAudioMessage, geminiSetupMessage, geminiToolResponseMessage, geminiWorkFeedbackMessage, geminiWorkToolDeclaration, MAX_LIVE_AUDIO_BYTES, MAX_LIVE_JSON_BYTES, parseGeminiMessage, parseLiveWorkArguments, LIVE_WORK_TOOL_NAME } from "@pi-desktop/voice-runtime/live";
import type { LiveAdapter, LiveAdapterContext, LiveReceiptDelivery } from "./types";
import type { LiveWorkFeedback } from "@pi-desktop/shared";
import { openLiveWebSocket } from "./websocket-transport";
import { sendJsonBounded, sendJsonConfirmed, waitForReady, waitForSocketReady, websocketJson } from "./websocket-wire";
import { WebSocket } from "ws";

const GEMINI_LIVE_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MAX_FRAME_BYTES = 16000 * 2 / 10;

export function createGeminiAdapter(context: LiveAdapterContext): LiveAdapter {
  const binding = context.binding as Extract<LiveBinding, { adapterId: "gemini-live" }>;
  if (context.auth.kind !== "api-key") {
    throw Object.assign(new Error("Gemini Live requires a Provider API key"), { errorCode: "LIVE_AUTH_KIND_UNSUPPORTED" });
  }
  const apiKey = context.auth.apiKey;
  let socket: Awaited<ReturnType<typeof openLiveWebSocket>> | null = null;
  let closed = false;
  let muted = context.signal.aborted;
  let setupSent = false;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  const completedFunctionCalls = new Set<string>();
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });

  function sendFunctionReceipt(input: {
    providerRequestId: string;
    toolName: string;
    receipt: { status: "received"; operationId: string; execution: "not_started" } | { status: "rejected"; code: string };
  }): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Gemini Live socket is not open");
    sendJsonBounded(socket, geminiToolResponseMessage(input));
  }

  function handleToolCandidate(candidate: { providerRequestId: string; toolName: string; arguments: unknown }): void {
    if (completedFunctionCalls.has(candidate.providerRequestId)) return;
    if (completedFunctionCalls.size >= 256) throw new Error("tool call identity limit exceeded");
    completedFunctionCalls.add(candidate.providerRequestId);
    if (candidate.toolName !== LIVE_WORK_TOOL_NAME) {
      sendFunctionReceipt({ ...candidate, receipt: { status: "rejected", code: "LIVE_WORK_TOOL_UNSUPPORTED" } });
      return;
    }
    if (!context.workProfile) {
      sendFunctionReceipt({ ...candidate, receipt: { status: "rejected", code: "LIVE_WORK_NOT_BOUND" } });
      context.onEvent({ kind: "error", code: "LIVE_EXECUTION_NOT_CONNECTED" });
      return;
    }
    const parsed = parseLiveWorkArguments(candidate.arguments);
    if (!parsed) {
      sendFunctionReceipt({ ...candidate, receipt: { status: "rejected", code: "LIVE_WORK_INVALID_REQUEST" } });
      return;
    }
    if (!context.onWorkCandidate) {
      sendFunctionReceipt({ ...candidate, receipt: { status: "rejected", code: "LIVE_WORK_CAPABILITY_UNAVAILABLE" } });
      return;
    }
    void context.onWorkCandidate(
      { ...candidate, arguments: parsed },
      async (receipt) => {
        const deliveryId = randomUUID();
        try {
          if (!socket) throw new Error("Gemini Live socket is not open");
          await sendJsonConfirmed(socket, geminiToolResponseMessage({ ...candidate, receipt }), context.signal);
          return { status: "sent", deliveryId };
        } catch {
          return { status: "not-sent", deliveryId, code: "LIVE_WORK_FEEDBACK_UNDELIVERED" };
        }
      },
    ).catch(() => context.onEvent({ kind: "error", code: "LIVE_WORK_INTENT_UNAVAILABLE" }));
  }

  function onSocketFailure(): void {
    if (!closed && !context.signal.aborted) context.onEvent({ kind: "error", code: "LIVE_NETWORK_ERROR" });
  }

  function onSocketMessage(data: unknown): void {
    if (closed || context.signal.aborted) return;
    try {
      const value = websocketJson(data, MAX_LIVE_JSON_BYTES);
      const root = value as Record<string, unknown>;
      const server = root.serverContent as Record<string, unknown> | undefined;
      if (server?.modelTurn && typeof server.modelTurn === "object") {
        const parts = (server.modelTurn as { parts?: unknown[] }).parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            const inline = part && typeof part === "object" ? (part as { inlineData?: unknown }).inlineData : null;
            if (inline && typeof inline === "object") {
              const mimeType = (inline as { mimeType?: unknown }).mimeType;
              if (typeof mimeType === "string" && !/audio\/pcm;rate=24000/i.test(mimeType)) {
                throw new Error("unsupported Gemini audio sample rate");
              }
            }
          }
        }
      }
      for (const event of parseGeminiMessage(value)) {
        if (event.kind === "ready") readyResolve?.();
        if (event.kind === "tool-candidate") handleToolCandidate(event);
        else context.onEvent(event);
      }
    } catch {
      context.onEvent({ kind: "error", code: "LIVE_PROTOCOL_ERROR" });
      readyReject?.(Object.assign(new Error("Gemini Live protocol response is invalid"), { errorCode: "LIVE_PROTOCOL_ERROR" }));
    }
  }

  return {
    adapterId: "gemini-live",
    mediaKind: "pcm",
    async connect() {
      if (closed || context.signal.aborted) throw Object.assign(new Error("Live call was cancelled"), { errorCode: "LIVE_STALE_CALL" });
      const url = new URL(GEMINI_LIVE_ENDPOINT);
      url.searchParams.set("key", apiKey);
      const liveSocket = await openLiveWebSocket({ url: url.toString(), signal: context.signal, endpointOrigin: "third-party" });
      if (closed || context.signal.aborted) {
        liveSocket.terminate();
        throw Object.assign(new Error("Live call was cancelled"), { errorCode: "LIVE_STALE_CALL" });
      }
      socket = liveSocket;
      liveSocket.on("message", onSocketMessage);
      liveSocket.once("close", onSocketFailure);
      liveSocket.once("error", onSocketFailure);
      await waitForSocketReady(liveSocket, context.signal);
      if (closed || context.signal.aborted) {
        liveSocket.terminate();
        throw Object.assign(new Error("Live call was cancelled"), { errorCode: "LIVE_STALE_CALL" });
      }
      sendJsonBounded(liveSocket, geminiSetupMessage({ modelId: binding.modelId, voice: binding.voice, ...(context.workProfile ? { workProfile: context.workProfile } : {}) }));
      setupSent = true;
      await waitForReady(ready, context.signal, 12_000, "Gemini Live setup timed out");
      return {};
    },
    sendInputPcm(bytes) {
      if (closed || muted || !socket || socket.readyState !== WebSocket.OPEN) return;
      if (bytes.byteLength < 2 || bytes.byteLength > MAX_FRAME_BYTES || bytes.byteLength % 2 !== 0 || bytes.byteLength > MAX_LIVE_AUDIO_BYTES) {
        throw Object.assign(new Error("Gemini Live audio frame is invalid"), { errorCode: "LIVE_AUDIO_BACKPRESSURE" });
      }
      sendJsonBounded(socket, geminiAudioMessage(bytes));
    },
    async setInputMuted(nextMuted) {
      muted = nextMuted;
      if (nextMuted && socket?.readyState === WebSocket.OPEN) sendJsonBounded(socket, geminiAudioEndMessage());
    },
    async appendWorkFeedback(feedback: LiveWorkFeedback): Promise<LiveReceiptDelivery> {
      const deliveryId = randomUUID();
      if (!context.workProfile || feedback.callId !== context.callId || !socket || socket.readyState !== WebSocket.OPEN) {
        return { status: "not-sent", deliveryId, code: "LIVE_WORK_FEEDBACK_UNDELIVERED" };
      }
      try {
        await sendJsonConfirmed(socket, geminiWorkFeedbackMessage(feedback), context.signal);
        return { status: "sent", deliveryId };
      } catch {
        return { status: "not-sent", deliveryId, code: "LIVE_WORK_FEEDBACK_UNDELIVERED" };
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (setupSent) readyReject?.(new Error("Gemini Live call closed"));
      socket?.off("message", onSocketMessage);
      socket?.off("close", onSocketFailure);
      socket?.off("error", onSocketFailure);
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, "call ended");
      completedFunctionCalls.clear();
      socket = null;
    },
  };
}
