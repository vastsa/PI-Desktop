/**
 * The remote backend: translates one paired host's renderer IPC calls into RACP
 * requests and reshapes the results into the exact response shapes the renderer
 * already expects from the local handlers. One instance serves every session of
 * a host and is registered with the router under the host's key; the owning
 * host session id is derived from each call's arguments.
 *
 * Ownership stays inside the frozen architecture: this runs in Electron Main and
 * speaks RACP-WS to the remote `pi-host`; the renderer is unaware of the
 * transport (spec §3.4). A channel outside {@link HANDLED_CHANNELS} fails closed
 * in the router with `CAPABILITY_UNAVAILABLE`; it never runs locally.
 */
import {
  ErrorCodes,
  IPC,
  validateRacpTerminalInputData,
} from "@pi-desktop/shared";
import type {
  AgentCompactResponse,
  AgentPromptRequest,
  AgentPromptResponse,
  AgentQueuePushRequest,
  AgentStatus,
  AgentStopResponse,
  AskToolResolution,
  FsChatRefResolveResult,
  PlanResolutionResult,
  PlanResolveRequest,
  QueuedTurnSummary,
  RacpApprovalResult,
  RacpCursor,
  RacpRequestContext,
  RacpSession,
  RacpTurn,
  RemoteTerminalCloseRequest,
  RemoteTerminalControlResult,
  RemoteTerminalInputRequest,
  RemoteTerminalOpenRequest,
  RemoteTerminalOpenResult,
  RemoteTerminalResizeRequest,
  SessionSummary,
  ToolPermissionResolution,
} from "@pi-desktop/shared";
import type { RemoteBackend } from "./backend-router.js";
import {
  makeRemoteQueuedTurnId,
  makeRemoteSessionId,
  makeRemoteTerminalId,
  parseRemoteApprovalRequestId,
  parseRemoteQueuedTurnId,
  parseRemoteSessionId,
  parseRemoteTerminalId,
  sessionIdForCall,
} from "./backend-router.js";
import { createRemoteHistory, type RemoteHistoryReadOptions } from "./remote-history.js";
import { remoteSessionSummary, type RemoteHostIdentity } from "./remote-transcript.js";

/** The subset of `RacpClient` this backend needs; kept minimal for testing. */
export type RemoteRacpClient = {
  request<T>(method: string, params?: unknown): Promise<T>;
};

export type RemoteBackendOptions = {
  /** The host's routing key; every outward session id embeds it. */
  hostKey: string;
  /** The host's label, shown with each of its sessions. */
  hostLabel: string;
  client: RemoteRacpClient;
  /** Injectable id source for RACP request contexts; defaults to a UUID. */
  newRequestId?: () => string;
  /** A session the host returned (fork, configure), before any event says so. */
  onSession?: (session: RacpSession) => void;
  /** A session the host deleted; `session/delete` publishes no event. */
  onSessionRemoved?: (hostSessionId: string) => void;
  /** A tail read attached at `cursor`; live events continue from there. */
  onSessionRead?: (hostSessionId: string, cursor: RacpCursor) => Promise<boolean | void> | boolean | void;
};

/** The channels a remote host serves; every other remote call fails closed. */
export const HANDLED_CHANNELS: ReadonlySet<string> = new Set([
  IPC.invoke.agentPrompt,
  IPC.invoke.agentQueuePush,
  IPC.invoke.agentQueueList,
  IPC.invoke.agentQueueRemove,
  IPC.invoke.agentQueuePrioritize,
  IPC.invoke.agentStop,
  IPC.invoke.agentAbort,
  IPC.invoke.agentCompact,
  IPC.invoke.agentGetStatus,
  IPC.invoke.sessionGet,
  IPC.invoke.sessionConfigure,
  IPC.invoke.sessionFork,
  IPC.invoke.sessionRename,
  IPC.invoke.sessionDelete,
  IPC.invoke.toolResolvePermission,
  IPC.invoke.askToolResolve,
  IPC.invoke.plansResolve,
  IPC.invoke.plansPending,
  IPC.invoke.fsList,
  IPC.invoke.fsRead,
  IPC.invoke.fsResolveRef,
  IPC.invoke.workspaceDiff,
  IPC.invoke.remoteTerminalOpen,
  IPC.invoke.remoteTerminalInput,
  IPC.invoke.remoteTerminalResize,
  IPC.invoke.remoteTerminalClose,
]);

