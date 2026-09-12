import { basename } from "node:path";

import {
  AgentHost,
  RacpError,
  type ApprovalPort,
  type PendingToolRequest,
  type Principal,
  type QueueEntryView,
  type QueueStore,
  type QueuedTurnRecord,
  type RuntimePort,
  type SessionPort,
  type SessionSummary,
  type TurnStartRequest,
} from "@pi-desktop/agent-host";
import type {
  AgentEventEnvelope,
  AgentQueueChangedEvent,
  AgentQueuePushRequest,
  AskToolResolution,
  QueuedTurnSummary,
  RacpApprovalResult,
  RacpItemSummary,
  RacpPermissionMode,
  UiMessage,
} from "@pi-desktop/shared";
import { IPC, isGlobalPermissionMode } from "@pi-desktop/shared";

type IpcInvoke = (channel: string, args: readonly unknown[]) => Promise<unknown>;

type HostLike = {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

export type AgentHostBridgeOptions = {
  invoke: IpcInvoke;
  channels: typeof IPC.invoke;
  getHost: () => HostLike | null;
  /** Runtime-side busy state the event stream cannot see (active turn map,
   * manual compaction). */
  isSessionBusy?: (sessionId: string) => boolean;
  /** Renderer fan-out for queue changes (`agent/event/queueChanged`). */
  onQueueChange?: (event: AgentQueueChangedEvent) => void;
  log: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

/** The local desktop: the SSH-paired owner device of its own Host. */
export const DESKTOP_PRINCIPAL: Principal = {
  subject: "desktop",
  roles: ["owner"],
  pairedDevice: true,
};

type HostSessionRecord = {
  id: string;
  title?: string;
  projectId?: string;
  projectPath?: string;
  mode?: string;
  permissionMode?: string;
  planningState?: string;
  createdAt?: string;
  updatedAt?: string;
  messages?: UiMessage[];
};

/**
 * Electron Main's adapter around the headless Agent Host module (rollout R1,
 * D374/D375). The module wraps the existing registered IPC handlers through
 * `invokeIpc` rather than the renderer, `host.proxy`, or host-core RPC, so the
 * local permission and persistence behavior is reused unchanged. Later steps
 * move handler logic into the module; the wire contract does not change.
 */
export function createAgentHostBridge(options: AgentHostBridgeOptions) {
  const abortingSessions = new Set<string>();
  const resolvingViaModule = new Set<string>();

  const requireHost = (): HostLike => {
    const host = options.getHost();
    if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host is not running", { retriable: true });
    return host;
  };

  const runtime: RuntimePort = {
    async prompt(request: TurnStartRequest) {
      const summary = await sessions.get(request.sessionId);
      if (summary && summary.permissionMode !== request.effectivePermissionMode) {
        // The local prompt path runs under the session's durable permission
        // mode. A per-turn ceiling needs runtime support that lands with the
        // RACP-WS binding; until then a capped turn fails closed.
        throw new RacpError(
          "FORBIDDEN",
          "the local runtime cannot apply a per-turn permission ceiling yet",
          { details: { effectivePermissionMode: request.effectivePermissionMode } },
        );
      }
      const result = (await options.invoke(options.channels.agentPrompt, [
        {
          sessionId: request.sessionId,
          content: request.content,
          ...(request.attachments ? { attachments: request.attachments } : {}),
        },
      ])) as { accepted?: boolean; turnId: string };
      return { turnId: result.turnId };
    },
    async stop(sessionId: string) {
      const result = (await options.invoke(options.channels.agentStop, [{ sessionId }])) as
        | { requested?: boolean }
        | undefined;
      return { requested: result?.requested ?? true };
    },
    async abort(sessionId: string) {
      abortingSessions.add(sessionId);
      try {
        await options.invoke(options.channels.agentAbort, [{ sessionId }]);
      } catch (error) {
        abortingSessions.delete(sessionId);
        throw error;
      }
    },
    async respondInput(resolution: AskToolResolution) {
      await options.invoke(options.channels.askToolResolve, [resolution]);
    },
    isBusy(sessionId: string) {
      return options.isSessionBusy?.(sessionId) ?? false;
    },
  };

  const approvals: ApprovalPort = {
    async resolveTool(requestId, decision) {
      resolvingViaModule.add(requestId);
      try {
        await options.invoke(options.channels.toolResolvePermission, [{ requestId, decision }]);
      } finally {
        resolvingViaModule.delete(requestId);
      }
    },
    async resolveContract(input) {
      // The plans.resolve handler needs the submitting turn and tool call,
      // which only the host's pending proposal row carries.
      const host = requireHost();
      const pending = await host.call<{ plans?: Array<{ id: string; turnId?: string; toolCallId?: string }> }>(
        "plans.pending",
        { sessionId: input.sessionId },
      );
      const proposal = (pending.plans ?? []).find((candidate) => candidate.id === input.proposalId);
      if (!proposal) throw new RacpError("NOT_FOUND", `proposal ${input.proposalId} is not pending`);
      resolvingViaModule.add(input.proposalId);
      try {
        await options.invoke(options.channels.plansResolve, [
          {
            proposalId: input.proposalId,
            sessionId: input.sessionId,
            turnId: proposal.turnId ?? "",
            toolCallId: proposal.toolCallId ?? "",
            action: input.action,
            ...(input.version !== undefined ? { version: input.version } : {}),
            ...(input.permissionMode ? { targetPermissionMode: input.permissionMode } : {}),
          },
        ]);
      } finally {
        resolvingViaModule.delete(input.proposalId);
      }
    },
    async listPendingTools(sessionId) {
      const host = options.getHost();
      if (!host) return [];
      const result = await host.call<{ requests?: PendingToolRequest[] }>("permissions.pending", {
        ...(sessionId ? { sessionId } : {}),
      });
      return result.requests ?? [];
    },
  };

  const sessions: SessionPort = {
    async get(sessionId) {
      const record = await fetchSession(sessionId);
      return record ? toSummary(record) : null;
    },
    async history(sessionId, { limit, beforeItemId }) {
      const record = await fetchSession(sessionId);
      const messages = record?.messages ?? [];
      const end = beforeItemId ? messages.findIndex((message) => message.id === beforeItemId) : messages.length;
      const cut = end === -1 ? messages.length : end;
      const start = Math.max(0, cut - limit);
      return {
        items: messages.slice(start, cut).map(toItem),
        hasMore: start > 0,
      };
    },
  };

  async function fetchSession(sessionId: string): Promise<HostSessionRecord | null> {
    const host = options.getHost();
    if (!host) return null;
    const result = await host.call<{ session?: HostSessionRecord | null }>("session.get", { id: sessionId });
    return result.session ?? null;
  }

  /** The Host-owned turn queue persisted by host-core (schema v15, ADR 0213). */
  const queueStore: QueueStore = {
    async listAll() {
      const host = options.getHost();
      if (!host) return [];
      const result = await host.call<{ entries?: HostQueueEntry[] }>("session.queueList", {});
      return (result.entries ?? []).map(fromHostQueueEntry);
    },
    async push(record) {
      await requireHost().call("session.queuePush", {
        id: record.id,
        sessionId: record.sessionId,
        principal: record.principalSubject,
        ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
        inputHash: record.inputHash,
        content: record.content,
        ...(record.attachments ? { attachments: record.attachments } : {}),
        permissionMode: record.effectivePermissionMode,
      });
    },
    async remove(id) {
      const result = await requireHost().call<{ removed?: boolean }>("session.queueRemove", { id });
      return result.removed === true;
    },
    async prioritize(id) {
      await requireHost().call("session.queuePrioritize", { id });
    },
  };

  const agentHost = new AgentHost({
    runtime,
    sessions,
    approvals,
    queueStore,
    onQueueChange: (sessionId, entries) => {
      options.onQueueChange?.({ sessionId, entries: entries.map(toQueueSummary) });
    },
  });

  /** The desktop's queue operations, all under the owner principal. */
  const queue = {
    async push(request: AgentQueuePushRequest): Promise<QueuedTurnSummary> {
      const result = await forIpc(() =>
        agentHost.startTurn(DESKTOP_PRINCIPAL, {
          sessionId: request.sessionId,
          admission: "queue",
          ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
          input: {
            text: request.content,
            ...(request.attachments ? { attachments: request.attachments } : {}),
          },
          context: { requestId: `desktop-queue-${Date.now().toString(36)}` },
        }),
      );
      const entry = agentHost.queueEntries(request.sessionId).find((candidate) => candidate.turn.id === result.turn.id);
      return entry
        ? toQueueSummary(entry)
        : {
            id: result.turn.id,
            sessionId: request.sessionId,
            content: request.content,
            ...(request.attachments ? { attachments: request.attachments } : {}),
            position: 0,
            createdAt: new Date().toISOString(),
          };
    },
    list(sessionId: string): QueuedTurnSummary[] {
      return agentHost.queueEntries(sessionId).map(toQueueSummary);
    },
    async remove(turnId: string): Promise<void> {
      await forIpc(() => agentHost.cancelTurn(DESKTOP_PRINCIPAL, turnId));
    },
    async prioritize(turnId: string): Promise<void> {
      await forIpc(() => agentHost.prioritizeTurn(DESKTOP_PRINCIPAL, turnId));
    },
  };

  return {
    agentHost,
    queue,
    /** Feed one normalized runtime event; `agent_end` after an abort is `turn.interrupted`. */
    ingest(envelope: AgentEventEnvelope): void {
      const interrupted =
        envelope.event.type === "agent_end" && abortingSessions.has(envelope.sessionId);
      if (envelope.event.type === "agent_end" || envelope.event.type === "error") {
        abortingSessions.delete(envelope.sessionId);
      }
      try {
        agentHost.ingest(envelope, { interrupted });
      } catch (error) {
        options.log("warn", "agent host ingest failed", {
          sessionId: envelope.sessionId,
          type: envelope.event.type,
          error: String(error),
        });
      }
    },
    /** The desktop card or an IPC caller settled an approval outside the module. */
    settleApproval(
      approvalId: string,
      outcome: { decision?: RacpApprovalResult["decision"]; permissionMode?: string },
    ): void {
      if (resolvingViaModule.has(approvalId)) return;
      const permissionMode = isGlobalPermissionMode(outcome.permissionMode)
        ? (outcome.permissionMode as RacpPermissionMode)
        : undefined;
      try {
        agentHost.settleApprovalExternally(approvalId, {
          ...(outcome.decision ? { decision: outcome.decision } : {}),
          ...(permissionMode ? { permissionMode } : {}),
        });
      } catch (error) {
        options.log("warn", "agent host settle failed", { approvalId, error: String(error) });
      }
    },
    markAborting(sessionId: string): void {
      abortingSessions.add(sessionId);
    },
  };
}

export type AgentHostBridge = ReturnType<typeof createAgentHostBridge>;

/** Surface a module error through the IPC error contract (`errorCode`). */
async function forIpc<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RacpError) {
      throw Object.assign(new Error(error.message), {
        errorCode: error.code,
        details: error.details,
      });
    }
    throw error;
  }
}

