import {
  AgentHost,
  RacpError,
  type ApprovalPort,
  type Principal,
  type QueueEntryView,
  type RuntimePort,
  type SubscriptionSink,
  type TurnStartRequest,
  type TurnSteerRequest,
} from "@pi-desktop/agent-host";
import {
  createHostQueueStore,
  createHostSessionPort,
  listPendingToolRequests,
} from "@pi-desktop/host-runtime";
import type {
  AgentEventEnvelope,
  AgentQueueChangedEvent,
  AgentQueuePushRequest,
  AskToolResolution,
  PendingInteractiveRequests,
  QueuedTurnSummary,
  RacpApprovalResult,
  RacpEventEnvelope,
  RacpPermissionMode,
} from "@pi-desktop/shared";
import { IPC, isGlobalPermissionMode } from "@pi-desktop/shared";

type IpcInvoke = (channel: string, args: readonly unknown[]) => Promise<unknown>;

/**
 * Rank the three permission modes on a permissive scale so a "narrower"
 * per-turn ceiling can be recognised. `ask` (0) is most restrictive; `auto`
 * (2) is most permissive. A ceiling that lowers rank narrows; one that
 * raises rank widens (an escalation the runtime must refuse).
 */
const PERMISSION_MODE_RANK: Record<RacpPermissionMode, number> = {
  ask: 0,
  "accept-edits": 1,
  auto: 2,
};

function isWidening(session: RacpPermissionMode, effective: RacpPermissionMode): boolean {
  return PERMISSION_MODE_RANK[effective] > PERMISSION_MODE_RANK[session];
}

