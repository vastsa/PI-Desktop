import {
  IPC,
  type AgentPromptRequest,
  type AgentQueuePushRequest,
  type AgentStatus,
  type SessionSource,
} from "@pi-desktop/shared";
import type { AgentSidecar } from "../agent-sidecar";
import type { AgentHostBridge } from "../agent-host-bridge";
import { DESKTOP_PRINCIPAL } from "../agent-host-bridge";
import type { BackendRouter, RemoteBackend } from "../remote/backend-router";
import type { RemoteHostsBoot } from "../bootstrap/remote-hosts";
import type { LiveWorkAdmission, LiveWorkPort, WorkSnapshot } from "@pi-desktop/host-runtime";

export type LiveWorkSessionRecord = {
  id: string;
  source: SessionSource;
  title: string;
  projectId?: string;
  projectPath?: string;
  workspaceLabel?: string;
  hostLabel?: string;
  providerId?: string;
  modelId?: string;
  mode: "agent" | "plan" | "goal";
  permissionMode?: string;
  activeTurnId?: string;
  status?: string;
  canPrompt?: boolean;
  canStop?: boolean;
  readOnlyReason?: string;
};

type HostRpc = { call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> };
type SidecarRpc = Pick<AgentSidecar, "call" | "onNotification">;
type LiveVoiceRemoteHosts = Pick<RemoteHostsBoot, "listSessions" | "subscribeSession">;

export type LiveWorkBackendPortOptions = {
  getHost: () => HostRpc | null;
  getSidecar: () => SidecarRpc | null;
  getAgentHostBridge: () => AgentHostBridge | null;
  getBackendRouter: () => BackendRouter | null;
  getRemoteHosts: () => LiveVoiceRemoteHosts | null;
  requireSelectedSession: (sessionId: string, callId?: string) => Promise<LiveWorkSessionRecord>;
  requireCallScope: (callId: string, sessionId: string) => { workspaceIdentity: string | null };
  observeTurnTarget: (sessionId: string) => string | null;
};

export async function listLiveWorkSessions(input: {
  getHost: () => HostRpc | null;
  getSidecar: () => SidecarRpc | null;
  getRemoteHosts: () => LiveVoiceRemoteHosts | null;
}): Promise<LiveWorkSessionRecord[]> {
  const host = input.getHost();
  if (!host) throw Object.assign(new Error("Local Host is unavailable"), { errorCode: "LIVE_WORK_NOT_READY" });
  const sidecar = input.getSidecar();
  const remoteHosts = input.getRemoteHosts();
  const [desktopResult, nativeResult, remoteResult] = await Promise.all([
    host.call<{ sessions?: Array<Record<string, unknown>> }>("session.list"),
    sidecar
      ? sidecar.call<{ sessions?: Array<Record<string, unknown>> }>("native.session.list")
      : Promise.resolve({ sessions: [] as Array<Record<string, unknown>> }),
    remoteHosts ? remoteHosts.listSessions() : Promise.resolve([]),
  ]);
  const desktop: LiveWorkSessionRecord[] = (desktopResult.sessions ?? []).flatMap((session) => {
    if (typeof session.id !== "string" || !session.id.trim() || (session.source !== undefined && session.source !== "desktop")) return [];
    return [{
      id: session.id,
      source: "desktop",
      title: typeof session.title === "string" ? session.title : "",
      ...(typeof session.projectId === "string" ? { projectId: session.projectId } : {}),
      ...(typeof session.projectPath === "string" ? { projectPath: session.projectPath } : {}),
      ...(typeof session.providerId === "string" ? { providerId: session.providerId } : {}),
      ...(typeof session.modelId === "string" ? { modelId: session.modelId } : {}),
      mode: session.mode === "plan" || session.mode === "goal" ? session.mode : "agent",
      ...(typeof session.permissionMode === "string" ? { permissionMode: session.permissionMode } : {}),
    }];
  });
  const native: LiveWorkSessionRecord[] = (nativeResult.sessions ?? []).flatMap((session) => {
    if (typeof session.id !== "string" || !session.id.startsWith("native-pi:")) return [];
    const capabilities = session.capabilities && typeof session.capabilities === "object"
      ? session.capabilities as Record<string, unknown>
      : {};
    return [{
      id: session.id,
      source: "pi-native",
      title: typeof session.title === "string" ? session.title : "",
      ...(typeof session.projectPath === "string" ? { projectPath: session.projectPath } : {}),
      ...(typeof session.providerId === "string" ? { providerId: session.providerId } : {}),
      ...(typeof session.modelId === "string" ? { modelId: session.modelId } : {}),
      mode: "agent",
      ...(typeof session.permissionMode === "string" ? { permissionMode: session.permissionMode } : {}),
      canPrompt: capabilities.canPrompt === true,
      canStop: capabilities.canStop === true,
      ...(typeof session.readOnlyReason === "string" ? { readOnlyReason: session.readOnlyReason } : {}),
    }];
  });
  const remote: LiveWorkSessionRecord[] = remoteResult.map((session) => ({
    id: session.id,
    source: "remote",
    title: session.title,
    ...(session.workspaceLabel ? { workspaceLabel: session.workspaceLabel } : {}),
    ...(session.hostLabel ? { hostLabel: session.hostLabel } : {}),
    mode: session.mode,
    permissionMode: session.permissionMode,
    activeTurnId: session.activeTurnId,
    status: session.status,
  }));
  return [...desktop, ...native, ...remote].sort((a, b) => b.id.localeCompare(a.id));
}

