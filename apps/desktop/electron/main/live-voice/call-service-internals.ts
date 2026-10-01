import type {
  AppSettings,
  LiveBinding,
  LiveCallView,
  LiveEndReason,
  LivePhase,
  LivePlaybackCursor,
  LivePrepareRequest,
  LiveWorkBinding,
  LiveWorkOperationView,
  LiveWorkFeedback,
  LiveProviderReceipt,
  LiveVoiceSettings,
  LiveWorkCancelQueuedOperationResult,
  LiveWorkStopOperationResult,
} from "@pi-desktop/shared";
import { validateLiveVoiceSettings } from "@pi-desktop/shared";
import type { LiveWorkFeedbackScheduler } from "@pi-desktop/host-runtime";
import type { LivePcmBridge } from "./audio-port";
import type { LiveAdapter, LiveAdapterContext, LiveReceiptDelivery } from "./types";

export type LiveOwner = {
  webContentsId: number;
  frameProcessId: number;
  frameRoutingId: number;
  url: string;
};

export type LiveCallServiceDeps = {
  loadSettings: () => Promise<AppSettings>;
  authResolver: import("./auth-resolver").LiveAuthResolver;
  createAdapter: (context: LiveAdapterContext) => LiveAdapter;
  createPcmBridge: (input: {
    callId: string;
    owner: LiveOwner;
    inputSampleRate: 16000 | 24000;
    outputSampleRate: 24000;
    onInput: (bytes: Uint8Array, captureEpoch: number) => void;
    onPlaybackPosition: (cursors: LivePlaybackCursor[]) => void;
    onPlaybackStateChanged: () => void;
    onReleased: () => void;
    onFailure: (code: string) => void;
  }) => LivePcmBridge;
  sendView: (owner: LiveOwner, view: LiveCallView) => void;
  sendControl: (owner: LiveOwner, event: import("@pi-desktop/shared").LiveControlEvent) => void;
  sendTranscript: (owner: LiveOwner, event: import("@pi-desktop/shared").LiveTranscriptEvent) => void;
  ownerAlive: (owner: LiveOwner) => boolean;
  acquireMicrophone: (callId: string) => () => void;
  acquireBackgroundThrottlingLease?: (callId: string) => () => void;
  now?: () => number;
  scheduleWorkFeedbackWake?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  resolveWorkBinding?: (target: NonNullable<LivePrepareRequest["workTarget"]> & { contextEnabled: boolean }) => Promise<LiveWorkBinding>;
  openWorkScope?: (callId: string, binding?: LiveWorkBinding) => void;
  closeWorkScope?: (callId: string) => void;
  resolveWorkSelection?: (input: { callId: string; workBindingRevision: number; selectionRef: string }) => Promise<
    | { kind: "session"; sessionId: string }
    | { kind: "project"; projectPath: string }
  >;
  receiveWorkCandidate?: (
    candidate: { callId: string; workBindingRevision: number; workSessionId: string; providerRequestId: string; instruction: string },
    deliverReceipt: (receipt: LiveProviderReceipt) => Promise<LiveReceiptDelivery>,
  ) => Promise<void>;
  stopWorkOperation?: (input: { callId: string; operationId: string }) => Promise<LiveWorkStopOperationResult>;
  cancelQueuedWorkOperation?: (input: { callId: string; operationId: string }) => Promise<LiveWorkCancelQueuedOperationResult>;
  onWorkOperation?: (callId: string, operation: LiveWorkOperationView, delegationId?: string) => void;
  /**
   * Optional Main-side sink for terminal call failures. Nothing under
   * live-voice/ used to log, and IPC errors were only returned to the
   * renderer, so a collapsed generic toast could never be traced back to
   * the error code that produced it.
   */
  log?: (level: "warn" | "error", message: string, data: Record<string, unknown>) => void;
};

