/**
 * The remote backend: translates one paired host's renderer IPC calls into RACP
 * requests and reshapes the results into the exact response shapes the renderer
 * already expects from the local handlers. One instance serves every session of
 * a host; the owning host session id is derived from each call's arguments, so
 * the same instance is registered under each of the host's session ids.
 *
 * Ownership stays inside the frozen architecture: this runs in Electron Main and
 * speaks RACP-WS to the remote `pi-host`; the renderer is unaware of the
 * transport (spec §3.4). Channels the remote profile does not cover return
 * `false` from {@link RemoteBackend.handles} and fall back to the local handler.
 */
import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type {
  AgentCompactResponse,
  AgentPromptRequest,
  AgentPromptResponse,
  AgentQueuePushRequest,
  AgentStatus,
  AgentStopResponse,
  AskToolResolution,
  PlanResolutionResult,
  PlanResolveRequest,
  QueuedTurnSummary,
  RacpApprovalResult,
  RacpRequestContext,
  RacpSession,
  RacpSessionSnapshot,
  RacpTurn,
  SessionDetail,
  SessionSummary,
  ToolPermissionResolution,
} from "@pi-desktop/shared";
import type { RemoteBackend } from "./backend-router.js";
import {
  makeRemoteSessionId,
  parseRemoteApprovalRequestId,
  parseRemoteSessionId,
  sessionIdForCall,
} from "./backend-router.js";
import { racpSessionToSummary, snapshotToSessionDetail } from "./remote-transcript.js";

/** The subset of `RacpClient` this backend needs; kept minimal for testing. */
export type RemoteRacpClient = {
  request<T>(method: string, params?: unknown): Promise<T>;
};

export type RemoteBackendOptions = {
  /** The host's routing key; the outward id of a forked session reuses it. */
  hostKey: string;
  client: RemoteRacpClient;
  /** Injectable id source for RACP request contexts; defaults to a UUID. */
  newRequestId?: () => string;
};

type AttachResultLike = { session: RacpSession; snapshot?: RacpSessionSnapshot };

function capabilityUnavailable(message: string): Error {
  return Object.assign(new Error(message), {
    errorCode: ErrorCodes.CAPABILITY_UNAVAILABLE,
  });
}

/** The channels a remote host serves; every other channel stays local. */
const HANDLED_CHANNELS: ReadonlySet<string> = new Set([
  IPC.invoke.agentPrompt,
  IPC.invoke.agentQueuePush,
  IPC.invoke.agentQueueList,
  IPC.invoke.agentStop,
  IPC.invoke.agentAbort,
  IPC.invoke.agentCompact,
  IPC.invoke.agentGetStatus,
  IPC.invoke.agentSteer,
  IPC.invoke.sessionGet,
  IPC.invoke.sessionConfigure,
  IPC.invoke.sessionFork,
  IPC.invoke.sessionRename,
  IPC.invoke.sessionDelete,
  IPC.invoke.toolResolvePermission,
  IPC.invoke.askToolResolve,
  IPC.invoke.plansResolve,
  IPC.invoke.plansPending,
]);