export function requireLiveWorkSession(sessions: LiveWorkSessionRecord[], sessionId: string): LiveWorkSessionRecord {
  const matches = sessions.filter((session) => session.id === sessionId);
  if (matches.length !== 1) throw workError("LIVE_WORK_SESSION_UNAVAILABLE", "The current work session is unavailable or ambiguous.");
  return matches[0];
}

function workError(code: string, message: string): Error {
  return Object.assign(new Error(message), { errorCode: code });
}

function remoteBackend(router: BackendRouter | null, channel: string, args: readonly unknown[]): RemoteBackend {
  const backend = router?.resolveBackend(channel, args);
  if (!backend) throw workError("LIVE_WORK_SESSION_UNAVAILABLE", "The selected Remote session is offline or unavailable.");
  return backend;
}

function remoteCall(router: BackendRouter | null, channel: string, args: readonly unknown[]): Promise<unknown> {
  return remoteBackend(router, channel, args).invoke(channel, args);
}

function sessionStatus(status: AgentStatus, record: LiveWorkSessionRecord): WorkSnapshot["state"] {
  if (!status.isRunning) return "idle";
  if (status.pendingToolConfirmations > 0 || record.status === "waiting_permission") return "waiting-permission";
  if (record.status === "waiting_input") return "waiting-input";
  return "running";
}

export function createLiveWorkBackendPort(input: LiveWorkBackendPortOptions): Pick<LiveWorkPort,
  "snapshot" | "observeTurnTarget" | "lookupAdmission" | "submit" | "steer" | "enqueue" | "stop" | "cancelQueued"
