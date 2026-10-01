import type { LiveBinding, LiveEndReason, LivePlaybackCursor, LiveProviderReceipt, LiveRealtimeWireProfile } from "@pi-desktop/shared";
import type { LiveWorkFeedback } from "@pi-desktop/shared";
import type { ProviderPublic } from "@pi-desktop/shared";
import type { ModelAuth } from "@earendil-works/pi-ai";
import type { LiveWireEvent } from "@pi-desktop/voice-runtime/live";

export type LiveResolvedProvider = {
  provider: ProviderPublic;
  secret?: string;
};

export type LiveResolvedAuth =
  | { kind: "codex-oauth"; accessToken: string; accountId: string }
  | { kind: "api-key"; apiKey: string; baseUrl: string };

export type LiveReceiptDelivery =
  | { status: "sent"; deliveryId: string }
  | { status: "not-sent" | "unknown"; deliveryId: string; code: string };

export type LiveAdapterContext = {
  callId: string;
  binding: Readonly<LiveBinding>;
  provider: ProviderPublic;
  auth: LiveResolvedAuth;
  signal: AbortSignal;
  onEvent: (event: LiveWireEvent) => void;
  workProfile?: { version: 1; instructions: string; startupContext: string };
  onWorkCandidate?: (
    candidate: { providerRequestId: string; toolName: string; arguments: unknown },
    deliverReceipt: (receipt: LiveProviderReceipt) => Promise<LiveReceiptDelivery>,
  ) => Promise<void>;
};

export type { LivePlaybackCursor } from "@pi-desktop/shared";

export type LiveAdapter = {
  readonly adapterId: LiveBinding["adapterId"];
  readonly mediaKind: "webrtc" | "pcm";
  connect(input?: { offerSdp?: string }): Promise<{ answerSdp?: string }>;
  sendInputPcm?(bytes: Uint8Array): void;
  setInputMuted?(muted: boolean): Promise<void>;
  interrupt?(cursors?: LivePlaybackCursor[]): Promise<void>;
  appendWorkFeedback?(feedback: LiveWorkFeedback): Promise<LiveReceiptDelivery>;
  rejectDelegation?(input: { callId: string; delegationId: string }): Promise<void>;
  close(reason: LiveEndReason): Promise<void>;
};

export type LiveAdapterFactory = (context: LiveAdapterContext) => LiveAdapter;

export type LiveProviderDescriptor = {
  auth: LiveResolvedAuth;
  provider: ProviderPublic;
};

export type CodexModelAuth = ModelAuth;
export type LiveBindingProfile = LiveRealtimeWireProfile;