type HostLike = {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

/** Interactive cards one read may restore; a session never has many open. */
const MAX_PENDING_INTERACTIVE = 8;

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
      try {
        const summary = await sessions.get(request.sessionId);
        // A per-turn ceiling that would WIDEN the session's stored mode is a
        // real escalation attempt — e.g. a remote viewer whose principal is
        // subject to `remoteMaxPermissionMode: "ask"` should never be able to
        // run a turn at `auto`. Refuse before the sidecar sees the request.
        //
        // A NARROWER ceiling (or the same mode) is safe to accept: it can only
        // reduce what the turn is allowed to do. The runtime still uses the
        // session's stored mode when it enforces tool decisions, so a narrower
        // request is not yet honoured turn-locally — that is the R1 leftover
        // waiting on host-core to accept a `permissionMode` override on
        // `session.beginTurn`. We plumb the parameter end-to-end anyway so the
        // enforcement gate can flip on without another wire change.
        if (
          summary &&
          summary.permissionMode !== request.effectivePermissionMode &&
          isWidening(summary.permissionMode, request.effectivePermissionMode)
        ) {
          throw new RacpError(
            "FORBIDDEN",
            "the local runtime cannot widen the per-turn permission ceiling",
            {
              details: {
                sessionPermissionMode: summary.permissionMode,
                effectivePermissionMode: request.effectivePermissionMode,
              },
            },
          );
        }
        const permissionModeOverride =
          summary && summary.permissionMode !== request.effectivePermissionMode
            ? request.effectivePermissionMode
            : undefined;
        const result = (await options.invoke(options.channels.agentPrompt, [
          {
            sessionId: request.sessionId,
            content: request.content,
            ...(request.sessionMessageId ? { sessionMessageId: request.sessionMessageId } : {}),
            ...(request.userMessageId ? { messageId: request.userMessageId } : {}),
            ...(request.voiceOrigin ? { voiceOrigin: request.voiceOrigin } : {}),
            ...(request.attachments ? { attachments: request.attachments } : {}),
            ...(permissionModeOverride ? { permissionMode: permissionModeOverride } : {}),
          },
        ])) as { accepted?: boolean; turnId: string };
        return { turnId: result.turnId };
      } catch (error) {
        if (request.sessionMessageId) {
          try {
            await requireHost().call("session.collaboration.fail", {
              messageId: request.sessionMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          } catch (persistenceError) {
            options.log("warn", "collaboration dispatch failure persistence failed", {
              sessionId: request.sessionId,
              messageId: request.sessionMessageId,
              error: String(persistenceError),
            });
          }
        }
        throw error;
      }
    },
    /**
     * Deliver one more user message into a running turn (`send now` keeps the
     * promoted messages adjacent). This is the same channel the Composer's
     * Alt+Enter uses, so admission, attachments, and persistence are unchanged.
     */
    async steer(request: TurnSteerRequest) {
      try {
        const result = (await options.invoke(options.channels.agentSteer, [
          {
            sessionId: request.sessionId,
            expectedTurnId: request.turnId,
            content: request.content,
            ...((request.userMessageId ?? request.sessionMessageId)
              ? { messageId: request.userMessageId ?? request.sessionMessageId }
              : {}),
            ...(request.voiceOrigin ? { voiceOrigin: request.voiceOrigin } : {}),
            ...(request.attachments ? { attachments: request.attachments } : {}),
          },
        ])) as { accepted?: boolean } | undefined;
        return { accepted: result?.accepted !== false };
      } catch (error) {
        options.log("warn", "agent host steer failed", {
          sessionId: request.sessionId,
          turnId: request.turnId,
          error: String(error),
        });
        return { accepted: false };
      }
    },
    async stop(sessionId: string) {
      const result = (await options.invoke(options.channels.agentStop, [{ sessionId }])) as
        | { requested?: boolean }
        | undefined;
      return { requested: result?.requested ?? true };
    },
    async abort(sessionId: string, turnId?: string) {
      abortingSessions.add(sessionId);
      try {
        await options.invoke(options.channels.agentAbort, [{ sessionId, ...(turnId ? { turnId } : {}) }]);
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
    listPendingTools: (sessionId) => listPendingToolRequests(options.getHost, sessionId),
  };

  // Session reads and the persisted turn queue (schema v15, ADR 0213) go
  // straight to host-core; the same ports serve the headless Host.
  const sessions = createHostSessionPort(options.getHost);
  const queueStore = createHostQueueStore(options.getHost);

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
            ...(request.sessionMessageId ? { sessionMessageId: request.sessionMessageId } : {}),
            ...(request.userMessageId ? { userMessageId: request.userMessageId } : {}),
            ...(request.voiceOrigin ? { voiceOrigin: request.voiceOrigin } : {}),
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
            ...(request.sessionMessageId ? { sessionMessageId: request.sessionMessageId } : {}),
            ...(request.userMessageId ? { userMessageId: request.userMessageId } : {}),
            ...(request.voiceOrigin ? { voiceOrigin: request.voiceOrigin } : {}),
            ...(request.attachments ? { attachments: request.attachments } : {}),
            position: 0,
            createdAt: new Date().toISOString(),
          };
    },
    list(sessionId: string): QueuedTurnSummary[] {
      return agentHost.queueEntries(sessionId).map(toQueueSummary);
    },
    async remove(turnId: string): Promise<void> {
      const turn = agentHost.getTurn(turnId);
      const entry = agentHost.queueEntries(turn.sessionId).find((candidate) => candidate.turn.id === turnId);
      if (entry?.sessionMessageId) {
        await requireHost().call("session.collaboration.cancel", {
          sessionId: turn.sessionId,
          messageId: entry.sessionMessageId,
        });
      }
      await forIpc(() => agentHost.cancelTurn(DESKTOP_PRINCIPAL, turnId));
    },
    async cancelSessionMessage(sessionId: string, messageId: string): Promise<boolean> {
      return forIpc(() => agentHost.cancelSessionMessage(DESKTOP_PRINCIPAL, sessionId, messageId));
    },
    async prioritize(turnId: string): Promise<void> {
      await forIpc(() => agentHost.prioritizeTurn(DESKTOP_PRINCIPAL, turnId));
    },
    async reorder(
      turnId: string,
      direction: "up" | "down",
    ): Promise<{ moved: boolean }> {
      return forIpc(() => agentHost.reorderTurn(DESKTOP_PRINCIPAL, turnId, direction));
    },
  };

  return {
    agentHost,
    observeWorkTarget(sessionId: string): string | null {
      return agentHost.observeWorkTarget(sessionId).activeTurnId;
    },
    /**
     * Every interactive request this session is waiting on: the ask questions
     * this sidecar generation still holds plus Host-owned permission requests.
     * A renderer that reloaded reads this instead of keeping a card that no
     * longer exists; both lists are bounded.
     */
    async pendingInteractiveRequests(sessionId: string): Promise<PendingInteractiveRequests> {
      const asks = agentHost.pendingInputRequests(sessionId)
        .slice(0, MAX_PENDING_INTERACTIVE)
        .map((entry) => entry.original);
      const pending = await listPendingToolRequests(options.getHost, sessionId);
      return {
        asks,
        permissions: pending.slice(0, MAX_PENDING_INTERACTIVE).map(
          ({ createdAt: _createdAt, expiresAt: _expiresAt, ...request }) => request,
        ),
      };
    },
    /**
     * The single open ask of a session, or `null` when none or several are
     * open: an answer that cannot be attributed to exactly one question must
     * fail closed rather than guess.
     */
    openAsk(sessionId: string) {
      const open = agentHost.pendingInputRequests(sessionId);
      if (open.length !== 1) return null;
      const [entry] = open;
      return {
        inputId: entry.input.id,
        turnId: entry.input.turnId,
        requestId: entry.original.requestId,
        toolCallId: entry.original.toolCallId,
        questions: entry.original.questions,
      };
    },
    /** Resolve one open ask through the Host-owned input path. */
    async resolveOpenAsk(input: { sessionId: string; inputId: string; answers: Array<string[] | null> }) {
      return forIpc(() => agentHost.respondInput(DESKTOP_PRINCIPAL, {
        inputId: input.inputId,
        answers: input.answers,
        context: { requestId: `live-voice:${input.sessionId}` },
      }));
    },
    /**
     * Resolve a Composer ask card through the Host-owned input path, matched
     * by the runtime request id the card carries. Returns `null` when this
     * Host holds no matching open input so the caller falls back to the
     * direct sidecar resolve; otherwise the pending input is deleted before
     * the sidecar settles, so a later `pendingInteractiveRequests` read (for
     * example after switching windows back to the session) no longer
     * resurrects the already answered card.
     */
    async resolveAskByRequestId(resolution: AskToolResolution): Promise<{ ok: boolean } | null> {
      const sessionId = String(resolution?.sessionId ?? "").trim();
      const requestId = String(resolution?.requestId ?? "").trim();
      if (!sessionId || !requestId) return null;
      const entry = agentHost.pendingInputRequests(sessionId)
        .find((candidate) => candidate.original.requestId === requestId);
      if (!entry) return null;
      await forIpc(() => agentHost.respondInput(DESKTOP_PRINCIPAL, {
        inputId: entry.input.id,
        answers: resolution.answers,
        context: { requestId },
      }));
      return { ok: true };
    },
    lookupWorkAdmission(request: {
      sessionId: string;
      idempotencyKey: string;
      userMessageId: string;
      voiceOrigin: import("@pi-desktop/shared").VoiceOrigin;
    }) {
      return agentHost.lookupTurnByIdempotency(DESKTOP_PRINCIPAL, request);
    },
    queue,
    async steerWorkSession(input: { sessionId: string; expectedTurnId: string; content: string; userMessageId: string; voiceOrigin: import("@pi-desktop/shared").VoiceOrigin }): Promise<boolean> {
      const result = await options.invoke(options.channels.agentSteer, [{
        sessionId: input.sessionId,
        expectedTurnId: input.expectedTurnId,
        content: input.content,
        messageId: input.userMessageId,
        voiceOrigin: input.voiceOrigin,
      }]) as { accepted?: boolean } | undefined;
      return result?.accepted === true;
    },
    async stopWorkSession(input: { sessionId: string; expectedTurnId: string; urgency: "graceful" | "immediate" }): Promise<{ status: "requested" | "stale-target" | "already-terminal" }> {
      const channel = input.urgency === "graceful" ? options.channels.agentStop : options.channels.agentAbort;
      const result = await options.invoke(channel, [{ sessionId: input.sessionId, turnId: input.expectedTurnId }]) as { requested?: boolean; aborted?: boolean; ok?: boolean } | undefined;
      const accepted = input.urgency === "graceful" ? result?.requested === true : result?.aborted === true || result?.ok === true;
      return accepted ? { status: "requested" } : { status: "stale-target" };
    },
    /** A ledger stores the actual durable turn, which can differ from a queue ID. */
    async interruptSessionMessage(sessionId: string, turnId: string): Promise<boolean> {
      const result = await options.invoke(options.channels.agentAbort, [{ sessionId, turnId }]) as { aborted?: boolean } | undefined;
      return result?.aborted !== false;
    },
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
    /**
     * The runtime settled one turn. Main is authoritative here: a real abort can
     * lose its terminal event (`isStaleTerminalEvent` drops a terminal event for
     * a turn main no longer owns, and the runtime need not emit one), and a turn
     * left active in the Host would hold the queue forever.
     */
    endTurn(
      sessionId: string,
      turnId: string,
      status: "completed" | "failed" | "interrupted" | "canceled",
      error?: { code: string; message: string; retriable: boolean; traceId: string },
    ): void {
      abortingSessions.delete(sessionId);
      try {
        agentHost.endTurn(sessionId, turnId, status, error ? { error } : {});
      } catch (error_) {
        options.log("warn", "agent host end turn failed", {
          sessionId,
          turnId,
          status,
          error: String(error_),
        });
      }
    },
    onSessionEvent(sessionId: string, listener: (event: RacpEventEnvelope) => void): () => void {
      let subscriptionId: string | null = null;
      const sink: SubscriptionSink = {
        deliver(envelope) {
          try {
            listener(envelope);
          } catch (error) {
            options.log("warn", "agent host session event listener failed", {
              sessionId,
              eventKind: envelope.kind,
              error: String(error),
            });
          } finally {
            if (subscriptionId && envelope.sequence !== undefined) {
              agentHost.ack(subscriptionId, envelope.sequence);
            }
          }
        },
        close(error) {
          options.log("warn", "agent host session event subscription closed", {
            sessionId,
            errorCode: error.code,
          });
        },
      };
      const subscription = agentHost.subscribe(DESKTOP_PRINCIPAL, {
        scope: "session",
        sessionId,
      }, sink);
      subscriptionId = subscription.subscriptionId;
      return () => {
        if (subscriptionId) agentHost.unsubscribe(subscriptionId, sessionId);
        subscriptionId = null;
      };
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
    ...(entry.sessionMessageId ? { sessionMessageId: entry.sessionMessageId } : {}),
    ...(entry.userMessageId ? { userMessageId: entry.userMessageId } : {}),
    ...(entry.voiceOrigin ? { voiceOrigin: entry.voiceOrigin } : {}),
    ...(entry.attachments ? { attachments: entry.attachments } : {}),
    position: entry.turn.queuePosition ?? 0,
    ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
    createdAt: entry.turn.startedAt ?? new Date().toISOString(),
  };
}