export type Slot = {
  callId: string;
  requestId: string;
  requestedBindingId: string;
  owner: LiveOwner;
  binding: LiveBinding | null;
  settingsRevision: number;
  phase: LivePhase;
  revision: number;
  abort: AbortController;
  desiredMuted: boolean;
  muted: boolean;
  captureEpoch: number;
  playbackEpoch: number;
  microphoneActive: boolean;
  mediaRelease: "pending" | "confirmed" | "unconfirmed";
  mediaReleased: Promise<void>;
  resolveMediaReleased: (() => void) | null;
  connectedAt?: string;
  playbackBlocked?: boolean;
  userSpeaking: boolean;
  assistantSpeaking: boolean;
  assistantPlaybackActive: boolean;
  playbackMonitorReady: boolean;
  error?: { code: string; stage?: string; retriable: boolean };
  notice?: { code: string; retriable: boolean };
  workBinding?: LiveWorkBinding;
  workBindingRevision: number;
  workContextConsent: boolean;
  workScopeOpened: boolean;
  workOperations: LiveWorkOperationView[];
  workFeedbackScheduler: LiveWorkFeedbackScheduler;
  workFeedbackTargets: Map<string, string>;
  workFeedbackStatuses: Map<string, "pending" | "sent" | "context-only" | "undelivered">;
  workFeedbackTerminalOperations: Map<string, Set<string>>;
  workFeedbackTerminalStatuses: Map<string, "pending" | "sent" | "context-only" | "undelivered">;
  workFeedbackTimer?: ReturnType<typeof setTimeout>;
  adapter: LiveAdapter | null;
  bridge: LivePcmBridge | null;
  releaseMicrophone: (() => void) | null;
  releaseBackgroundLease: (() => void) | null;
  heartbeatAt: number;
  maxDurationTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setTimeout>;
  reservationTimer?: ReturnType<typeof setTimeout>;
  connectPromise?: Promise<{ answerSdp?: string; revision: number }>;
  connectFingerprint?: string;
  delegationInstructions: Map<string, string>;
  pendingControls: Map<string, {
    timer: ReturnType<typeof setTimeout>;
    kind: "reject" | "work-receipt" | "work-navigation" | "work-feedback";
    resolve?: (delivery: LiveReceiptDelivery) => void;
  }>;
  transcriptLengths: Map<string, number>;
};

export type RequestEntry = { fingerprint: string; promise: Promise<import("@pi-desktop/shared").LivePreparedCall> };
export type SettingsSnapshot = { value: LiveVoiceSettings; fingerprint: string; revision: number; invalid: boolean };

export const MAX_CALLS_PER_OWNER_REQUEST_CACHE = 64;
export const MAX_DELEGATIONS_PER_CALL = 256;
export const MAX_TRANSCRIPT_SEGMENTS = 200;
export const MAX_TRANSCRIPT_BYTES = 64 * 1024;
export const MAX_INSTRUCTION_BYTES = 8 * 1024;
export const PREPARE_DEADLINE_MS = 5_000;
export const RESERVATION_TIMEOUT_MS = 60_000;
export const AUTH_TIMEOUT_MS = 15_000;
export const CONNECT_TIMEOUT_MS = 15_000;
export const TOTAL_CONNECT_TIMEOUT_MS = 40_000;
export const OWNER_LEASE_MS = 20_000;
export const OWNER_HEARTBEAT_MS = 5_000;
export const MAX_CALL_MS = 30 * 60_000;
export const REJECTION_ACK_TIMEOUT_MS = 1_000;

export function validatePrepareRequest(request: LivePrepareRequest): void {
  if (!request || typeof request !== "object" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.requestId) || typeof request.bindingId !== "string" || request.bindingId.length > 256 || !Number.isSafeInteger(request.expectedSettingsRevision) || typeof request.initialMuted !== "boolean") {
    throw liveError("LIVE_PROTOCOL_ERROR");
  }
  if (request.shareSelectedSessionContext !== undefined && typeof request.shareSelectedSessionContext !== "boolean") throw liveError("LIVE_PROTOCOL_ERROR");
  if (request.workTarget !== undefined && (
    !request.workTarget || typeof request.workTarget.workSessionId !== "string" ||
    !request.workTarget.workSessionId.trim() || request.workTarget.workSessionId.length > 256
  )) throw liveError("LIVE_PROTOCOL_ERROR");
}

export function liveError(code: string): Error {
  return Object.assign(new Error(code), { errorCode: code });
}

export function ownerKey(owner: LiveOwner): string {
  return `${owner.webContentsId}:${owner.frameProcessId}:${owner.frameRoutingId}`;
}

export function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

