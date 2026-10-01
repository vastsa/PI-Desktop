import { randomUUID } from "node:crypto";
import type { LiveBinding } from "@pi-desktop/shared";
import { LIVE_WORK_TOOL_NAME, MAX_LIVE_AUDIO_BYTES, MAX_LIVE_JSON_BYTES, parseLiveWorkArguments, parseRealtimeMessage, RealtimeResponseTracker, realtimeAudioMessage, realtimeSessionMatches, realtimeSessionUpdateMessage, realtimeToolReceiptMessage, realtimeTruncateMessages, realtimeWorkFeedbackMessages } from "@pi-desktop/voice-runtime/live";
import type { LiveAdapter, LiveAdapterContext, LivePlaybackCursor, LiveReceiptDelivery } from "./types";
import type { LiveWorkFeedback } from "@pi-desktop/shared";
import { openLiveWebSocket } from "./websocket-transport";
import { sendJsonBounded, sendJsonConfirmed, waitForReady, waitForSocketReady, websocketJson } from "./websocket-wire";
import { WebSocket } from "ws";

const MAX_FRAME_BYTES = 24000 * 2 / 10;

function realtimeUrl(baseUrl: string, modelId: string): string {
  let base: URL;
  try { base = new URL(baseUrl); } catch { throw Object.assign(new Error("Realtime Provider URL is invalid"), { errorCode: "LIVE_PROTOCOL_UNSUPPORTED" }); }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw Object.assign(new Error("Realtime Provider must use an HTTPS base URL without credentials or query parameters"), { errorCode: "LIVE_PROTOCOL_UNSUPPORTED" });
  }
  let path = base.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/realtime")) path = `${path}/realtime`;
  base.pathname = path;
  base.protocol = "wss:";
  base.search = "";
  base.searchParams.set("model", modelId);
  base.hash = "";
  return base.toString();
}