/** How many pushed prompts are remembered for queue listings. */
const PUSHED_MEMORY = 256;
const RACP_MODES = new Set(["agent", "plan", "goal"]);
const RACP_PERMISSION_MODES = new Set(["ask", "accept-edits", "auto"]);

type PushedPrompt = { content: string; createdAt: string; sessionMessageId?: string };

function capabilityUnavailable(message: string): Error {
  return Object.assign(new Error(message), {
    errorCode: ErrorCodes.CAPABILITY_UNAVAILABLE,
  });
}

function internal(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INTERNAL });
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBase64(value: unknown): value is string {
  return typeof value === "string" &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function isTerminalDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1000;
}

function terminalDimension(value: unknown, field: "cols" | "rows", optional = false): number | undefined {
  if (value === undefined && optional) return undefined;
  if (!isTerminalDimension(value)) {
    throw invalidArgument(`${field} must be an integer between 1 and 1000`);
  }
  return value;
}

export function createRemoteBackend(options: RemoteBackendOptions): RemoteBackend {
  const { hostKey, client } = options;
  const host: RemoteHostIdentity = { hostKey, hostLabel: options.hostLabel };
  const history = createRemoteHistory({ client, host });
  const newRequestId = options.newRequestId ?? (() => globalThis.crypto.randomUUID());
  const context = (idempotencyKey?: string): RacpRequestContext => ({
    requestId: newRequestId(),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  // RACP queued turns carry no prompt text; remember what this desktop pushed
  // so a queue listing keeps showing it.
  const pushed = new Map<string, PushedPrompt>();
  const rememberPushed = (turnId: string, prompt: PushedPrompt) => {
    pushed.set(turnId, prompt);
    while (pushed.size > PUSHED_MEMORY) {
      const oldest = pushed.keys().next().value;
      if (oldest === undefined) break;
      pushed.delete(oldest);
    }
  };

  /** The call's remote session, split into the outward and host ids. */
  const sessionOf = (args: readonly unknown[]) => {
    const remoteSessionId = sessionIdForCall(args);
    const parsed = remoteSessionId ? parseRemoteSessionId(remoteSessionId) : null;
    if (!remoteSessionId || !parsed || parsed.hostKey !== hostKey) {
      throw internal("call does not address a session of this host");
    }
    return { remoteSessionId, hostSessionId: parsed.hostSessionId };
  };

  const terminalSessionOf = (args: readonly unknown[]) => {
    const req = args[0];
    if (!isRecord(req) || typeof req.sessionId !== "string" || !parseRemoteSessionId(req.sessionId)) {
      throw invalidArgument("terminal requests require a remote sessionId");
    }
    return { req, ...sessionOf([req]) };
  };

  const hostTerminalIdOf = (remoteSessionId: string, terminalId: unknown): string => {
    if (typeof terminalId !== "string") {
      throw invalidArgument("terminalId is required");
    }
    const parsed = parseRemoteTerminalId(terminalId);
    if (!parsed || parsed.remoteSessionId !== remoteSessionId) {
      throw invalidArgument("terminalId does not belong to this remote session");
    }
    return parsed.hostTerminalId;
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

  const hostTurnIdOf = (args: readonly unknown[]): string => {
    const turnId = (args[0] as { turnId?: unknown } | undefined)?.turnId;
    const parsed = typeof turnId === "string" ? parseRemoteQueuedTurnId(turnId) : null;
    if (!parsed) throw internal("malformed remote queued-turn id");
    return parsed.hostTurnId;
  };

  const startTurn = async (
    req: AgentPromptRequest | AgentQueuePushRequest,
    admission: "reject_if_busy" | "queue",
  ): Promise<{ accepted: boolean; turn: RacpTurn }> => {
    if ("attachments" in req && req.attachments?.length) {
      throw capabilityUnavailable("this remote host does not accept attachments");
    }
    const { hostSessionId } = sessionOf([req]);
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

  const readSession = async (
    remoteSessionId: string,
    hostSessionId: string,
    readOptions: RemoteHistoryReadOptions,
  ) => {
    let read = await history.read(remoteSessionId, hostSessionId, readOptions);
    if (read.cursor && options.onSessionRead) {
      const resynced = await options.onSessionRead(hostSessionId, read.cursor);
      if (resynced === true) {
        // The first attach cursor belonged to an expired event epoch. The
        // connection has now installed a fresh baseline and snapshot; read it
        // once more so the renderer does not paint the stale transcript.
        read = await history.read(remoteSessionId, hostSessionId, readOptions);
        if (read.cursor) await options.onSessionRead(hostSessionId, read.cursor);
      }
    }
    return read.session;
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
        const prompt: PushedPrompt = {
          content: req.content,
          createdAt: new Date().toISOString(),
          ...(req.sessionMessageId ? { sessionMessageId: req.sessionMessageId } : {}),
        };
        rememberPushed(turn.id, prompt);
        return {
          id: makeRemoteQueuedTurnId(req.sessionId, turn.id),
          sessionId: req.sessionId,
          position: turn.queuePosition ?? 0,
          ...prompt,
        } satisfies QueuedTurnSummary;
      }
      case IPC.invoke.agentQueueList: {
        const { remoteSessionId, hostSessionId } = sessionOf(args);
        const { session } = await client.request<{ session: RacpSession }>("session/get", {
          sessionId: hostSessionId,
        });
        const entries: QueuedTurnSummary[] = session.queuedTurnIds.map((turnId, index) => {
          const prompt = pushed.get(turnId);
          return {
            id: makeRemoteQueuedTurnId(remoteSessionId, turnId),
            sessionId: remoteSessionId,
            // A turn queued by another client has no text this desktop knows.
            content: prompt?.content ?? "",
            ...(prompt?.sessionMessageId ? { sessionMessageId: prompt.sessionMessageId } : {}),
            position: index + 1,
            createdAt: prompt?.createdAt ?? session.updatedAt,
          };
        });
        return { entries };
      }
      case IPC.invoke.agentQueueRemove: {
        const turnId = hostTurnIdOf(args);
        await client.request("turn/cancel", { turnId });
        pushed.delete(turnId);
        return { ok: true };
      }
      case IPC.invoke.agentQueuePrioritize: {
        await client.request("turn/prioritize", { turnId: hostTurnIdOf(args) });
        return { ok: true };
      }
      case IPC.invoke.agentStop: {
        const req = args[0] as { turnId?: string };
        const turnId = await resolveTurnId(sessionOf(args).hostSessionId, req.turnId);
        if (!turnId) return { requested: false } satisfies AgentStopResponse;
        await client.request("turn/stop", { turnId });
        return { requested: true } satisfies AgentStopResponse;
      }
      case IPC.invoke.agentAbort: {
        const req = args[0] as { turnId?: string };
        const turnId = await resolveTurnId(sessionOf(args).hostSessionId, req.turnId);
        if (!turnId) return { aborted: false };
        await client.request("turn/interrupt", { turnId });
        return { aborted: true };
      }
      case IPC.invoke.agentCompact: {
        await client.request("session/compact", { sessionId: sessionOf(args).hostSessionId });
        return { accepted: true } satisfies AgentCompactResponse;
      }
      case IPC.invoke.agentGetStatus: {
        const { remoteSessionId, hostSessionId } = sessionOf(args);
        const { session } = await client.request<{ session: RacpSession }>("session/get", {
          sessionId: hostSessionId,
        });
        const status: AgentStatus = {
          sessionId: remoteSessionId,
          isRunning: session.status === "running" || session.status === "waiting_permission",
          ...(session.activeTurnId ? { currentTurnId: session.activeTurnId } : {}),
          pendingToolConfirmations: session.status === "waiting_permission" ? 1 : 0,
          planningState: session.planningState,
        };
        return { status };
      }
      case IPC.invoke.sessionGet: {
        const { remoteSessionId, hostSessionId } = sessionOf(args);
        const req = args[0] as {
          messageAround?: string;
          messageBefore?: number;
          messageLimit?: number;
        };
        if (req.messageAround !== undefined) {
          throw capabilityUnavailable("search targets are not available for remote sessions");
        }
        return {
          session: await readSession(remoteSessionId, hostSessionId, {
            ...(req.messageBefore !== undefined ? { messageBefore: req.messageBefore } : {}),
            ...(req.messageLimit !== undefined ? { messageLimit: req.messageLimit } : {}),
          }),
        };
      }
      case IPC.invoke.sessionConfigure: {
        const { remoteSessionId, hostSessionId } = sessionOf(args);
        // Provider, model, and thinking level stay the host's own; only the
        // literals RACP defines are forwarded (`inherit` is desktop-only).
        const config = (args[1] ?? {}) as Partial<Pick<SessionSummary, "mode" | "permissionMode">>;
        const { session } = await client.request<{ session: RacpSession }>("session/configure", {
          sessionId: hostSessionId,
          ...(config.mode && RACP_MODES.has(config.mode) ? { mode: config.mode } : {}),
          ...(config.permissionMode && RACP_PERMISSION_MODES.has(config.permissionMode)
            ? { permissionMode: config.permissionMode }
            : {}),
        });
        options.onSession?.(session);
        return { session: remoteSessionSummary(remoteSessionId, session, host) };
      }
      case IPC.invoke.sessionFork: {
        const req = args[0] as { title?: string; throughMessageId?: string };
        const { session } = await client.request<{ session: RacpSession }>("session/fork", {
          sessionId: sessionOf(args).hostSessionId,
          ...(req.title ? { title: req.title } : {}),
          ...(req.throughMessageId ? { throughMessageId: req.throughMessageId } : {}),
        });
        options.onSession?.(session);
        const forkedRemoteId = makeRemoteSessionId(hostKey, session.id);
        return { session: await readSession(forkedRemoteId, session.id, {}) };
      }
      case IPC.invoke.sessionRename: {
        const title = args[1] as string;
        await client.request("session/rename", { sessionId: sessionOf(args).hostSessionId, title });
        return { ok: true };
      }
      case IPC.invoke.sessionDelete: {
        const { hostSessionId } = sessionOf(args);
        await client.request("session/delete", { sessionId: hostSessionId });
        options.onSessionRemoved?.(hostSessionId);
        return { ok: true };
      }
      case IPC.invoke.toolResolvePermission: {
        const resolution = args[0] as ToolPermissionResolution;
        const parsed = parseRemoteApprovalRequestId(resolution.requestId);
        if (!parsed) throw internal("malformed remote approval request id");
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
      case IPC.invoke.fsList: {
        const req = args[0] as { path?: string };
        return client.request("workspace/list", {
          sessionId: sessionOf(args).hostSessionId,
          ...(req.path ? { path: req.path } : {}),
        });
      }
      case IPC.invoke.fsRead: {
        const req = args[0] as { path?: string };
        if (!req.path) {
          throw Object.assign(new Error("path is required"), {
            errorCode: ErrorCodes.INVALID_ARGUMENT,
          });
        }
        return client.request("workspace/read", {
          sessionId: sessionOf(args).hostSessionId,
          path: req.path,
        });
      }
      case IPC.invoke.workspaceDiff:
        return client.request("workspace/diff", {
          sessionId: sessionOf(args).hostSessionId,
        });
      case IPC.invoke.remoteTerminalOpen: {
        const { req, remoteSessionId, hostSessionId } = terminalSessionOf(args);
        const request = req as unknown as RemoteTerminalOpenRequest;
        const cols = terminalDimension(request.cols, "cols", true);
        const rows = terminalDimension(request.rows, "rows", true);
        if (
          request.openRequestId !== undefined &&
          (typeof request.openRequestId !== "string" ||
            request.openRequestId.length < 1 ||
            request.openRequestId.length > 128)
        ) {
          throw invalidArgument("openRequestId must contain 1 to 128 characters");
        }
        const hostTerminalId = request.terminalId === undefined
          ? undefined
          : hostTerminalIdOf(remoteSessionId, request.terminalId);
        const opened = await client.request<unknown>("terminal/open", {
          sessionId: hostSessionId,
          ...(cols !== undefined ? { cols } : {}),
          ...(rows !== undefined ? { rows } : {}),
          ...(request.openRequestId ? { openRequestId: request.openRequestId } : {}),
          ...(hostTerminalId ? { terminalId: hostTerminalId } : {}),
        });
        if (
          !isRecord(opened) ||
          typeof opened.terminalId !== "string" ||
          opened.terminalId.length === 0 ||
          !isBase64(opened.replay) ||
          !isTerminalDimension(opened.cols) ||
          !isTerminalDimension(opened.rows)
        ) {
          throw internal("remote host returned an invalid terminal/open result");
        }
        return {
          terminalId: makeRemoteTerminalId(remoteSessionId, opened.terminalId),
          replay: opened.replay,
          cols: opened.cols,
          rows: opened.rows,
        } satisfies RemoteTerminalOpenResult;
      }
      case IPC.invoke.remoteTerminalInput: {
        const { req, remoteSessionId } = terminalSessionOf(args);
        const request = req as unknown as RemoteTerminalInputRequest;
        const terminalId = hostTerminalIdOf(remoteSessionId, request.terminalId);
        const validation = validateRacpTerminalInputData(request.data);
        if (!validation.valid) {
          if (validation.reason === "payload-too-large") {
            throw Object.assign(new Error("terminal input exceeds the byte limit"), {
              errorCode: ErrorCodes.PAYLOAD_TOO_LARGE,
              data: {
                limitBytes: validation.limitBytes,
                ...(validation.byteLength === undefined
                  ? {}
                  : { actualBytes: validation.byteLength }),
              },
            });
          }
          throw invalidArgument(validation.reason === "invalid-base64"
            ? "terminal input must use canonical Base64 encoding"
            : "terminal input must contain valid UTF-8 bytes");
        }
        const result = await client.request<unknown>("terminal/input", {
          terminalId,
          data: request.data,
        });
        if (!isRecord(result) || result.ok !== true) {
          throw internal("remote host returned an invalid terminal/input result");
        }
        return { ok: true } satisfies RemoteTerminalControlResult;
      }
      case IPC.invoke.remoteTerminalResize: {
        const { req, remoteSessionId } = terminalSessionOf(args);
        const request = req as unknown as RemoteTerminalResizeRequest;
        const terminalId = hostTerminalIdOf(remoteSessionId, request.terminalId);
        const cols = terminalDimension(request.cols, "cols");
        const rows = terminalDimension(request.rows, "rows");
        const result = await client.request<unknown>("terminal/resize", {
          terminalId,
          cols,
          rows,
        });
        if (!isRecord(result) || result.ok !== true) {
          throw internal("remote host returned an invalid terminal/resize result");
        }
        return { ok: true } satisfies RemoteTerminalControlResult;
      }
      case IPC.invoke.remoteTerminalClose: {
        const { req, remoteSessionId } = terminalSessionOf(args);
        const request = req as unknown as RemoteTerminalCloseRequest;
        const terminalId = hostTerminalIdOf(remoteSessionId, request.terminalId);
        const result = await client.request<unknown>("terminal/close", { terminalId });
        if (!isRecord(result) || result.ok !== true) {
          throw internal("remote host returned an invalid terminal/close result");
        }
        return { ok: true } satisfies RemoteTerminalControlResult;
      }
      case IPC.invoke.fsResolveRef:
        // Chat links are resolved against the local workspace; a remote
        // transcript's paths name host files, so none resolves here.
        return { match: null } satisfies FsChatRefResolveResult;
      default:
        throw capabilityUnavailable(`${channel} is not available for remote sessions`);
    }
  };

  return {
    handles: (channel: string) => HANDLED_CHANNELS.has(channel),
    invoke,
  };
}