export function liveVoiceFromSettings(settings: unknown): { value: LiveVoiceSettings; invalid: boolean } {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { value: { enabled: false, bindings: [] }, invalid: true };
  const raw = (settings as { liveVoice?: unknown }).liveVoice;
  if (raw === undefined) return { value: { enabled: false, bindings: [] }, invalid: false };
  try {
    return { value: validateLiveVoiceSettings(raw), invalid: false };
  } catch {
    return { value: { enabled: false, bindings: [] }, invalid: true };
  }
}

export function transition(slot: Slot, next: LivePhase): void {
  const allowed: Record<LivePhase, readonly LivePhase[]> = {
    idle: ["preparing"],
    preparing: ["acquiring-mic", "closing", "failed"],
    "acquiring-mic": ["negotiating", "connecting", "closing", "failed"],
    negotiating: ["connecting", "closing", "failed"],
    connecting: ["connected", "closing", "failed"],
    connected: ["reconnecting", "closing", "failed"],
    reconnecting: ["connected", "closing", "failed"],
    closing: ["ended", "failed"],
    ended: [],
    failed: [],
  };
  if (slot.phase !== next && !allowed[slot.phase].includes(next)) {
    throw Object.assign(new Error("Live call state transition is invalid"), { errorCode: "LIVE_PROTOCOL_ERROR" });
  }
  slot.phase = next;
}

export function errorCode(error: unknown, fallback = "LIVE_NETWORK_ERROR"): { code: string; retriable: boolean } {
  const value = error && typeof error === "object" ? error as { errorCode?: unknown; retriable?: unknown } : null;
  const allowed = new Set<string>([
    "LIVE_DISABLED", "LIVE_NOT_CONFIGURED", "LIVE_PROVIDER_NOT_FOUND", "LIVE_AUTH_KIND_UNSUPPORTED", "LIVE_AUTH_REQUIRED",
    "LIVE_ACCOUNT_ID_MISSING", "LIVE_ACCESS_DENIED", "LIVE_RATE_LIMITED", "LIVE_PROTOCOL_UNSUPPORTED", "LIVE_PROTOCOL_ERROR",
    "LIVE_ALREADY_ACTIVE", "LIVE_REQUEST_CONFLICT", "LIVE_SETTINGS_IN_USE", "LIVE_MEDIA_RELEASE_UNCONFIRMED", "LIVE_STALE_CALL",
    "LIVE_INVALID_OWNER", "LIVE_MICROPHONE_BUSY", "LIVE_MICROPHONE_DENIED", "LIVE_MICROPHONE_UNAVAILABLE", "LIVE_MEDIA_UNSUPPORTED",
    "LIVE_PLAYBACK_BLOCKED", "LIVE_TIMEOUT", "LIVE_NETWORK_ERROR", "LIVE_NETWORK_POLICY_UNSUPPORTED", "LIVE_AUDIO_BACKPRESSURE",
    "LIVE_EXECUTION_NOT_CONNECTED",
    "LIVE_WORK_NOT_BOUND", "LIVE_WORK_NOT_READY", "LIVE_WORK_SESSION_UNAVAILABLE", "LIVE_WORK_BACKEND_UNSUPPORTED",
    "LIVE_WORK_CAPABILITY_UNAVAILABLE", "LIVE_WORK_TARGET_STALE", "LIVE_WORK_INTENT_UNAVAILABLE",
    "LIVE_WORK_CLARIFICATION_REQUIRED", "LIVE_WORK_REQUEST_CONFLICT", "LIVE_WORK_CAPACITY_EXCEEDED",
    "LIVE_WORK_ADMISSION_UNKNOWN", "LIVE_WORK_PERMISSION_REQUIRED", "LIVE_WORK_SELECTION_EXPIRED",
    "LIVE_WORK_REBIND_REQUIRES_RECONNECT", "LIVE_WORK_FEEDBACK_UNDELIVERED",
  ]);
  const code = typeof value?.errorCode === "string" && allowed.has(value.errorCode) ? value.errorCode : fallback;
  return { code, retriable: typeof value?.retriable === "boolean" ? value.retriable : ["LIVE_TIMEOUT", "LIVE_NETWORK_ERROR", "LIVE_RATE_LIMITED"].includes(code) };
}
