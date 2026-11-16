import { basename } from "node:path";
import { createHash } from "node:crypto";

import type {
  PendingToolRequest,
  QueueStore,
  QueuedTurnRecord,
  SessionPort,
  SessionSummary,
} from "@pi-desktop/agent-host";
import { RacpError } from "@pi-desktop/agent-host";
import type { RacpItemSummary, RacpPermissionMode, UiMessage, VoiceOrigin } from "@pi-desktop/shared";

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

/** Opaque Main/Host authorization fingerprint; never send the source identity to the renderer or model. */
export function sessionWorkspaceIdentity(input: { projectId?: unknown; projectPath?: unknown }): string | null {
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const projectPath = typeof input.projectPath === "string" ? input.projectPath.trim() : "";
  if (!projectId && !projectPath) return null;
  return createHash("sha256").update(JSON.stringify([projectId, projectPath])).digest("hex");
}

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
    workspaceIdentity: sessionWorkspaceIdentity(record),
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
    ...(message.nestedParentToolCallId ? { nestedParentToolCallId: message.nestedParentToolCallId } : {}),
    ...(message.agentName ? { agentName: message.agentName } : {}),
    content: message,
  };
}

/** A project row as host-core lists it. */
export type HostProjectRow = { id: number; path: string };

/**
 * Host-core keys a session by its project path while RACP exposes the project
 * id (spec §5.1). `session/list` decorates its summaries from the projects
 * table; the Agent Host resolves the very same session through {@link SessionPort}
 * for `session/attach`, prompts, and configuration, so the lookup has to happen
 * there too. Without it the id disappears the moment a client attaches, and the
 * renderer can no longer place the session under its project group.
 *
 * A record that already carries the RPC field is authoritative and costs no
 * lookup, so a host that reports ids pays nothing and a host that stores only
 * paths still resolves them.
 */
export async function withProjectIds(
  host: HostRpc,
  records: HostSessionRecord[],
): Promise<SessionSummary[]> {
  const needsLookup = records.some((record) => !record.projectId && record.projectPath);
  const byPath = new Map<string, string>();
  if (needsLookup) {
    const { projects } = await host.call<{ projects?: HostProjectRow[] }>("projects.list", {});
    for (const project of projects ?? []) byPath.set(project.path, String(project.id));
  }
  return records.map((record) => {
    const summary = toSessionSummary(record);
    const projectId = record.projectPath ? byPath.get(record.projectPath) : undefined;
    return projectId ? { ...summary, projectId } : summary;
  });
}

/** Session metadata and transcript pages straight from host `session.get`. */
export function createHostSessionPort(getHost: () => HostRpc | null): SessionPort {
  // `messageLimit` bounds the transcript read; metadata lookups need no messages.
  async function fetchSession(
    sessionId: string,
    messageLimit?: number,
  ): Promise<{ host: HostRpc; record: HostSessionRecord } | null> {
    const host = getHost();
    if (!host) return null;
    const result = await host.call<{ session?: HostSessionRecord | null }>("session.get", {
      id: sessionId,
      ...(messageLimit === undefined ? {} : { messageLimit }),
    });
    const record = result.session ?? null;
    return record ? { host, record } : null;
  }
  return {
    async get(sessionId) {
      const found = await fetchSession(sessionId, 1);
      if (!found) return null;
      const [summary] = await withProjectIds(found.host, [found.record]);
      return summary ?? null;
    },
    async history(sessionId, { limit, beforeItemId }) {
      const record = (await fetchSession(sessionId))?.record;
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
  startGoal?: boolean;
  sessionMessageId?: string;
  userMessageId?: string;
  voiceOrigin?: VoiceOrigin;
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
    startGoal: entry.startGoal === true,
    ...(entry.sessionMessageId ? { sessionMessageId: entry.sessionMessageId } : {}),
    ...(entry.userMessageId ? { userMessageId: entry.userMessageId } : {}),
    ...(entry.voiceOrigin ? { voiceOrigin: entry.voiceOrigin } : {}),
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
        ...(record.startGoal ? { startGoal: true } : {}),
        ...(record.sessionMessageId ? { sessionMessageId: record.sessionMessageId } : {}),
        ...(record.userMessageId ? { userMessageId: record.userMessageId } : {}),
        ...(record.voiceOrigin ? { voiceOrigin: record.voiceOrigin } : {}),
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