> {
  const requireHost = (): HostRpc => {
    const host = input.getHost();
    if (!host) throw workError("LIVE_WORK_NOT_READY", "Local Host is unavailable.");
    return host;
  };

  return {
    async snapshot(sessionId) {
      const record = await input.requireSelectedSession(sessionId);
      if (record.source === "desktop") {
        const bridge = input.getAgentHostBridge();
        if (!bridge) throw workError("LIVE_WORK_NOT_READY", "Agent Host is unavailable.");
        const snapshot = await bridge.agentHost.workSnapshot(sessionId);
        return {
          sessionId,
          mode: snapshot.mode,
          state: snapshot.state,
          ...(snapshot.activeTurnId ? { activeTurnId: snapshot.activeTurnId } : {}),
          queue: snapshot.queue.map(({ queueEntryId, position }) => ({ queueEntryId, position, summary: "" })),
          observedAt: Date.now(),
          source: "desktop",
          capabilities: { steer: true, queue: true, cancelQueued: true },
        };
      }
      if (record.source === "pi-native") {
        const sidecar = input.getSidecar();
        if (!sidecar) throw workError("LIVE_WORK_NOT_READY", "Native Pi runtime is unavailable.");
        const result = await sidecar.call<{ status?: AgentStatus }>("agent.getStatus", { sessionId });
        const status = result.status;
        if (!status) throw workError("LIVE_WORK_STATUS_UNKNOWN", "Native Pi status is unavailable.");
        return {
          sessionId,
          mode: record.mode,
          state: sessionStatus(status, record),
          ...(status.currentTurnId ? { activeTurnId: status.currentTurnId } : {}),
          queue: [],
          observedAt: Date.now(),
          source: "pi-native",
          capabilities: { steer: false, queue: false, cancelQueued: false },
        };
      }
      const router = input.getBackendRouter();
      const statusResult = await remoteCall(router, IPC.invoke.agentGetStatus, [sessionId]) as { status?: AgentStatus };
      const status = statusResult.status;
      if (!status) throw workError("LIVE_WORK_STATUS_UNKNOWN", "Remote Host status is unavailable.");
      const queueResult = await remoteCall(router, IPC.invoke.agentQueueList, [{ sessionId }]) as { entries?: Array<{ id?: unknown; position?: unknown }> };
      return {
        sessionId,
        mode: record.mode,
        state: sessionStatus(status, record),
        ...(status.currentTurnId ? { activeTurnId: status.currentTurnId } : {}),
        queue: (queueResult.entries ?? []).flatMap((entry, index) =>
          typeof entry.id === "string"
            ? [{ queueEntryId: entry.id, position: typeof entry.position === "number" ? entry.position : index + 1, summary: "" }]
            : [],
        ),
        observedAt: Date.now(),
        source: "remote",
        capabilities: { steer: false, queue: true, cancelQueued: true },
      };
    },

    observeTurnTarget(sessionId) {
      const record = input.getAgentHostBridge()?.observeWorkTarget(sessionId);
      return record ?? input.observeTurnTarget(sessionId);
    },

    async lookupAdmission(request) {
      const record = await input.requireSelectedSession(request.sessionId, request.callId);
      if (record.source !== "desktop") return { kind: "unavailable", code: "LIVE_WORK_STATUS_UNKNOWN" };
      const bridge = input.getAgentHostBridge();
      if (!bridge) return { kind: "unavailable", code: "LIVE_WORK_NOT_READY" };
      const turn = bridge.lookupWorkAdmission({
        sessionId: request.sessionId,
        idempotencyKey: request.idempotencyKey,
        userMessageId: request.userMessageId,
        voiceOrigin: { callId: request.callId, operationId: request.operationId },
      });
      if (!turn) return { kind: "not-found" };
      if (turn.status === "queued") return { kind: "queued", queueEntryId: turn.id };
      if (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted" || turn.status === "canceled") {
        return { kind: "terminal", turnId: turn.id, status: turn.status };
      }
      if (turn.status === "running" || turn.status === "waiting_approval" || turn.status === "waiting_input") {
        return { kind: "running", turnId: turn.id };
      }
      return { kind: "unavailable", code: "LIVE_WORK_STATUS_UNKNOWN" };
    },

    async submit(request) {
      const scope = input.requireCallScope(request.voiceOrigin.callId, request.sessionId);
      const record = await input.requireSelectedSession(request.sessionId, request.voiceOrigin.callId);
      if (record.mode !== "agent") throw workError("LIVE_WORK_BACKEND_UNSUPPORTED", "Live work is available only in Agent sessions.");
      if (record.source === "desktop") {
        const bridge = input.getAgentHostBridge();
        if (!bridge) throw workError("LIVE_WORK_NOT_READY", "Agent Host is unavailable.");
        const result = await bridge.agentHost.startTurn(DESKTOP_PRINCIPAL, {
          sessionId: request.sessionId,
          expectedWorkspaceIdentity: scope.workspaceIdentity,
          idempotencyKey: request.idempotencyKey,
          input: { text: request.text, userMessageId: request.userMessageId, voiceOrigin: request.voiceOrigin },
          context: { requestId: request.idempotencyKey },
        });
        return result.turn.status === "queued"
          ? { status: "queued", queueEntryId: result.turn.id }
          : { status: "started", turnId: result.turn.id };
      }
      if (record.source === "pi-native") {
        if (record.canPrompt !== true) throw workError("LIVE_WORK_BACKEND_UNSUPPORTED", record.readOnlyReason ?? "This Native Pi session is read-only.");
        const sidecar = input.getSidecar();
        if (!sidecar) throw workError("LIVE_WORK_NOT_READY", "Native Pi runtime is unavailable.");
        const result = await sidecar.call<{ accepted?: unknown; turnId?: unknown }>("agent.prompt", {
          sessionId: request.sessionId,
          content: request.text,
          userMessageId: request.userMessageId,
        });
        if (result.accepted !== true || typeof result.turnId !== "string" || !result.turnId) {
          throw workError("LIVE_WORK_ADMISSION_UNKNOWN", "Native Pi did not confirm the work admission.");
        }
        return { status: "started", turnId: result.turnId };
      }
      const remoteRequest = {
        sessionId: request.sessionId,
        content: request.text,
        messageId: request.userMessageId,
        idempotencyKey: request.idempotencyKey,
        voiceOrigin: request.voiceOrigin,
      } satisfies AgentPromptRequest & { idempotencyKey: string };
      const result = await remoteCall(input.getBackendRouter(), IPC.invoke.agentPrompt, [remoteRequest]) as { accepted?: unknown; turnId?: unknown };
      if (result.accepted !== true || typeof result.turnId !== "string" || !result.turnId) {
        throw workError("LIVE_WORK_ADMISSION_UNKNOWN", "Remote Host did not confirm the work admission.");
      }
      return { status: "started", turnId: result.turnId };
    },

    async steer(request) {
      const record = await input.requireSelectedSession(request.sessionId, request.voiceOrigin.callId);
      if (record.source !== "desktop") return { accepted: false };
      const bridge = input.getAgentHostBridge();
      if (!bridge) throw workError("LIVE_WORK_NOT_READY", "Agent Host is unavailable.");
      return {
        accepted: await bridge.steerWorkSession({
          sessionId: request.sessionId,
          expectedTurnId: request.expectedTurnId,
          content: request.text,
          userMessageId: request.userMessageId,
          voiceOrigin: request.voiceOrigin,
        }),
      };
    },

    async enqueue(request) {
      const scope = input.requireCallScope(request.voiceOrigin.callId, request.sessionId);
      const record = await input.requireSelectedSession(request.sessionId, request.voiceOrigin.callId);
      if (record.source === "pi-native") throw workError("LIVE_WORK_BACKEND_UNSUPPORTED", "Native Pi sessions do not support a Host queue.");
      if (record.source === "desktop") {
        const bridge = input.getAgentHostBridge();
        if (!bridge) throw workError("LIVE_WORK_NOT_READY", "Agent Host is unavailable.");
        const result = await bridge.agentHost.enqueueTurn(DESKTOP_PRINCIPAL, {
          sessionId: request.sessionId,
          expectedWorkspaceIdentity: scope.workspaceIdentity,
          idempotencyKey: request.idempotencyKey,
          input: { text: request.text, userMessageId: request.userMessageId, voiceOrigin: request.voiceOrigin },
          context: { requestId: request.idempotencyKey },
        });
        return { queueEntryId: result.turn.id };
      }
      const remoteRequest: AgentQueuePushRequest = {
        sessionId: request.sessionId,
        content: request.text,
        userMessageId: request.userMessageId,
        voiceOrigin: request.voiceOrigin,
        idempotencyKey: request.idempotencyKey,
      };
      const result = await remoteCall(input.getBackendRouter(), IPC.invoke.agentQueuePush, [remoteRequest]) as { id?: unknown };
      if (typeof result.id !== "string" || !result.id) throw workError("LIVE_WORK_ADMISSION_UNKNOWN", "Remote Host did not confirm its queued item.");
      return { queueEntryId: result.id };
    },

    async stop(request) {
      const record = await input.requireSelectedSession(request.sessionId, request.callId);
      if (record.source === "pi-native") {
        const sidecar = input.getSidecar();
        if (!sidecar) throw workError("LIVE_WORK_NOT_READY", "Native Pi runtime is unavailable.");
        const result = await sidecar.call<{ ok?: unknown }>("agent.abort", { sessionId: request.sessionId, turnId: request.expectedTurnId });
        return result.ok === true
          ? { status: "requested", message: "Native Pi can only interrupt immediately; the selected turn was interrupted." }
          : { status: "stale-target" };
      }
      if (record.source === "desktop") {
        const bridge = input.getAgentHostBridge();
        if (!bridge) return { status: "stale-target" };
        return bridge.stopWorkSession({ sessionId: request.sessionId, expectedTurnId: request.expectedTurnId, urgency: request.urgency });
      }
      const channel = request.urgency === "graceful" ? IPC.invoke.agentStop : IPC.invoke.agentAbort;
      const result = await remoteCall(input.getBackendRouter(), channel, [{ sessionId: request.sessionId, turnId: request.expectedTurnId }]) as { requested?: unknown; aborted?: unknown };
      const accepted = request.urgency === "graceful" ? result.requested === true : result.aborted === true;
      return accepted ? { status: "requested" } : { status: "stale-target" };
    },

    async cancelQueued(request) {
      const record = await input.requireSelectedSession(request.sessionId, request.callId);
      if (record.source === "pi-native") return { status: "unsupported" };
      if (record.source === "desktop") {
        const bridge = input.getAgentHostBridge();
        if (!bridge) return { status: "unknown" };
        if (!bridge.queue.list(request.sessionId).some((entry) => entry.id === request.queueEntryId)) return { status: "already-delivered" };
        try {
          await bridge.queue.remove(request.queueEntryId);
          return { status: "canceled" };
        } catch { return { status: "unknown" }; }
      }
      const result = await remoteCall(input.getBackendRouter(), IPC.invoke.agentQueueRemove, [{ sessionId: request.sessionId, turnId: request.queueEntryId }]) as { ok?: unknown };
      return result.ok === true ? { status: "canceled" } : { status: "unknown" };
    },
  };
}

export function statusSnapshot(input: { sessionId: string; record: LiveWorkSessionRecord; status: AgentStatus; queue?: Array<{ id: string; position: number }> }): WorkSnapshot {
  const state: WorkSnapshot["state"] = !input.status.isRunning
    ? "idle"
    : input.status.pendingToolConfirmations > 0 || input.record.status === "waiting_permission"
      ? "waiting-permission"
      : input.record.status === "waiting_input"
        ? "waiting-input"
        : "running";
  return {
    sessionId: input.sessionId,
    mode: input.record.mode,
    state,
    ...(input.status.currentTurnId ? { activeTurnId: input.status.currentTurnId } : {}),
    queue: (input.queue ?? []).map((entry) => ({ queueEntryId: entry.id, position: entry.position, summary: "" })),
    observedAt: Date.now(),
    source: input.record.source,
    capabilities: {
      steer: input.record.source === "desktop",
      queue: input.record.source !== "pi-native",
      cancelQueued: input.record.source !== "pi-native",
    },
  };
}

export function assertHostReady(host: HostRpc | null): HostRpc {
  return host ?? (() => { throw workError("LIVE_WORK_NOT_READY", "Local Host is unavailable."); })();
}
