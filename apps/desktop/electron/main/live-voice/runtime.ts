import { net, type BrowserWindow, type WebContents } from "electron";
import { IPC, type AppSettings, type LiveCallView } from "@pi-desktop/shared";
import type { VendorOAuth } from "../oauth";
import type { HostProcess } from "../host-process";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { AgentSidecar } from "../agent-sidecar";
import type { BackendRouter } from "../remote/backend-router";
import type { RemoteHostsBoot } from "../bootstrap/remote-hosts";
import { LiveCallService } from "./call-service";
import { LiveAuthResolver } from "./auth-resolver";
import { createLivePcmBridge } from "./audio-port";
import { createCodexAdapter } from "./codex-adapter";
import { createGeminiAdapter } from "./gemini-adapter";
import { createOpenAIRealtimeAdapter } from "./openai-realtime-adapter";
import { liveOwnerFrame } from "./owner";
import { assertLiveHttpsEndpoint } from "./websocket-transport";
import type { MicrophoneLeaseRegistry } from "./microphone-lease";
import type { LiveOwner } from "./call-service";
import { createLiveWorkBridge } from "./work-bridge";
import { listLiveWorkSessions, requireLiveWorkSession, type LiveWorkSessionRecord } from "./live-work-backend-port";
import type { ThinkingLevel } from "@pi-desktop/shared";
import { liveWorkUnselectedSessionId, sessionWorkspaceIdentity } from "@pi-desktop/host-runtime";

type BackgroundLease = { webContents: WebContents; previous: boolean; count: number };

export function createLiveCallService(input: {
  getHost: () => HostProcess | null;
  getMainWindow: () => BrowserWindow | null;
  getAgentHostBridge: () => AgentHostBridge | null;
  getSidecar?: () => AgentSidecar | null;
  getBackendRouter?: () => BackendRouter | null;
  getRemoteHosts?: () => RemoteHostsBoot | null;
  vendorOAuth: Pick<VendorOAuth, "resolveAuth">;
  /**
   * Every published call view, for chrome outside the owner frame — the docked
   * Live Voice widget window. The owner frame keeps receiving the same view
   * through `IPC.event.liveVoiceChanged`.
   */
  onCallView?: (view: LiveCallView | null) => void;
  microphoneLeases: MicrophoneLeaseRegistry;
  resolveAgentRuntimeLaunch: (
    sessionId: string,
    session: Record<string, unknown>,
    settings: unknown,
    overrides: { providerId?: string; modelId?: string; thinkingLevel?: ThinkingLevel },
  ) => Promise<{
    providerId: string;
    sidecarParams: { provider: import("@pi-desktop/agent-runtime").RuntimeProviderConfig };
  }>;
  /** Terminal call failures land in the `provider` log channel (see spec 09). */
  log?: (level: "warn" | "error", message: string, data: Record<string, unknown>) => void;
}): LiveCallService {
  const backgroundLeases = new Map<number, BackgroundLease>();
  const authorizedWorkspaces = new WeakMap<object, string | null>();
  const authResolver = new LiveAuthResolver({
    callHost: <T,>(method: string, params?: unknown): Promise<T> => {
      const host = input.getHost();
      if (!host) return Promise.reject(Object.assign(new Error("host unavailable"), { errorCode: "LIVE_PROVIDER_NOT_FOUND" }));
      return host.call<T>(method, params);
    },
    vendorOAuth: input.vendorOAuth,
  });

  let liveCallService: LiveCallService | null = null;
  const workBridge = createLiveWorkBridge({
    getHost: input.getHost,
    getAgentHostBridge: input.getAgentHostBridge,
    getSidecar: input.getSidecar ?? (() => null),
    getBackendRouter: input.getBackendRouter ?? (() => null),
    getRemoteHosts: input.getRemoteHosts ?? (() => null),
    vendorOAuth: input.vendorOAuth,
    navigateSession: (callId, sessionId) => {
      if (!liveCallService) return Promise.reject(Object.assign(new Error("Live call service is unavailable"), { errorCode: "LIVE_WORK_NOT_READY" }));
      return liveCallService.navigateWorkSession(callId, sessionId);
    },
    resolveAgentRuntimeLaunch: input.resolveAgentRuntimeLaunch,
    onOperation: (callId, update) => {
      const operation = update.operation;
      liveCallService?.notifyWorkOperation(callId, {
        operationId: operation.operationId,
        ...(operation.workSessionId ? { workSessionId: operation.workSessionId } : {}),
        ...(operation.workSessionLabel ? { workSessionLabel: operation.workSessionLabel } : {}),
        ...(operation.workSessionSource ? { sessionSource: operation.workSessionSource } : {}),
        admission: operation.admission,
        execution: operation.execution,
        ...(operation.failureCode ? { failureCode: operation.failureCode } : {}),
        ...(operation.turnId ? { turnId: operation.turnId } : {}),
        ...(operation.targetTurnId ? { targetTurnId: operation.targetTurnId } : {}),
        ...(operation.queueEntryId ? { queueEntryId: operation.queueEntryId } : {}),
        ...(operation.summary ? { summary: operation.summary } : {}),
        ...(operation.resultSummary ? { resultSummary: operation.resultSummary } : {}),
        ...(operation.resultState ? { resultState: operation.resultState } : {}),
        ...(operation.selections ? { selections: operation.selections } : {}),
      }, operation.providerRequestId, operation.resultSummary, update.intent, update.pendingQuestion);
    },
    getWorkContextConsent: (callId) => liveCallService?.getWorkContextConsent(callId) ?? false,
    onTargetSelected: (callId, binding) => liveCallService?.setWorkTarget(callId, binding),
    onAnnouncementPolicy: ({ callId, policy }) => liveCallService?.setWorkAnnouncementPolicy(callId, policy),
  });

  liveCallService = new LiveCallService({
    loadSettings: async () => {
      const host = input.getHost();
      if (!host) throw Object.assign(new Error("host unavailable"), { errorCode: "LIVE_PROVIDER_NOT_FOUND" });
      return host.call<AppSettings>("settings.get");
    },
    authResolver,
    log: input.log,
    resolveWorkBinding: async (target) => {
      const sessions = await listLiveWorkSessions({
        getHost: input.getHost,
        getSidecar: input.getSidecar ?? (() => null),
        getRemoteHosts: input.getRemoteHosts ?? (() => null),
      });
      const session = requireLiveWorkSession(sessions, target.workSessionId);
      const binding = {
        workSessionId: session.id,
        workBindingRevision: 1,
        label: formatWorkSessionLabel(session),
        sessionSource: session.source,
        contextEnabled: target.contextEnabled,
      };
      authorizedWorkspaces.set(binding, session.source === "desktop" ? sessionWorkspaceIdentity(session) : null);
      return binding;
    },
    openWorkScope: (callId, binding) => {
      const initial = binding ?? {
        workSessionId: liveWorkUnselectedSessionId(callId),
        workBindingRevision: 1,
        label: "",
        contextEnabled: false,
      };
      workBridge.openCall(
        { ...initial, callId },
        binding ? authorizedWorkspaces.get(binding) ?? null : null,
      );
    },
    closeWorkScope: workBridge.closeCall,
    resolveWorkSelection: workBridge.resolveSelection,
    stopWorkOperation: workBridge.stopOperation,
    cancelQueuedWorkOperation: workBridge.cancelQueuedOperation,
    receiveWorkCandidate: workBridge.receiveCandidate,
    createAdapter: (context) => {
      switch (context.binding.adapterId) {
        case "codex-live":
          return createCodexAdapter(context, {
            fetchImpl: (url, init) => net.fetch(url instanceof URL ? url.toString() : url, init),
            assertEndpoint: (url) => assertLiveHttpsEndpoint(url, "third-party"),
          });
        case "gemini-live":
          return createGeminiAdapter(context);
        case "openai-realtime":
          return createOpenAIRealtimeAdapter(context);
      }
    },
    createPcmBridge: (bridgeInput) => {
      const frame = liveOwnerFrame(input.getMainWindow(), bridgeInput.owner);
      if (!frame) throw Object.assign(new Error("Live Voice owner frame is unavailable"), { errorCode: "LIVE_INVALID_OWNER" });
      return createLivePcmBridge({
        ...bridgeInput,
        ownerFrame: frame,
      });
    },
    sendView: (owner, view) => {
      sendToOwner(input.getMainWindow(), owner, IPC.event.liveVoiceChanged, view);
      input.onCallView?.(view);
    },
    sendControl: (owner, event) => sendToOwner(input.getMainWindow(), owner, IPC.event.liveVoiceControl, event),
    sendTranscript: (owner, event) => sendToOwner(input.getMainWindow(), owner, IPC.event.liveVoiceTranscript, event),
    ownerAlive: (owner) => liveOwnerFrame(input.getMainWindow(), owner) !== null,
    acquireMicrophone: (callId) => input.microphoneLeases.acquire("live", callId),
    acquireBackgroundThrottlingLease: (callId) => acquireBackgroundLease(input.getMainWindow(), callId, backgroundLeases),
  });
  return liveCallService;
}