export function createOpenAIRealtimeAdapter(context: LiveAdapterContext): LiveAdapter {
  const binding = context.binding as Extract<LiveBinding, { adapterId: "openai-realtime" }>;
  if (context.auth.kind !== "api-key") {
    throw Object.assign(new Error("Realtime requires an API-key Provider"), { errorCode: "LIVE_AUTH_KIND_UNSUPPORTED" });
  }
  const apiKey = context.auth.apiKey;
  const baseUrl = context.auth.baseUrl;
  let socket: Awaited<ReturnType<typeof openLiveWebSocket>> | null = null;
  let closed = false;
  let muted = true;
  let createdResolve: (() => void) | null = null;
  let updatedResolve: (() => void) | null = null;
  let createdReject: ((error: Error) => void) | null = null;
  let updatedReject: ((error: Error) => void) | null = null;
  let sessionUpdateSent = false;
  let configured = false;
  const responseTracker = new RealtimeResponseTracker();
  const settledFunctionCalls = new Set<string>();
  const created = new Promise<void>((resolve, reject) => { createdResolve = resolve; createdReject = reject; });
  const updated = new Promise<void>((resolve, reject) => { updatedResolve = resolve; updatedReject = reject; });

  function sendToolReceipt(input: {
    providerRequestId: string;
    receipt: { status: "received"; operationId: string; execution: "not_started" } | { status: "rejected"; code: string };
    resume: boolean;
  }): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Realtime socket is not open");
    sendJsonBounded(socket, realtimeToolReceiptMessage(input));
    if (input.resume) sendJsonBounded(socket, { type: "response.create" });
  }

  function handleToolCandidate(candidate: { providerRequestId: string; toolName: string; arguments: unknown }): void {
    if (settledFunctionCalls.has(candidate.providerRequestId)) return;
    if (settledFunctionCalls.size >= 256) throw Object.assign(new Error("Realtime function-call limit exceeded"), { errorCode: "LIVE_PROTOCOL_ERROR" });
    settledFunctionCalls.add(candidate.providerRequestId);
    const reject = (code: string, resume: boolean) => sendToolReceipt({
      providerRequestId: candidate.providerRequestId,
      receipt: { status: "rejected", code },
      resume,
    });
    if (candidate.toolName !== LIVE_WORK_TOOL_NAME) {
      reject("LIVE_WORK_TOOL_UNSUPPORTED", true);
      return;
    }
    if (!context.workProfile) {
      reject("LIVE_WORK_NOT_BOUND", true);
      context.onEvent({ kind: "error", code: "LIVE_EXECUTION_NOT_CONNECTED" });
      return;
    }
    const parsed = parseLiveWorkArguments(candidate.arguments);
    if (!parsed) {
      reject("LIVE_WORK_INVALID_REQUEST", false);
      return;
    }
    if (!context.onWorkCandidate) {
      reject("LIVE_WORK_CAPABILITY_UNAVAILABLE", false);
      return;
    }
    void context.onWorkCandidate(
      { ...candidate, arguments: parsed },
      async (receipt) => {
        const deliveryId = randomUUID();
        try {
          if (!socket) throw new Error("Realtime socket is not open");
          await sendJsonConfirmed(socket, realtimeToolReceiptMessage({ providerRequestId: candidate.providerRequestId, receipt }), context.signal);
          return { status: "sent", deliveryId };
        } catch {
          return { status: "not-sent", deliveryId, code: "LIVE_WORK_FEEDBACK_UNDELIVERED" };
        }
      },
    ).catch(() => context.onEvent({ kind: "error", code: "LIVE_WORK_INTENT_UNAVAILABLE" }));
  }

  function onSocketFailure(): void {
    if (!closed) context.onEvent({ kind: "error", code: "LIVE_NETWORK_ERROR" });
  }

  function onSocketMessage(data: unknown): void {
    if (closed || context.signal.aborted) return;
    try {
      const value = websocketJson(data, MAX_LIVE_JSON_BYTES);
      const event = value as Record<string, unknown>;
      let staleCompletion = false;
      if (event.type === "session.created") {
        createdResolve?.();
        if (!sessionUpdateSent) {
          sessionUpdateSent = true;
          sendJsonBounded(socket!, realtimeSessionUpdateMessage({ modelId: binding.modelId, voice: binding.voice, profile: binding.wireProfile, ...(context.workProfile ? { workProfile: context.workProfile } : {}) }));
        }
      }
      if (event.type === "session.updated" && sessionUpdateSent) {
        if (!realtimeSessionMatches({ session: event.session, modelId: binding.modelId, voice: binding.voice, profile: binding.wireProfile, workEnabled: Boolean(context.workProfile) })) {
          throw Object.assign(new Error("Realtime session confirmation does not match the selected audio profile"), { errorCode: "LIVE_PROTOCOL_ERROR" });
        }
        configured = true;
        updatedResolve?.();
      }
      if (event.type === "response.created") {
        const response = event.response && typeof event.response === "object" ? event.response as { id?: unknown } : null;
        const responseId = typeof response?.id === "string" ? response.id : typeof event.response_id === "string" ? event.response_id : null;
        if (!responseId) throw Object.assign(new Error("Realtime response omitted its identity"), { errorCode: "LIVE_PROTOCOL_ERROR" });
        responseTracker.add(responseId);
      }
      if (event.type === "input_audio_buffer.speech_started") {
        responseTracker.interrupt();
      }
      if (event.type === "response.done" || event.type === "response.cancelled") {
        const response = event.response && typeof event.response === "object" ? event.response as { id?: unknown } : null;
        const responseId = typeof event.response_id === "string" ? event.response_id : typeof response?.id === "string" ? response.id : null;
        if (!responseId) throw Object.assign(new Error("Realtime completion omitted its response identity"), { errorCode: "LIVE_PROTOCOL_ERROR" });
        staleCompletion = responseTracker.finish(responseId);
      }
      if (event.type === "error") {
        const detail = event.error && typeof event.error === "object" ? event.error as { code?: unknown } : null;
        if (detail?.code === "response_cancel_not_active") return;
      }
      if (event.type === "response.output_item.done") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string" || new TextEncoder().encode(item.arguments).byteLength > 8 * 1024) {
            throw Object.assign(new Error("Realtime function call is invalid"), { errorCode: "LIVE_PROTOCOL_ERROR" });
          }
          let args: unknown;
          try { args = JSON.parse(item.arguments); } catch { args = null; }
          handleToolCandidate({ providerRequestId: item.call_id, toolName: item.name, arguments: args });
        }
      }
      const normalizedEvents = parseRealtimeMessage(value, binding.wireProfile);
      for (const normalized of normalizedEvents) {
        if (normalized.kind === "audio" && normalized.responseId && !responseTracker.shouldAcceptAudio(normalized.responseId)) continue;
        if (staleCompletion && (normalized.kind === "turn-complete" || (normalized.kind === "activity" && normalized.assistantSpeaking === false))) continue;
        if (normalized.kind === "tool-candidate") handleToolCandidate(normalized);
        else context.onEvent(normalized);
      }
    } catch {
      context.onEvent({ kind: "error", code: "LIVE_PROTOCOL_ERROR" });
      const failure = Object.assign(new Error("Realtime protocol response is invalid"), { errorCode: "LIVE_PROTOCOL_ERROR" });
      createdReject?.(failure);
      updatedReject?.(failure);
    }
  }

  return {
    adapterId: "openai-realtime",
    mediaKind: "pcm",
    async connect() {
      if (closed || context.signal.aborted) throw Object.assign(new Error("Live call was cancelled"), { errorCode: "LIVE_STALE_CALL" });
      const url = realtimeUrl(baseUrl, binding.modelId);
      const liveSocket = await openLiveWebSocket({ url, headers: { Authorization: `Bearer ${apiKey}`, ...(binding.wireProfile === "realtime-compat-v1" ? { "OpenAI-Beta": "realtime=v1" } : {}) }, signal: context.signal, endpointOrigin: "user" });
      socket = liveSocket;
      liveSocket.on("message", onSocketMessage);
      liveSocket.once("close", onSocketFailure);
      liveSocket.once("error", onSocketFailure);
      await waitForSocketReady(liveSocket, context.signal);
      await waitForReady(created, context.signal, 12_000, "Realtime session creation timed out");
      await waitForReady(updated, context.signal, 12_000, "Realtime session update timed out");
      return {};
    },
    sendInputPcm(bytes) {
      if (closed || !configured || muted || !socket || socket.readyState !== WebSocket.OPEN) return;
      if (bytes.byteLength < 2 || bytes.byteLength > MAX_FRAME_BYTES || bytes.byteLength > MAX_LIVE_AUDIO_BYTES || bytes.byteLength % 2 !== 0) {
        throw Object.assign(new Error("Realtime audio frame is invalid"), { errorCode: "LIVE_AUDIO_BACKPRESSURE" });
      }
      sendJsonBounded(socket, realtimeAudioMessage(bytes));
    },
    async setInputMuted(nextMuted) {
      muted = nextMuted;
    },
    async interrupt(cursors?: LivePlaybackCursor[]) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (responseTracker.shouldSendCancel()) sendJsonBounded(socket, { type: "response.cancel" });
      for (const cursor of cursors ?? []) {
        const messages = realtimeTruncateMessages({ itemId: cursor.itemId, contentIndex: cursor.contentIndex, audioEndMs: cursor.playedSamples * 1000 / cursor.sampleRate });
        // Local playback is already stopped; send the measured interruption cursor upstream.
        sendJsonBounded(socket, messages[1]);
      }
    },
    async appendWorkFeedback(feedback: LiveWorkFeedback): Promise<LiveReceiptDelivery> {
      const deliveryId = randomUUID();
      if (!context.workProfile || feedback.callId !== context.callId || !configured || !socket || socket.readyState !== WebSocket.OPEN) {
        return { status: "not-sent", deliveryId, code: "LIVE_WORK_FEEDBACK_UNDELIVERED" };
      }
      try {
        for (const message of realtimeWorkFeedbackMessages(feedback)) await sendJsonConfirmed(socket, message, context.signal);
        return { status: "sent", deliveryId };
      } catch {
        return { status: "not-sent", deliveryId, code: "LIVE_WORK_FEEDBACK_UNDELIVERED" };
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      createdReject?.(new Error("Realtime call closed"));
      updatedReject?.(new Error("Realtime call closed"));
      responseTracker.clear();
      settledFunctionCalls.clear();
      socket?.off("message", onSocketMessage);
      socket?.off("close", onSocketFailure);
      socket?.off("error", onSocketFailure);
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, "call ended");
      socket = null;
    },
  };
}
