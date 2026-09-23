import type { ComposerPromptDisplay } from "@pi-desktop/shared";
import { basename } from "node:path";

import type {
  PendingToolRequest,
  QueueStore,
  QueuedTurnRecord,
  SessionPort,
  SessionSummary,
} from "@pi-desktop/agent-host";
import { RacpError } from "@pi-desktop/agent-host";
import type { RacpItemSummary, RacpPermissionMode, UiMessage } from "@pi-desktop/shared";

/** Rust host-core over stdio JSON-RPC, as the ports below need it. */
export type HostRpc = {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

export type HostSessionRecord = {
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

export function requireHostRpc(getHost: () => HostRpc | null): HostRpc {
  const host = getHost();
  if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host is not running", { retriable: true });
  return host;
}

export function toSessionSummary(record: HostSessionRecord): SessionSummary {
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

export function toRacpItem(message: UiMessage): RacpItemSummary {
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

/** Session metadata and transcript pages straight from host `session.get`. */
export function createHostSessionPort(getHost: () => HostRpc | null): SessionPort {
  async function fetchSession(sessionId: string): Promise<HostSessionRecord | null> {
    const host = getHost();
    if (!host) return null;
    const result = await host.call<{ session?: HostSessionRecord | null }>("session.get", { id: sessionId });
    return result.session ?? null;
  }
  return {
    async get(sessionId) {
      const record = await fetchSession(sessionId);
      return record ? toSessionSummary(record) : null;
    },
    async history(sessionId, { limit, beforeItemId }) {
      const record = await fetchSession(sessionId);
      const messages = record?.messages ?? [];
      const end = beforeItemId ? messages.findIndex((message) => message.id === beforeItemId) : messages.length;
      const cut = end === -1 ? messages.length : end;
      const start = Math.max(0, cut - limit);
      return {
        items: messages.slice(start, cut).map(toRacpItem),
        hasMore: start > 0,
      };
    },
  };
}

export type HostQueueEntry = {
  id: string;
  sessionId: string;
  principal: string;
  idempotencyKey?: string;
  inputHash: string;
  content: string;
  composerDisplay?: ComposerPromptDisplay;
  sessionMessageId?: string;
  attachments?: unknown;
  permissionMode: string;
  position: number;
  priority?: number;
  createdAt: string;
};

export function fromHostQueueEntry(entry: HostQueueEntry): QueuedTurnRecord {
  const permissionMode: RacpPermissionMode =
    entry.permissionMode === "accept-edits" || entry.permissionMode === "auto" ? entry.permissionMode : "ask";
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    principalSubject: entry.principal,
    content: entry.content,
    ...(entry.composerDisplay ? { composerDisplay: entry.composerDisplay } : {}),
      ...(entry.sessionMessageId ? { sessionMessageId: entry.sessionMessageId } : {}),
    ...(Array.isArray(entry.attachments) ? { attachments: entry.attachments as QueuedTurnRecord["attachments"] } : {}),
    effectivePermissionMode: permissionMode,
    ...(entry.idempotencyKey ? { idempotencyKey: entry.idempotencyKey } : {}),
    inputHash: entry.inputHash,
    ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
    createdAt: Date.parse(entry.createdAt) || 0,
  };
}

/** The Host-owned turn queue persisted by host-core (schema v15, ADR 0213). */
export function createHostQueueStore(getHost: () => HostRpc | null): QueueStore {
  return {
    async listAll() {
      const host = getHost();
      if (!host) return [];
      const result = await host.call<{ entries?: HostQueueEntry[] }>("session.queueList", {});
      return (result.entries ?? []).map(fromHostQueueEntry);
    },
    async push(record) {
      await requireHostRpc(getHost).call("session.queuePush", {
        id: record.id,
        sessionId: record.sessionId,
        principal: record.principalSubject,
        ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
        inputHash: record.inputHash,
        content: record.content,
        ...(record.composerDisplay ? { composerDisplay: record.composerDisplay } : {}),
      ...(record.sessionMessageId ? { sessionMessageId: record.sessionMessageId } : {}),
        ...(record.attachments ? { attachments: record.attachments } : {}),
        permissionMode: record.effectivePermissionMode,
      });
    },
    async remove(id) {
      const result = await requireHostRpc(getHost).call<{ removed?: boolean }>("session.queueRemove", { id });
      return result.removed === true;
    },
    async prioritize(id) {
      await requireHostRpc(getHost).call("session.queuePrioritize", { id });
    },
    async reorder(id, direction) {
      const result = await requireHostRpc(getHost).call<{ moved?: boolean }>("session.queueReorder", {
        id,
        direction,
      });
      return result.moved === true;
    },
  };
}

/** Open tool requests as Host state (`permissions.pending`). */
export async function listPendingToolRequests(
  getHost: () => HostRpc | null,
  sessionId?: string,
): Promise<PendingToolRequest[]> {
  const host = getHost();
  if (!host) return [];
  const result = await host.call<{ requests?: PendingToolRequest[] }>("permissions.pending", {
    ...(sessionId ? { sessionId } : {}),
  });
  return result.requests ?? [];
}