function formatWorkSessionLabel(session: LiveWorkSessionRecord): string {
  const title = session.title.trim().slice(0, 100) || "Untitled session";
  const project = session.projectPath?.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0, 60);
  const source = session.source === "pi-native"
    ? "Native Pi"
    : session.source === "remote"
      ? `Remote${session.hostLabel ? ` · ${session.hostLabel}` : ""}`
      : "";
  const workspace = session.source === "remote" ? session.workspaceLabel : project;
  return [source, workspace, title].filter(Boolean).join(" / ").slice(0, 180);
}

function sendToOwner(window: BrowserWindow | null, owner: LiveOwner, channel: string, payload: unknown): void {
  const frame = liveOwnerFrame(window, owner);
  if (!frame || !window || window.isDestroyed()) return;
  frame.send(channel, payload);
}

function acquireBackgroundLease(
  window: BrowserWindow | null,
  _callId: string,
  leases: Map<number, BackgroundLease>,
): () => void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    throw Object.assign(new Error("Live Voice owner window is unavailable"), { errorCode: "LIVE_INVALID_OWNER" });
  }
  const contents = window.webContents;
  let lease = leases.get(contents.id);
  if (!lease) {
    const previous = contents.getBackgroundThrottling();
    lease = { webContents: contents, previous, count: 0 };
    leases.set(contents.id, lease);
    contents.setBackgroundThrottling(false);
  }
  lease.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = leases.get(contents.id);
    if (current !== lease) return;
    current.count -= 1;
    if (current.count > 0) return;
    leases.delete(contents.id);
    if (!contents.isDestroyed()) contents.setBackgroundThrottling(current.previous);
  };
}