function toQueueSummary(entry: QueueEntryView): QueuedTurnSummary {
  return {
    id: entry.turn.id,
    sessionId: entry.turn.sessionId,
    content: entry.content,
    ...(entry.attachments ? { attachments: entry.attachments } : {}),
    position: entry.turn.queuePosition ?? 0,
    createdAt: entry.turn.startedAt ?? new Date().toISOString(),
  };
}

type HostQueueEntry = {
  id: string;
  sessionId: string;
  principal: string;
  idempotencyKey?: string;
  inputHash: string;
  content: string;
  attachments?: unknown;
  permissionMode: string;
  position: number;
  createdAt: string;
};

function fromHostQueueEntry(entry: HostQueueEntry): QueuedTurnRecord {
  const permissionMode: RacpPermissionMode =
    entry.permissionMode === "accept-edits" || entry.permissionMode === "auto" ? entry.permissionMode : "ask";
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    principalSubject: entry.principal,
    content: entry.content,
    ...(Array.isArray(entry.attachments) ? { attachments: entry.attachments as QueuedTurnRecord["attachments"] } : {}),
    effectivePermissionMode: permissionMode,
    ...(entry.idempotencyKey ? { idempotencyKey: entry.idempotencyKey } : {}),
    inputHash: entry.inputHash,
    createdAt: Date.parse(entry.createdAt) || 0,
  };
}