export function createRemoteBackend(options: RemoteBackendOptions): RemoteBackend {
  const { hostKey, client } = options;
  const newRequestId = options.newRequestId ?? (() => globalThis.crypto.randomUUID());
  const context = (idempotencyKey?: string): RacpRequestContext => ({
    requestId: newRequestId(),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

  /** The remote-visible id for a call, or throw if it names no remote session. */
  const remoteIdFor = (args: readonly unknown[]): string => {
    const id = sessionIdForCall(args);
    if (!id) {
      throw Object.assign(new Error("call does not address a remote session"), {
        errorCode: ErrorCodes.INTERNAL,
      });
    }
    return id;
  };

  /** The host's own session id (the router only forwards remote-prefixed ids). */
  const hostIdFor = (args: readonly unknown[]): string => {
    const parsed = parseRemoteSessionId(remoteIdFor(args));
    if (!parsed) {
      throw Object.assign(new Error("malformed remote session id"), {
        errorCode: ErrorCodes.INTERNAL,
      });
    }
    return parsed.hostSessionId;
  };

  /** Resolve the turn to act on: an explicit id, else the session's active turn. */
  const resolveTurnId = async (
    hostSessionId: string,
    turnId?: string,
  ): Promise<string | undefined> => {
    if (turnId) return turnId;
    const { session } = await client.request<{ session: RacpSession }>("session/get", {
      sessionId: hostSessionId,
    });
    return session.activeTurnId;
  };

  const startTurn = async (
    req: AgentPromptRequest | AgentQueuePushRequest,
    admission: "reject_if_busy" | "queue",
  ): Promise<{ accepted: boolean; turn: RacpTurn }> => {
    if (req.composerDisplay) throw capabilityUnavailable("this remote host does not accept composer references");
    if ("attachments" in req && req.attachments?.length) {
      throw capabilityUnavailable("this remote host does not accept attachments");
    }
    const hostSessionId = parseRemoteSessionId(req.sessionId)?.hostSessionId;
    if (!hostSessionId) {
      throw Object.assign(new Error("malformed remote session id"), {
        errorCode: ErrorCodes.INTERNAL,
      });
    }
    const idempotencyKey = "idempotencyKey" in req ? req.idempotencyKey : undefined;
    return client.request("turn/start", {
      sessionId: hostSessionId,
      admission,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      input: {
        text: req.content,
        ...(req.sessionMessageId ? { sessionMessageId: req.sessionMessageId } : {}),
        ...("messageId" in req && req.messageId ? { messageId: req.messageId } : {}),
      },
      context: context(idempotencyKey),
    });
  };

  const invoke = async (channel: string, args: readonly unknown[]): Promise<unknown> => {
    switch (channel) {
      case IPC.invoke.agentPrompt: {
        const { accepted, turn } = await startTurn(args[0] as AgentPromptRequest, "reject_if_busy");
        return { accepted, turnId: turn.id } satisfies AgentPromptResponse;
      }
      case IPC.invoke.agentQueuePush: {
        const req = args[0] as AgentQueuePushRequest;
        const { turn } = await startTurn(req, "queue");
        // The prompt text is known here (the snapshot's queued turns do not carry
        // it), so the pushed entry renders with its content immediately.
        return {
          id: turn.id,
          sessionId: req.sessionId,
          content: req.content,
          ...(req.sessionMessageId ? { sessionMessageId: req.sessionMessageId } : {}),
          position: turn.queuePosition ?? 0,
          createdAt: new Date().toISOString(),
        } satisfies QueuedTurnSummary;
      }
      case IPC.invoke.agentQueueList: {
        const remoteSessionId = remoteIdFor(args);
        const attach = await client.request<AttachResultLike>("session/attach", {
          sessionId: parseRemoteSessionId(remoteSessionId)!.hostSessionId,
          includeSnapshot: true,
        });
        const entries: QueuedTurnSummary[] = (attach.snapshot?.queuedTurns ?? []).map(
          (turn, index) => ({
            id: turn.id,
            sessionId: remoteSessionId,
            // RACP turns do not carry the queued prompt text; the entry still
            // renders with its position and id, and live pushes fill content.
            content: "",
            position: turn.queuePosition ?? index + 1,
            createdAt: turn.startedAt ?? new Date().toISOString(),
          }),
        );
        return { entries };
      }
      case IPC.invoke.agentStop: {
        const req = args[0] as { sessionId: string; turnId?: string };
        const turnId = await resolveTurnId(hostIdFor(args), req.turnId);
        if (!turnId) return { requested: false } satisfies AgentStopResponse;
        await client.request("turn/stop", { turnId });
        return { requested: true } satisfies AgentStopResponse;
      }
      case IPC.invoke.agentAbort: {
        const req = args[0] as { sessionId: string; turnId?: string };
        const turnId = await resolveTurnId(hostIdFor(args), req.turnId);
        if (!turnId) return { aborted: false };
        await client.request("turn/interrupt", { turnId });
        return { aborted: true };
      }
      case IPC.invoke.agentCompact: {
        await client.request("session/compact", { sessionId: hostIdFor(args) });
        return { accepted: true } satisfies AgentCompactResponse;
      }
      case IPC.invoke.agentGetStatus: {
        const remoteSessionId = remoteIdFor(args);
        const { session } = await client.request<{ session: RacpSession }>("session/get", {
          sessionId: parseRemoteSessionId(remoteSessionId)!.hostSessionId,
        });
        const status: AgentStatus = {
          sessionId: remoteSessionId,
          isRunning: session.status === "running",
          ...(session.activeTurnId ? { currentTurnId: session.activeTurnId } : {}),
          pendingToolConfirmations: session.status === "waiting_permission" ? 1 : 0,
          planningState: session.planningState,
        };
        return { status };
      }
      case IPC.invoke.agentSteer:
        // Steering an in-flight turn is a local sidecar affordance with no RACP
        // operation; the renderer already guards it behind a capability check.
        throw capabilityUnavailable("steering is not available on a remote host");
      case IPC.invoke.sessionGet: {
        const remoteSessionId = remoteIdFor(args);
        const attach = await client.request<AttachResultLike>("session/attach", {
          sessionId: parseRemoteSessionId(remoteSessionId)!.hostSessionId,
          includeSnapshot: true,
        });
        if (!attach.snapshot) {
          throw Object.assign(new Error("remote host returned no snapshot"), {
            errorCode: ErrorCodes.INTERNAL,
          });
        }
        return { session: snapshotToSessionDetail(remoteSessionId, attach.snapshot) };
      }
      case IPC.invoke.sessionConfigure: {
        const remoteSessionId = remoteIdFor(args);
        const config = (args[1] ?? {}) as Partial<
          Pick<SessionSummary, "mode" | "providerId" | "modelId" | "thinkingLevel" | "permissionMode">
        >;
        const { session } = await client.request<{ session: RacpSession }>("session/configure", {
          sessionId: parseRemoteSessionId(remoteSessionId)!.hostSessionId,
          ...(config.mode ? { mode: config.mode } : {}),
          ...(config.providerId ? { providerId: config.providerId } : {}),
          ...(config.modelId ? { modelId: config.modelId } : {}),
          ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
          ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
        });
        return { session: racpSessionToSummary(remoteSessionId, session, 0) };
      }
      case IPC.invoke.sessionFork: {
        const req = args[0] as { sessionId: string; title?: string; throughMessageId?: string };
        const { session } = await client.request<{ session: RacpSession }>("session/fork", {
          sessionId: parseRemoteSessionId(req.sessionId)!.hostSessionId,
          ...(req.title ? { title: req.title } : {}),
          ...(req.throughMessageId ? { throughMessageId: req.throughMessageId } : {}),
        });
        // The fork is a new host session; the connection layer registers its
        // backend on the `session.created` event. Attach to build its transcript.
        const forkedRemoteId = makeRemoteSessionId(hostKey, session.id);
        const attach = await client.request<AttachResultLike>("session/attach", {
          sessionId: session.id,
          includeSnapshot: true,
        });
        const detail: SessionDetail = attach.snapshot
          ? snapshotToSessionDetail(forkedRemoteId, attach.snapshot)
          : { ...racpSessionToSummary(forkedRemoteId, session, 0), messages: [] };
        return { session: detail };
      }
      case IPC.invoke.sessionRename: {
        const title = args[1] as string;
        await client.request("session/rename", { sessionId: hostIdFor(args), title });
        return { ok: true };
      }
      case IPC.invoke.sessionDelete: {
        await client.request("session/delete", { sessionId: hostIdFor(args) });
        return { ok: true };
      }
      case IPC.invoke.toolResolvePermission: {
        const resolution = args[0] as ToolPermissionResolution;
        const parsed = parseRemoteApprovalRequestId(resolution.requestId);
        if (!parsed) {
          throw Object.assign(new Error("malformed remote approval request id"), {
            errorCode: ErrorCodes.INTERNAL,
          });
        }
        // The local tool decision literals equal the RACP tool decisions exactly.
        await client.request<RacpApprovalResult>("approval/respond", {
          approvalId: parsed.hostApprovalId,
          decision: resolution.decision,
          context: context(),
        });
        return { ok: true };
      }
      case IPC.invoke.askToolResolve: {
        const resolution = args[0] as AskToolResolution;
        // `answers` is `Array<string[] | null>` in both the local and RACP shapes.
        await client.request("input/respond", {
          inputId: resolution.requestId,
          answers: resolution.answers,
          context: context(),
        });
        return { ok: true };
      }
      case IPC.invoke.plansResolve: {
        const resolution = args[0] as PlanResolveRequest;
        const result = await client.request<RacpApprovalResult>("approval/respond", {
          approvalId: resolution.proposalId,
          // Contract decisions ("approve"/"reject") equal the plan actions.
          decision: resolution.action,
          ...(resolution.action === "approve"
            ? { permissionMode: resolution.targetPermissionMode }
            : {}),
          context: context(),
        });
        // The authoritative proposal and planning state arrive on the following
        // `session.changed` event, which the event bridge forwards; this return
        // value only dismisses the card optimistically without throwing.
        const now = new Date().toISOString();
        return {
          ok: result.status === "resolved",
          proposal: {
            id: resolution.proposalId,
            sessionId: resolution.sessionId,
            turnId: resolution.turnId,
            toolCallId: resolution.toolCallId,
            kind: "plan",
            title: "",
            markdown: "",
            // `plan` is the host's persisted-Markdown alias of `markdown`; empty
            // is fine — the authoritative snapshot arrives on the follow-up
            // `session.changed` event and replaces this placeholder.
            plan: "",
            question: "",
            version: resolution.version ?? 1,
            status: resolution.action === "approve" ? "approved" : "rejected",
            createdAt: now,
            updatedAt: now,
          },
          state: "inactive",
          action: resolution.action,
          ...(resolution.action === "approve"
            ? { targetPermissionMode: resolution.targetPermissionMode }
            : {}),
        } satisfies PlanResolutionResult;
      }
      case IPC.invoke.plansPending:
        // Pending plan cards are restored from the attach snapshot's approvals by
        // the event bridge, so this on-demand fetch stays empty for remote hosts.
        return { plans: [] };
      default:
        throw Object.assign(new Error(`remote backend has no handler for ${channel}`), {
          errorCode: ErrorCodes.INTERNAL,
        });
    }
  };

  return {
    handles: (channel: string) => HANDLED_CHANNELS.has(channel),
    invoke,
  };
}