function toSummary(record: HostSessionRecord): SessionSummary {
  const mode = record.mode === "plan" || record.mode === "goal" ? record.mode : "agent";
  const permissionMode: RacpPermissionMode =
    record.permissionMode === "accept-edits" || record.permissionMode === "auto" ? record.permissionMode : "ask";
  const planningState =
    record.planningState === "planning" || record.planningState === "awaiting_approval"
      ? record.planningState
      : "inactive";
  return {
    id: record.id,
    title: record.title ?? "",
    ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(record.projectPath ? { workspaceLabel: basename(record.projectPath) } : {}),
    mode,
    permissionMode,
    planningState,
    createdAt: record.createdAt ?? new Date(0).toISOString(),
    updatedAt: record.updatedAt ?? record.createdAt ?? new Date(0).toISOString(),
  };
}

function toItem(message: UiMessage): RacpItemSummary {
  const turnId = (message as { turnId?: string }).turnId ?? "";
  return {
    id: message.id,
    turnId,
    itemType: "message",
    status: message.status === "streaming" ? "streaming" : "completed",
    createdAt: message.createdAt,
    ...(message.parentToolCallId ? { parentToolCallId: message.parentToolCallId } : {}),
    ...(message.agentName ? { agentName: message.agentName } : {}),
    content: message,
  };
}
