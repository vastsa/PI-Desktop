import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentPromptAttachment,
  AgentStatus,
  AskToolRequest,
  PlanningStateEvent,
  RacpApprovalRequest,
  RacpApprovalResponse,
  RacpApprovalResult,
  RacpCursor,
  RacpInputRequest,
  RacpInputResponse,
  RacpItemSummary,
  RacpItemType,
  RacpLimits,
  RacpOperation,
  RacpPermissionMode,
  RacpPlanningState,
  RacpPolicy,
  RacpRequestContext,
  RacpRole,
  RacpSession,
  RacpSessionSnapshot,
  RacpSessionStatus,
  RacpTurn,
  RacpTurnAdmission,
  ToolPermissionRequest,
  UiMessage,
} from "@pi-desktop/shared";
import {
  RACP_ACTIVE_TURN_STATUSES,
  RACP_DEFAULT_LIMITS,
  RACP_DEFAULT_POLICY,
  applyMessageUpdate,
  clampPermissionMode,
  deltaStreamPayloadFits,
  effectiveRemotePermissionMode,
  remotePermissionCeiling,
  racpKindForAgentEvent,
  rolesAllowOperation,
} from "@pi-desktop/shared";

import { ApprovalBroker, type ApprovalPort } from "./approvals.js";
import { racpError } from "./errors.js";
import { EventHub, type SubscribeParams, type SubscribeResult, type SubscriptionSink } from "./event-log.js";
import {
  MemoryQueueStore,
  RandomIds,
  SystemClock,
  type Clock,
  type IdSource,
  type Principal,
  type QueueReorderDirection,
  type QueueStore,
  type QueuedTurnRecord,
  type RuntimePort,
  type SessionPort,
  type SessionSummary,
} from "./ports.js";
import { TurnQueue } from "./turn-queue.js";

export type AgentHostOptions = {
  runtime: RuntimePort;
  sessions: SessionPort;
  approvals: ApprovalPort;
  queueStore?: QueueStore;
  clock?: Clock;
  ids?: IdSource;
  limits?: Partial<RacpLimits>;
  policy?: Partial<RacpPolicy>;
  /** Lifetime for approvals raised while no remote subscriber is attached. */
  localApprovalLifetimeMs?: number;
  /** Whether Host policy lets remote approvers grant `allow-session`. */
  allowRemoteSessionGrants?: boolean;
  /** Bound on the transcript page in a snapshot. */
  snapshotItems?: number;
  /** Called after any change to a session's queue, with the new entries. */
  onQueueChange?: (sessionId: string, entries: QueueEntryView[]) => void;
};

/** A queued turn together with the prompt it will send. */
export type QueueEntryView = {
  turn: RacpTurn;
  content: string;
  sessionMessageId?: string;
  attachments?: AgentPromptAttachment[];
  /** Set only for promoted entries; entries are already in delivery order. */
  priority?: number;
};

export type StartTurnParams = {
  sessionId: string;
  idempotencyKey?: string;
  admission?: RacpTurnAdmission;
  input: {
    text: string;
    attachments?: AgentPromptAttachment[];
    sessionMessageId?: string;
    /** Client-chosen id for the durable user row (D288). */
    userMessageId?: string;
  };
  context: RacpRequestContext;
};

export type StartTurnResult = { accepted: true; turn: RacpTurn; cursor: RacpCursor };

export type AttachParams = {
  sessionId: string;
  role?: RacpRole;
  after?: RacpCursor;
  includeSnapshot?: boolean;
};

export type AttachResult = {
  session: RacpSession;
  role: RacpRole;
  replayComplete: boolean;
  resyncReason?: "epoch" | "evicted" | "ahead";
  snapshot?: RacpSessionSnapshot;
};

type TurnRecord = RacpTurn & {
  /** A queued input consumed by another turn cannot be canceled retroactively. */
  deliveredIntoTurnId?: string;
  /** Only this input is reserved while runtime delivery is in flight. */
  deliveryPending?: boolean;
  /** The runtime's own turn id when it differs from the RACP id (queued turns). */
  runtimeTurnId?: string;
  principalSubject?: string;
};

type SessionState = {
  id: string;
  revision: number;
  status: RacpSessionStatus;
  planningState: RacpPlanningState;
  permissionMode: RacpPermissionMode;
  activeTurnId?: string;
  turns: Map<string, TurnRecord>;
  activeItems: Map<string, RacpItemSummary>;
  pendingInputs: Map<string, { request: RacpInputRequest; original: AskToolRequest }>;
  /** True while at least one remote subscriber is attached. */
  remoteSubscribers: number;
};

type IdempotencyEntry = { turnId: string; inputHash: string };

const MAX_IDEMPOTENCY_ENTRIES = 2000;
const MAX_TURNS_PER_SESSION = 200;

/**
 * The headless Agent Host module (rollout R1, D374/D375). It owns session
 * and turn admission, the per-session turn queue, the approval broker, the
 * in-memory event log with epochs, and the snapshot builder, and it has no
 * Electron dependency. Desktop IPC, the local MCP control plane, RACP, and
 * the messaging integration are callers of this one object.
 */
export class AgentHost {
  readonly hub: EventHub;
  readonly queue: TurnQueue;
  readonly approvals: ApprovalBroker;
  readonly limits: RacpLimits;
  readonly policy: RacpPolicy;

  private readonly runtime: RuntimePort;
  private readonly sessions: SessionPort;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly localApprovalLifetimeMs: number;
  private readonly allowRemoteSessionGrants: boolean;
  private readonly snapshotItems: number;
  private readonly onQueueChange?: (sessionId: string, entries: QueueEntryView[]) => void;
  private readonly states = new Map<string, SessionState>();
  private readonly turnIndex = new Map<string, string>();
  private readonly runtimeAliases = new Map<string, string>();
  /** The dequeued turn whose runtime prompt acknowledgement is still pending. */
  private readonly startingQueuedTurns = new Map<string, TurnRecord>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly draining = new Set<string>();
  /** A pass that arrived while one was running: the queue must be looked at again. */
  private readonly drainPending = new Set<string>();
  private readonly admissions = new Map<string, Promise<void>>();

  constructor(options: AgentHostOptions) {
    this.runtime = options.runtime;
    this.sessions = options.sessions;
    this.clock = options.clock ?? new SystemClock();
    this.ids = options.ids ?? new RandomIds();
    this.limits = { ...RACP_DEFAULT_LIMITS, ...options.limits };
    this.policy = { ...RACP_DEFAULT_POLICY, ...options.policy };
    this.localApprovalLifetimeMs = options.localApprovalLifetimeMs ?? 120_000;
    this.allowRemoteSessionGrants = options.allowRemoteSessionGrants ?? false;
    this.snapshotItems = options.snapshotItems ?? 50;
    this.onQueueChange = options.onQueueChange;
    this.hub = new EventHub({ clock: this.clock, ids: this.ids, limits: this.limits });
    this.queue = new TurnQueue(options.queueStore ?? new MemoryQueueStore(), this.limits.maxQueuedTurnsPerSession);
    this.approvals = new ApprovalBroker(options.approvals, this.clock);
  }

  /** Restore persisted queue records; every restored session starts held. */
  async start(): Promise<void> {
    await this.queue.restore();
  }

  // -------------------------------------------------------------------------
  // Ingest from the runtime / Electron Main
  // -------------------------------------------------------------------------

  /**
   * Feed one normalized runtime event. `interrupted` says the Host recorded
   * the turn as aborted or stopped, so `agent_end` becomes `turn.interrupted`.
   */
  ingest(envelope: AgentEventEnvelope, meta: { interrupted?: boolean } = {}): void {
    const state = this.state(envelope.sessionId);
    const event = envelope.event;
    const turnId = envelope.turnId ? this.resolveTurnId(state, envelope.turnId) : state.activeTurnId;
    const mapping = racpKindForAgentEvent(event.type, { interrupted: meta.interrupted });
    const meta2 = {
      turnId,
      parentToolCallId: envelope.parentToolCallId,
      agentName: envelope.agentName,
    };

    switch (event.type) {
      case "agent_start": {
        const turn = this.ensureTurn(state, turnId ?? envelope.turnId ?? this.ids.next("turn"));
        turn.status = "running";
        turn.startedAt = turn.startedAt ?? new Date(envelope.ts).toISOString();
        state.activeTurnId = turn.id;
        state.status = "running";
        this.emit(state, mapping.kind, { event }, { ...meta2, turnId: turn.id });
        return;
      }
      case "agent_end":
      case "error": {
        const turn = turnId ? state.turns.get(turnId) : undefined;
        if (event.type === "error" && (!turn || !isActive(turn.status))) {
          // A non-terminal provider error is diagnostic only.
          this.emit(state, "turn.activity", { event }, meta2);
          return;
        }
        this.closeTurn(state, turn, {
          status: event.type === "error" ? "failed" : meta.interrupted ? "interrupted" : "completed",
          endedAt: new Date(envelope.ts).toISOString(),
          ...(event.type === "error"
            ? {
                error: {
                  code: event.error.code,
                  message: event.error.message,
                  retriable: event.error.retriable ?? false,
                  traceId: event.error.traceId ?? "",
                },
              }
            : {}),
          kind: mapping.kind,
          payload: { event },
          meta: meta2,
        });
        return;
      }
      case "message_start":
      case "tool_start":
      case "compaction_start": {
        const item = this.itemFromEvent(event, envelope, turnId, "streaming", mapping.itemType!);
        state.activeItems.set(item.id, item);
        this.emit(state, mapping.kind, { itemType: mapping.itemType, itemId: item.id, event }, meta2);
        return;
      }
      case "message_update":
      case "tool_update": {
        const itemId = event.type === "message_update" ? event.message.id : event.toolCallId;
        const item = state.activeItems.get(itemId);
        if (item) {
          item.content =
            event.type === "message_update"
              ? applyMessageUpdate(item.content as UiMessage | undefined, event)
              : { ...(item.content as object), partialResult: event.partialResult };
        }
        this.emit(state, mapping.kind, { itemType: mapping.itemType, itemId, event }, meta2);
        return;
      }
      case "user_message_persisted": {
        const optimistic = state.activeItems.get(event.optimisticMessageId);
        if (!optimistic || optimistic.turnId !== turnId ||
            (optimistic.content as UiMessage)?.role !== "user" || event.message.role !== "user") return;
        state.activeItems.delete(event.optimisticMessageId);
        this.emit(state, mapping.kind, { itemType: "message", itemId: event.message.id, event }, meta2);
        return;
      }
      case "message_end":
      case "tool_end":
      case "compaction_end": {
        const item = this.itemFromEvent(event, envelope, turnId, "completed", mapping.itemType!);
        state.activeItems.delete(item.id);
        this.emit(state, mapping.kind, { itemType: mapping.itemType, itemId: item.id, event }, meta2);
        // A manual compaction occupies the runtime without a turn; let the
        // queue run once it ends.
        if (event.type === "compaction_end") void this.drain(state.id);
        return;
      }
      case "tool_permission_request": {
        const turn = turnId ? state.turns.get(turnId) : undefined;
        if (turn) turn.status = "waiting_approval";
        state.status = "waiting_permission";
        const approval = this.approvals.fromToolPermission(event.request, {
          turnId: turn?.id ?? turnId ?? "",
          revision: state.revision + 1,
          lifetimeMs: this.approvalLifetime(state),
          allowSession: this.allowRemoteSessionGrants,
        });
        this.emit(state, "approval.requested", approval, meta2);
        return;
      }
      case "asktool_request": {
        const turn = turnId ? state.turns.get(turnId) : undefined;
        if (turn) turn.status = "waiting_input";
        const request = this.inputFromAsktool(event.request, state, turn?.id ?? turnId ?? "", envelope);
        state.pendingInputs.set(request.id, { request, original: event.request });
        this.emit(state, "input.requested", request, meta2);
        return;
      }
      case "planning_state": {
        const planning: PlanningStateEvent = { ...event, sessionId: state.id };
        state.planningState = planning.state;
        const approval = this.approvals.fromPlanningState(planning, {
          turnId: turnId ?? state.activeTurnId ?? "",
          revision: state.revision + 1,
          lifetimeMs: this.approvalLifetime(state),
        });
        this.emit(state, "session.changed", { event: planning }, meta2);
        if (approval) this.emit(state, "approval.requested", approval, meta2);
        this.emitHostSessionChanged(state);
        if (planning.state !== "awaiting_approval") void this.drain(state.id);
        return;
      }
      case "status": {
        this.applyStatus(state, event.status);
        this.emit(state, "turn.activity", { event }, meta2);
        return;
      }
      case "turn_start":
      case "turn_end":
        this.emit(state, "turn.activity", { event }, meta2);
        return;
      default: {
        const exhaustive: never = event;
        throw new Error(`unhandled agent event ${String((exhaustive as { type?: string }).type)}`);
      }
    }
  }

  /** The local desktop settled an approval through its own card. */
  settleApprovalExternally(
    approvalId: string,
    outcome: { decision?: RacpApprovalResult["decision"]; permissionMode?: RacpPermissionMode; status?: RacpApprovalResult["status"] },
  ): RacpApprovalResult | null {
    const request = this.approvals.get(approvalId);
    if (!request) return null;
    const state = this.state(request.sessionId);
    const result = this.approvals.settle(approvalId, {
      status: outcome.status ?? "resolved",
      decision: outcome.decision,
      permissionMode: outcome.permissionMode,
      revision: state.revision + 1,
    });
    this.afterApproval(state, request.turnId);
    this.emit(state, "approval.resolved", result, { turnId: request.turnId });
    return result;
  }

  /** Announce a session the local user created, renamed, or archived. */
  publishSessionChange(kind: "session.created" | "session.changed" | "session.archived", summary: SessionSummary): void {
    const state = this.state(summary.id);
    state.permissionMode = summary.permissionMode;
    if (summary.planningState) state.planningState = summary.planningState;
    if (kind !== "session.created") this.emit(state, "session.changed", { session: summary }, {});
    this.hub.publish({ scope: "host", sessionId: summary.id, revision: state.revision, kind, payload: { session: summary } });
  }

  // -------------------------------------------------------------------------
  // RACP operations
  // -------------------------------------------------------------------------

  async attach(principal: Principal, params: AttachParams): Promise<AttachResult> {
    this.requireRole(principal, "session/attach");
    const summary = await this.requireSession(params.sessionId);
    const state = this.state(summary.id);
    state.permissionMode = summary.permissionMode;
    await this.syncPendingApprovals(state);
    const role = params.role ?? highestRole(principal.roles);
    if (!principal.roles.includes(role) && !principal.roles.includes("owner")) {
      throw racpError("FORBIDDEN", `principal does not hold the ${role} role`);
    }
    if (role === "controller" || role === "owner") {
      this.queue.resume(state.id);
      void this.drain(state.id);
    }
    const decision = this.hub.stream(state.id).replay(params.after);
    const replayComplete = decision.status !== "resync";
    const result: AttachResult = {
      session: this.toRacpSession(summary, state),
      role,
      replayComplete,
      ...(decision.status === "resync" ? { resyncReason: decision.reason } : {}),
    };
    if (params.includeSnapshot !== false) result.snapshot = await this.snapshot(state.id, summary);
    return result;
  }

  subscribe(principal: Principal, params: SubscribeParams, sink: SubscriptionSink): SubscribeResult {
    this.requireRole(principal, "events/subscribe");
    if (params.scope === "session") {
      const state = this.state(requireSessionId(params.sessionId));
      state.remoteSubscribers += 1;
      const wrapped: SubscriptionSink = {
        deliver: (envelope) => sink.deliver(envelope),
        close: (error, cursor) => {
          state.remoteSubscribers = Math.max(0, state.remoteSubscribers - 1);
          sink.close(error, cursor);
        },
      };
      return this.hub.subscribe(params, wrapped);
    }
    return this.hub.subscribe(params, sink);
  }

  unsubscribe(subscriptionId: string, sessionId?: string): boolean {
    const removed = this.hub.unsubscribe(subscriptionId);
    if (removed && sessionId) {
      const state = this.state(sessionId);
      state.remoteSubscribers = Math.max(0, state.remoteSubscribers - 1);
    }
    return removed;
  }

  ack(subscriptionId: string, sequence: number): void {
    this.hub.ack(subscriptionId, sequence);
  }

  async startTurn(principal: Principal, params: StartTurnParams): Promise<StartTurnResult> {
    this.requireRole(principal, "turn/start");
    return this.withAdmission(params.sessionId, () => this.startTurnAdmitted(principal, params));
  }

  private async startTurnAdmitted(principal: Principal, params: StartTurnParams): Promise<StartTurnResult> {
    const summary = await this.requireSession(params.sessionId);
    const state = this.state(summary.id);
    state.permissionMode = summary.permissionMode;
    const inputHash = hashInput(params.input);
    const idempotencyKey = params.idempotencyKey ?? params.context.idempotencyKey;
    if (idempotencyKey) {
      const remembered = this.idempotency.get(`${principal.subject}|${idempotencyKey}`);
      if (remembered) {
        if (remembered.inputHash !== inputHash) {
          throw racpError("IDEMPOTENCY_CONFLICT", "the idempotency key was reused with different input");
        }
        const turn = state.turns.get(remembered.turnId);
        if (turn) return { accepted: true, turn: this.toRacpTurn(state, turn), cursor: this.hub.stream(state.id).cursor() };
      }
    }
    const expected = params.context.expectedRevision;
    if (typeof expected === "number" && expected !== state.revision) {
      throw racpError("CONFLICT", "expected session revision is stale", {
        details: { expectedRevision: expected, revision: state.revision },
      });
    }
    const ceilingInput = {
      sessionMode: summary.permissionMode,
      policy: this.policy,
      pairedDevice: principal.pairedDevice ?? false,
      approverOverride: principal.approverOverride ?? false,
    } as const;
    const effectivePermissionMode = effectiveRemotePermissionMode(ceilingInput);
    const permissionCeiling = remotePermissionCeiling(ceilingInput);
    const admission: RacpTurnAdmission = params.admission ?? "reject_if_busy";
    const busy = this.isBusy(state);
    let turn: TurnRecord;
    if (busy) {
      if (admission === "reject_if_busy") {
        throw racpError("AGENT_BUSY", "the session already has an active turn");
      }
      const record: QueuedTurnRecord = {
        id: this.ids.next("turn"),
        sessionId: state.id,
        principalSubject: principal.subject,
        content: params.input.text,
        ...(params.input.sessionMessageId ? { sessionMessageId: params.input.sessionMessageId } : {}),
        ...(params.input.userMessageId ? { userMessageId: params.input.userMessageId } : {}),
        ...(params.input.attachments ? { attachments: params.input.attachments } : {}),
        effectivePermissionMode,
        ...(permissionCeiling ? { permissionCeiling } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        inputHash,
        createdAt: this.clock.now(),
      };
      const position = await this.queue.push(record);
      turn = this.ensureTurn(state, record.id);
      turn.status = "queued";
      turn.admission = "queue";
      turn.queuePosition = position;
      turn.effectivePermissionMode = effectivePermissionMode;
      turn.idempotencyKey = idempotencyKey;
      turn.principalSubject = principal.subject;
      this.emit(state, "turn.queued", { turn: this.toRacpTurn(state, turn) }, { turnId: turn.id });
      this.notifyQueue(state.id);
    } else {
      const started = await this.runtime.prompt({
        sessionId: state.id,
        content: params.input.text,
        ...(params.input.sessionMessageId ? { sessionMessageId: params.input.sessionMessageId } : {}),
        ...(params.input.userMessageId ? { userMessageId: params.input.userMessageId } : {}),
        ...(params.input.attachments ? { attachments: params.input.attachments } : {}),
        effectivePermissionMode,
        ...(permissionCeiling ? { permissionCeiling } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        principal,
      });
      turn = this.ensureTurn(state, started.turnId);
      if (!isActive(turn.status)) turn.status = "running";
      turn.admission = admission;
      turn.effectivePermissionMode = effectivePermissionMode;
      turn.idempotencyKey = idempotencyKey;
      turn.principalSubject = principal.subject;
      state.activeTurnId = turn.id;
      state.status = "running";
    }
    if (idempotencyKey) this.rememberIdempotency(`${principal.subject}|${idempotencyKey}`, { turnId: turn.id, inputHash });
    return { accepted: true, turn: this.toRacpTurn(state, turn), cursor: this.hub.stream(state.id).cursor() };
  }

  getTurn(turnId: string): RacpTurn {
    const state = this.stateForTurn(turnId);
    return this.toRacpTurn(state, state.turns.get(turnId)!);
  }

  async stopTurn(principal: Principal, turnId: string): Promise<RacpTurn> {
    this.requireRole(principal, "turn/stop");
    const state = this.stateForTurn(turnId);
    const turn = state.turns.get(turnId)!;
    if (turn.status === "queued") return this.cancelTurn(principal, turnId);
    if (isActive(turn.status)) await this.runtime.stop(state.id);
    return this.toRacpTurn(state, turn);
  }

  async interruptTurn(principal: Principal, turnId: string): Promise<RacpTurn> {
    this.requireRole(principal, "turn/interrupt");
    const state = this.stateForTurn(turnId);
    const turn = state.turns.get(turnId)!;
    if (turn.status === "queued") return this.cancelTurn(principal, turnId);
    if (isActive(turn.status)) await this.runtime.abort(state.id, turn.runtimeTurnId ?? turn.id);
    return this.toRacpTurn(state, turn);
  }

  async cancelTurn(principal: Principal, turnId: string): Promise<RacpTurn> {
    this.requireRole(principal, "turn/cancel");
    const state = this.stateForTurn(turnId);
    return this.withAdmission(state.id, async () => {
      const turn = state.turns.get(turnId)!;
      if (turn.deliveryPending || turn.deliveredIntoTurnId || turn.status !== "queued") {
        if (turn.status === "canceled" && !turn.deliveryPending && !turn.deliveredIntoTurnId) return this.toRacpTurn(state, turn);
        throw racpError("CONFLICT", "the queued message has already started; use Stop to stop the running turn");
      }
      return this.cancelQueued(state, turn);
    });
  }

  /** Remove a collaboration delivery from both the live and durable queue. */
  async cancelSessionMessage(principal: Principal, sessionId: string, messageId: string): Promise<boolean> {
    this.requireRole(principal, "turn/cancel");
    return this.withAdmission(sessionId, async () => {
      const record = this.queue.list(sessionId).find((entry) => entry.sessionMessageId === messageId);
      if (!record) return false;
      const state = this.state(sessionId);
      await this.cancelQueued(state, this.ensureQueuedTurn(state, record));
      return true;
    });
  }

  /** Promote a queued turn to the end of its session's priority block ("send now"). */
  async prioritizeTurn(principal: Principal, turnId: string): Promise<RacpTurn> {
    this.requireRole(principal, "turn/prioritize");
    const state = this.stateForTurn(turnId);
    return this.withAdmission(state.id, async () => {
      const turn = state.turns.get(turnId)!;
      if (turn.deliveryPending || turn.deliveredIntoTurnId || turn.status !== "queued") {
        throw racpError("CONFLICT", "only a queued turn can be prioritized");
      }
      if (!(await this.queue.promote(state.id, turn.id))) {
        throw racpError("CONFLICT", "the turn is already prioritized");
      }
      this.afterQueueMove(state, turn.id);
      return this.toRacpTurn(state, turn);
    });
  }

  /**
   * Swap a queued turn with its adjacent plain-queue neighbour. A promoted
   * entry, an entry already at that edge, or a missing entry is a no-op
   * (`moved: false`). Reordering uses the same controller permission as
   * prioritizing: RACP has no separate reorder operation.
   */
  async reorderTurn(
    principal: Principal,
    turnId: string,
    direction: QueueReorderDirection,
  ): Promise<{ moved: boolean }> {
    this.requireRole(principal, "turn/prioritize");
    const state = this.stateForTurn(turnId);
    return this.withAdmission(state.id, async () => {
      const turn = state.turns.get(turnId)!;
      if (turn.deliveryPending || turn.deliveredIntoTurnId || turn.status !== "queued") {
        throw racpError("CONFLICT", "only a queued turn can be reordered");
      }
      if (!(await this.queue.reorder(state.id, turn.id, direction))) return { moved: false };
      this.afterQueueMove(state, turn.id);
      return { moved: true };
    });
  }

  /** Publish one queue move and let an idle session drain the new head. */
  private afterQueueMove(state: SessionState, turnId: string): void {
    this.renumberQueue(state);
    const turn = state.turns.get(turnId);
    if (turn) this.emit(state, "turn.queued", { turn: this.toRacpTurn(state, turn) }, { turnId });
    this.notifyQueue(state.id);
    this.queue.resume(state.id);
    void this.drain(state.id);
  }

  async respondApproval(principal: Principal, response: RacpApprovalResponse): Promise<RacpApprovalResult> {
    this.requireRole(principal, "approval/respond");
    const request = this.approvals.get(response.approvalId);
    const remembered = this.approvals.result(response.approvalId);
    if (!request && !remembered) throw racpError("NOT_FOUND", `approval ${response.approvalId} is not open`);
    const state = this.state((request ?? { sessionId: this.sessionOfResult(response.approvalId) }).sessionId);
    if (response.decision === "allow-session" && !this.allowRemoteSessionGrants && !principal.pairedDevice) {
      throw racpError("FORBIDDEN", "remote session grants are not allowed by Host policy");
    }
    const result = await this.approvals.resolve(response, principal, state.revision + 1);
    if (!result.alreadyResolved) {
      this.afterApproval(state, request?.turnId);
      this.emit(state, "approval.resolved", result, { turnId: request?.turnId });
    }
    return result;
  }

  async respondInput(principal: Principal, response: RacpInputResponse): Promise<{ inputId: string; status: "resolved" }> {
    this.requireRole(principal, "input/respond");
    let found: { state: SessionState; entry: { request: RacpInputRequest; original: AskToolRequest } } | undefined;
    for (const state of this.states.values()) {
      const entry = state.pendingInputs.get(response.inputId);
      if (entry) found = { state, entry };
    }
    if (!found) throw racpError("NOT_FOUND", `input request ${response.inputId} is not open`);
    const { state, entry } = found;
    if (response.answers.length !== entry.request.questions.length) {
      throw racpError("INVALID_ARGUMENT", "answers must match the number of questions");
    }
    await this.runtime.respondInput({
      requestId: entry.original.requestId,
      sessionId: entry.original.sessionId,
      answers: response.answers,
    });
    state.pendingInputs.delete(response.inputId);
    const turn = state.turns.get(entry.request.turnId);
    if (turn && turn.status === "waiting_input") turn.status = "running";
    this.emit(state, "input.resolved", { inputId: response.inputId, status: "resolved", by: principal.subject }, { turnId: entry.request.turnId });
    return { inputId: response.inputId, status: "resolved" };
  }

  async history(
    principal: Principal,
    params: { sessionId: string; beforeItemId?: string; limit?: number },
  ): Promise<{ items: RacpItemSummary[]; hasMore: boolean; revision: number }> {
    this.requireRole(principal, "session/history");
    const state = this.state(params.sessionId);
    const limit = Math.max(1, Math.min(params.limit ?? 100, 200));
    const page = await this.sessions.history(params.sessionId, {
      limit,
      ...(params.beforeItemId ? { beforeItemId: params.beforeItemId } : {}),
    });
    return { ...page, revision: state.revision };
  }

  async snapshot(sessionId: string, summary?: SessionSummary): Promise<RacpSessionSnapshot> {
    const resolved = summary ?? (await this.requireSession(sessionId));
    const state = this.state(sessionId);
    const page = await this.sessions.history(sessionId, { limit: this.snapshotItems });
    const activeTurn = state.activeTurnId ? state.turns.get(state.activeTurnId) : undefined;
    return {
      session: this.toRacpSession(resolved, state),
      ...(activeTurn ? { activeTurn: this.toRacpTurn(state, activeTurn) } : {}),
      queuedTurns: this.queue.list(sessionId).map((record) => this.toRacpTurn(state, this.ensureQueuedTurn(state, record))),
      items: page.items,
      activeItems: [...state.activeItems.values()],
      pendingApprovals: this.approvals.list(sessionId),
      pendingInputs: [...state.pendingInputs.values()].map((entry) => entry.request),
      hasMoreHistory: page.hasMore,
      cursor: this.hub.stream(sessionId).cursor(),
      revision: state.revision,
      generatedAt: new Date(this.clock.now()).toISOString(),
    };
  }

  pendingApprovals(sessionId?: string): RacpApprovalRequest[] {
    return this.approvals.list(sessionId);
  }

  /** The RACP view of a session the caller already fetched: its durable summary plus live state. */
  describeSession(summary: SessionSummary): RacpSession {
    const state = this.state(summary.id);
    state.permissionMode = summary.permissionMode;
    return this.toRacpSession(summary, state);
  }

  queuedTurns(sessionId: string): RacpTurn[] {
    return this.queueEntries(sessionId).map((entry) => entry.turn);
  }

  /** Queued turns with their prompts, in delivery order. */
  queueEntries(sessionId: string): QueueEntryView[] {
    const state = this.state(sessionId);
    return this.queue.list(sessionId).map((record) => ({
      turn: this.toRacpTurn(state, this.ensureQueuedTurn(state, record)),
      content: record.content,
      ...(record.sessionMessageId ? { sessionMessageId: record.sessionMessageId } : {}),
      ...(record.attachments ? { attachments: record.attachments } : {}),
      ...(record.priority !== undefined ? { priority: record.priority } : {}),
    }));
  }

  /**
   * Close one turn because its owner (Electron Main / the runtime) settled it.
   *
   * `ingest` only sees terminal *events*, and a real abort does not always
   * produce one that is allowed to land: Main drops a terminal event for a turn
   * it no longer owns (`isStaleTerminalEvent`), and the runtime need not emit one
   * at all. The Host would then keep the turn active and never release the queue
   * it holds, so the settlement itself closes the turn here. Idempotent: a turn
   * that is already terminal only retries the drain.
   */
  endTurn(
    sessionId: string,
    turnId: string,
    status: TurnRecord["status"],
    options: { error?: NonNullable<TurnRecord["error"]> } = {},
  ): void {
    const state = this.state(sessionId);
    const turn = state.turns.get(this.resolveTurnId(state, turnId));
    if (turn && isActive(turn.status)) {
      this.closeTurn(state, turn, {
        status,
        endedAt: new Date(this.clock.now()).toISOString(),
        ...(options.error ? { error: options.error } : {}),
        kind: turnEventKindForStatus(status),
        payload: {},
        meta: { turnId: turn.id },
      });
      return;
    }
    void this.drain(state.id);
  }

  /** Let the queue of an idle session run, e.g. after the runtime became free. */
  kick(sessionId: string): void {
    void this.drain(sessionId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Apply one terminal turn state, release everything that turn held, publish
   * it, and let the queue run. Both entry points — a terminal runtime event and
   * a settlement reported by the turn's owner — funnel through here.
   */
  private closeTurn(
    state: SessionState,
    turn: TurnRecord | undefined,
    outcome: {
      status: TurnRecord["status"];
      endedAt: string;
      error?: NonNullable<TurnRecord["error"]>;
      kind: Parameters<EventHub["publish"]>[0]["kind"];
      payload: Record<string, unknown>;
      meta: { turnId?: string; parentToolCallId?: string; agentName?: string };
    },
  ): void {
    if (turn) {
      turn.status = outcome.status;
      turn.endedAt = outcome.endedAt;
      if (outcome.error) turn.error = outcome.error;
    }
    if (turn === undefined || state.activeTurnId === turn.id) {
      state.activeTurnId = undefined;
    }
    state.activeItems.clear();
    state.status = "idle";
    for (const closed of this.approvals.cancelForSession(state.id, state.revision + 1)) {
      this.emit(state, "approval.resolved", closed, outcome.meta);
    }
    for (const [inputId] of state.pendingInputs) {
      state.pendingInputs.delete(inputId);
      this.emit(state, "input.resolved", { inputId, status: "canceled" }, outcome.meta);
    }
    this.emit(state, outcome.kind, outcome.payload, outcome.meta);
    this.emitSessionChanged(state);
    void this.drain(state.id);
  }

  private notifyQueue(sessionId: string): void {
    if (!this.onQueueChange) return;
    try {
      this.onQueueChange(sessionId, this.queueEntries(sessionId));
    } catch {
      // A listener failure must not affect the queue.
    }
  }

  private async drainAdmitted(sessionId: string): Promise<void> {
      while (true) {
        const state = this.state(sessionId);
        if (this.queue.isHeld(sessionId) || this.isOccupied(state)) return;
        const head = this.queue.peek(sessionId);
        const headTurn = head ? this.ensureQueuedTurn(state, head) : undefined;
        if (headTurn?.deliveryPending) return;
        if (headTurn?.deliveredIntoTurnId) {
          if (!(await this.removeDeliveredInput(state, headTurn.id))) return;
          continue;
        }
        const record = await this.queue.shift(sessionId);
        if (!record) return;
        const turn = this.ensureQueuedTurn(state, record);
        this.startingQueuedTurns.set(sessionId, turn);
        try {
          const started = await this.runtime.prompt({
            sessionId,
            content: record.content,
            ...(record.sessionMessageId ? { sessionMessageId: record.sessionMessageId } : {}),
            ...(record.userMessageId ? { userMessageId: record.userMessageId } : {}),
            ...(record.attachments ? { attachments: record.attachments } : {}),
            effectivePermissionMode: turn.effectivePermissionMode,
            ...(record.permissionCeiling ? { permissionCeiling: record.permissionCeiling } : {}),
            ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
            principal: { subject: record.principalSubject, roles: ["controller"] },
          });
          turn.runtimeTurnId = started.turnId;
          this.runtimeAliases.set(started.turnId, turn.id);
          if (!isActive(turn.status)) turn.status = "running";
          turn.queuePosition = undefined;
          turn.startedAt = turn.startedAt ?? new Date(this.clock.now()).toISOString();
          state.activeTurnId = turn.id;
          state.status = "running";
          this.renumberQueue(state);
          this.renumberQueue(state);
          this.notifyQueue(sessionId);
          // The rest of the promoted block joins this turn as user input, so the
          // messages stay adjacent instead of waiting for their own turns
          // (ADR 0265). A runtime without steering keeps the previous behavior.
          void this.deliverPromotedBlock(state, started.turnId);
          return;
        } catch (error) {
          turn.status = "failed";
          turn.endedAt = new Date(this.clock.now()).toISOString();
          turn.error = {
            code: (error as { code?: string }).code ?? "INTERNAL",
            message: error instanceof Error ? error.message : String(error),
            retriable: false,
            traceId: "",
          };
          this.emit(state, "turn.failed", { turn: this.toRacpTurn(state, turn) }, { turnId: turn.id });
          this.renumberQueue(state);
          this.notifyQueue(sessionId);
        } finally {
          this.startingQueuedTurns.delete(sessionId);
        }
      }
  }

  private async drain(sessionId: string): Promise<void> {
    if (this.draining.has(sessionId)) {
      // The pass already running may have decided to stop before this request
      // arrived — the session was still busy, or the queue had not been written
      // yet. Dropping the request here is what strands a queue, so remember it
      // and let the running pass take another look before it finishes.
      this.drainPending.add(sessionId);
      return;
    }
    this.draining.add(sessionId);
    try {
      do {
        this.drainPending.delete(sessionId);
        await this.withAdmission(sessionId, () => this.drainAdmitted(sessionId));
      } while (this.drainPending.has(sessionId));
    } finally {
      this.draining.delete(sessionId);
    }
  }

  /**
   * Deliver the promoted entries that are still queued into the turn that just
   * started, so "Send now" twice puts both messages in front of the model
   * together instead of spreading them over two turns (ADR 0265).
   *
   * The runtime only accepts input for a turn whose run is live, so a refusal is
   * retried a bounded number of times. Anything still undelivered stays queued
   * and leaves at the next boundary as its own turn: the previous behavior is
   * the fallback, never a lost prompt.
   */
  private async deliverPromotedBlock(state: SessionState, runtimeTurnId: string): Promise<void> {
    const steer = this.runtime.steer?.bind(this.runtime);
    if (!steer) return;
    for (let attempt = 0; attempt < PROMOTED_DELIVERY_ATTEMPTS; attempt += 1) {
      const head = await this.withAdmission(state.id, async () => {
        const record = this.queue.peek(state.id);
        if (!record || record.priority === undefined) return undefined;
        const active = state.activeTurnId ? state.turns.get(state.activeTurnId) : undefined;
        if (!active || active.runtimeTurnId !== runtimeTurnId) return undefined;
        const turn = this.ensureQueuedTurn(state, record);
        if (turn.deliveryPending || turn.deliveredIntoTurnId) return undefined;
        turn.deliveryPending = true;
        return record;
      });
      if (!head) return;
      let accepted = false;
      try {
        ({ accepted } = await steer({
          sessionId: state.id,
          turnId: runtimeTurnId,
          content: head.content,
          ...(head.sessionMessageId ? { sessionMessageId: head.sessionMessageId } : {}),
          ...(head.attachments ? { attachments: head.attachments } : {}),
          principal: { subject: head.principalSubject, roles: ["controller"] },
        }));
      } catch {
        // The runtime adapter reports transport failures; leave refused input queued.
        accepted = false;
      }
      const cleaned = await this.withAdmission(state.id, async () => {
        const turn = this.ensureTurn(state, head.id);
        turn.deliveryPending = false;
        if (!accepted) return true;
        // Record acceptance before persistence: failed cleanup is never cancellation.
        this.markDeliveredIntoAnotherTurn(state, head.id, runtimeTurnId);
        return this.removeDeliveredInput(state, head.id);
      });
      // Completion may have tried to drain while this input was reserved.
      void this.drain(state.id);
      if (!cleaned) return;
      if (!accepted) await delay(PROMOTED_DELIVERY_RETRY_MS);
    }
  }

  /** Keep accepted inputs out of execution even when durable cleanup fails. */
  private async removeDeliveredInput(state: SessionState, turnId: string): Promise<boolean> {
    try {
      await this.queue.remove(state.id, turnId);
      this.renumberQueue(state);
      this.notifyQueue(state.id);
      return true;
    } catch {
      this.emit(state, "turn.activity", {
        event: {
          type: "error",
          error: {
            code: "INTERNAL",
            message: "Delivered input could not be removed from the durable queue",
            retriable: true,
            traceId: "",
          },
        },
      }, { turnId });
      return false;
    }
  }

  /**
   * An injected entry never runs its own turn: its input was delivered into the
   * turn that was already running, and the transcript rows come from that turn's
   * steering messages. Its RACP turn is canceled so no client is left believing a
   * queued turn is still waiting.
   */
  private markDeliveredIntoAnotherTurn(state: SessionState, turnId: string, runtimeTurnId: string): void {
    const turn = state.turns.get(turnId);
    // A delivered entry is queued, not active: it never occupied the session, so
    // the check is "not already terminal" rather than `isActive`.
    if (!turn || isTerminal(turn.status)) return;
    turn.deliveredIntoTurnId = runtimeTurnId;
    turn.status = "canceled";
    turn.queuePosition = undefined;
    turn.endedAt = new Date(this.clock.now()).toISOString();
    this.emit(state, "turn.canceled", { turn: this.toRacpTurn(state, turn) }, { turnId: turn.id });
  }

  /** Keep busy checks and queue writes atomic across concurrent senders. */
  private async withAdmission<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.admissions.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.admissions.set(sessionId, settled);
    try {
      return await result;
    } finally {
      if (this.admissions.get(sessionId) === settled) this.admissions.delete(sessionId);
    }
  }

  private async cancelQueued(state: SessionState, turn: TurnRecord): Promise<RacpTurn> {
    if (turn.deliveryPending || turn.deliveredIntoTurnId) {
      throw racpError("CONFLICT", "the queued message has already started; use Stop to stop the running turn");
    }
    const removed = await this.queue.remove(state.id, turn.id);
    if (removed || turn.status === "queued") {
      turn.status = "canceled";
      turn.queuePosition = undefined;
      turn.endedAt = new Date(this.clock.now()).toISOString();
      this.emit(state, "turn.canceled", { turn: this.toRacpTurn(state, turn) }, { turnId: turn.id });
      this.renumberQueue(state);
      this.notifyQueue(state.id);
    }
    return this.toRacpTurn(state, turn);
  }

  private renumberQueue(state: SessionState): void {
    this.queue.list(state.id).forEach((record, index) => {
      const turn = state.turns.get(record.id);
      if (turn) turn.queuePosition = index + 1;
    });
  }

  private afterApproval(state: SessionState, turnId: string | undefined): void {
    const turn = turnId ? state.turns.get(turnId) : undefined;
    if (turn && turn.status === "waiting_approval" && this.approvals.list(state.id).length === 0) {
      turn.status = "running";
    }
    if (state.status === "waiting_permission" && this.approvals.list(state.id).length === 0) {
      state.status = state.activeTurnId ? "running" : "idle";
    }
  }

  private async syncPendingApprovals(state: SessionState): Promise<void> {
    await this.approvals.syncPendingTools(state.id, {
      turnId: state.activeTurnId ?? "",
      revision: state.revision,
      lifetimeMs: this.approvalLifetime(state),
      allowSession: this.allowRemoteSessionGrants,
    });
  }

  private approvalLifetime(state: SessionState): number {
    return state.remoteSubscribers > 0 ? this.policy.approvalLifetimeMs : this.localApprovalLifetimeMs;
  }

  private applyStatus(state: SessionState, status: AgentStatus): void {
    if (status.isRunning) {
      state.status = status.pendingToolConfirmations > 0 ? "waiting_permission" : "running";
    } else if (state.status === "running" || state.status === "waiting_permission") {
      state.status = "idle";
    }
    if (status.planningState) state.planningState = status.planningState;
  }

  private emit(
    state: SessionState,
    kind: Parameters<EventHub["publish"]>[0]["kind"],
    payload: unknown,
    meta: { turnId?: string; parentToolCallId?: string; agentName?: string },
  ): void {
    const durable = racpDurable(kind);
    if (durable) state.revision += 1;
    this.hub.publish({
      scope: "session",
      sessionId: state.id,
      ...(meta.turnId ? { turnId: meta.turnId } : {}),
      revision: state.revision,
      kind,
      ...(meta.parentToolCallId ? { parentToolCallId: meta.parentToolCallId } : {}),
      ...(meta.agentName ? { agentName: meta.agentName } : {}),
      payload: this.boundPayload(payload),
    });
  }

  private emitSessionChanged(state: SessionState): void {
    this.emit(state, "session.changed", { sessionId: state.id, status: state.status, planningState: state.planningState }, {});
    this.emitHostSessionChanged(state);
  }

  private emitHostSessionChanged(state: SessionState): void {
    this.hub.publish({
      scope: "host",
      sessionId: state.id,
      revision: state.revision,
      kind: "session.changed",
      payload: { sessionId: state.id, status: state.status, planningState: state.planningState },
    });
  }

  private boundPayload(payload: unknown): unknown {
    if (deltaStreamPayloadFits(payload, this.limits.maxFrameBytes)) return payload;
    const encoded = JSON.stringify(payload);
    if (encoded === undefined || encoded.length <= this.limits.maxFrameBytes) return payload;
    const record = (payload ?? {}) as { event?: { type?: string }; itemId?: string; itemType?: string };
    return {
      truncated: true,
      ...(record.itemType ? { itemType: record.itemType } : {}),
      ...(record.itemId ? { itemId: record.itemId } : {}),
      event: record.event ? { type: record.event.type } : undefined,
      preview: encoded.slice(0, 2_000),
    };
  }

  private itemFromEvent(
    event: AgentEvent,
    envelope: AgentEventEnvelope,
    turnId: string | undefined,
    status: "streaming" | "completed",
    itemType: RacpItemType,
  ): RacpItemSummary {
    let id: string;
    let content: unknown;
    switch (event.type) {
      case "message_start":
      case "message_end":
        id = event.message.id;
        content = event.message;
        break;
      case "tool_start":
        id = event.toolCallId;
        content = { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
        break;
      case "tool_end":
        id = event.toolCallId;
        content = { toolCallId: event.toolCallId, result: event.result, isError: event.isError ?? false };
        break;
      case "compaction_start":
        id = `compaction:${turnId ?? envelope.ts}`;
        content = { reason: event.reason };
        break;
      case "compaction_end":
        id = event.mark?.id ?? `compaction:${turnId ?? envelope.ts}`;
        content = { reason: event.reason, ok: event.ok, mark: event.mark };
        break;
      default:
        id = this.ids.next("item");
        content = event;
    }
    return {
      id,
      turnId: turnId ?? "",
      itemType,
      status,
      createdAt: new Date(envelope.ts).toISOString(),
      ...(envelope.parentToolCallId ? { parentToolCallId: envelope.parentToolCallId } : {}),
      ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
      content,
    };
  }

  private inputFromAsktool(
    request: AskToolRequest,
    state: SessionState,
    turnId: string,
    envelope: AgentEventEnvelope,
  ): RacpInputRequest {
    return {
      id: request.requestId,
      sessionId: state.id,
      turnId,
      expiresAt: new Date(this.clock.now() + this.approvalLifetime(state)).toISOString(),
      ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
      ...(envelope.parentToolCallId ? { parentToolCallId: envelope.parentToolCallId } : {}),
      questions: request.questions.map((question, index) => ({
        id: `${request.requestId}:${index}`,
        question: question.question,
        options: question.options,
        multiSelect: question.multiSelect ?? false,
      })),
    };
  }

  private toRacpSession(summary: SessionSummary, state: SessionState): RacpSession {
    return {
      id: summary.id,
      title: summary.title,
      ...(summary.projectId ? { projectId: summary.projectId } : {}),
      ...(summary.workspaceLabel ? { workspaceLabel: summary.workspaceLabel } : {}),
      mode: summary.mode,
      status: state.status,
      planningState: state.planningState,
      permissionMode: summary.permissionMode,
      ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}),
      queuedTurnIds: this.queue.list(summary.id).map((record) => record.id),
      revision: state.revision,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
    };
  }

  private toRacpTurn(state: SessionState, turn: TurnRecord): RacpTurn {
    const position = turn.status === "queued" ? this.queue.position(state.id, turn.id) : undefined;
    return {
      id: turn.id,
      sessionId: turn.sessionId,
      status: turn.status,
      admission: turn.admission,
      ...(position ? { queuePosition: position } : {}),
      effectivePermissionMode: turn.effectivePermissionMode,
      ...(turn.idempotencyKey ? { idempotencyKey: turn.idempotencyKey } : {}),
      ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
      ...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
      ...(turn.error ? { error: turn.error } : {}),
    };
  }

  private ensureTurn(state: SessionState, turnId: string): TurnRecord {
    let turn = state.turns.get(turnId);
    if (!turn) {
      turn = {
        id: turnId,
        sessionId: state.id,
        status: "queued",
        admission: "reject_if_busy",
        effectivePermissionMode: state.permissionMode,
      };
      state.turns.set(turnId, turn);
      this.turnIndex.set(turnId, state.id);
      while (state.turns.size > MAX_TURNS_PER_SESSION) {
        const oldest = state.turns.keys().next().value;
        if (oldest === undefined || oldest === state.activeTurnId) break;
        state.turns.delete(oldest);
        this.turnIndex.delete(oldest);
      }
    }
    return turn;
  }

  private ensureQueuedTurn(state: SessionState, record: QueuedTurnRecord): TurnRecord {
    const turn = this.ensureTurn(state, record.id);
    if (turn.status !== "queued" || turn.deliveryPending || turn.deliveredIntoTurnId) return turn;
    turn.admission = "queue";
    turn.queuePosition = this.queue.position(state.id, record.id);
    turn.effectivePermissionMode = record.permissionCeiling
      ? clampPermissionMode(record.effectivePermissionMode, record.permissionCeiling)
      : record.effectivePermissionMode;
    turn.idempotencyKey = record.idempotencyKey;
    turn.principalSubject = record.principalSubject;
    return turn;
  }

  private resolveTurnId(state: SessionState, runtimeTurnId: string): string {
    const alias = this.runtimeAliases.get(runtimeTurnId);
    if (alias) return alias;
    // prompt() can emit events before returning its runtime id. The starting
    // record has already left the queue; the new head belongs to another turn.
    const starting = this.startingQueuedTurns.get(state.id);
    if (starting && !starting.runtimeTurnId && !state.turns.has(runtimeTurnId)) {
      starting.runtimeTurnId = runtimeTurnId;
      this.runtimeAliases.set(runtimeTurnId, starting.id);
      return starting.id;
    }
    return runtimeTurnId;
  }

  private stateForTurn(turnId: string): SessionState {
    const sessionId = this.turnIndex.get(turnId);
    if (!sessionId) throw racpError("NOT_FOUND", `turn ${turnId} is unknown`);
    return this.state(sessionId);
  }

  private sessionOfResult(approvalId: string): string {
    for (const state of this.states.values()) {
      if (this.approvals.result(approvalId) && state.turns.size >= 0) return state.id;
    }
    throw racpError("NOT_FOUND", `approval ${approvalId} is unknown`);
  }

  private isBusy(state: SessionState): boolean {
    return this.isOccupied(state) || this.queue.size(state.id) > 0;
  }

  /** The session cannot start a turn right now, queue aside. */
  private isOccupied(state: SessionState): boolean {
    return (
      this.hasActiveTurn(state) ||
      state.planningState === "awaiting_approval" ||
      (this.runtime.isBusy?.(state.id) ?? false)
    );
  }

  private hasActiveTurn(state: SessionState): boolean {
    const turn = state.activeTurnId ? state.turns.get(state.activeTurnId) : undefined;
    return Boolean(turn && isActive(turn.status));
  }

  private rememberIdempotency(key: string, entry: IdempotencyEntry): void {
    this.idempotency.set(key, entry);
    while (this.idempotency.size > MAX_IDEMPOTENCY_ENTRIES) {
      const oldest = this.idempotency.keys().next().value;
      if (oldest === undefined) break;
      this.idempotency.delete(oldest);
    }
  }

  private requireRole(principal: Principal, operation: RacpOperation): void {
    if (!rolesAllowOperation(principal.roles, operation)) {
      throw racpError("FORBIDDEN", `principal lacks the role for ${operation}`);
    }
  }

  private async requireSession(sessionId: string): Promise<SessionSummary> {
    const summary = await this.sessions.get(sessionId);
    if (!summary) throw racpError("NOT_FOUND", `session ${sessionId} is unknown`);
    return summary;
  }

  private state(sessionId: string): SessionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        id: sessionId,
        revision: 0,
        status: "idle",
        planningState: "inactive",
        permissionMode: "ask",
        turns: new Map(),
        activeItems: new Map(),
        pendingInputs: new Map(),
        remoteSubscribers: 0,
      };
      this.states.set(sessionId, state);
    }
    return state;
  }
}

function isActive(status: RacpTurn["status"]): boolean {
  return RACP_ACTIVE_TURN_STATUSES.includes(status);
}

/** A turn that can no longer change: canceled or settled by its own run. */
function isTerminal(status: TurnRecord["status"]): boolean {
  return !isActive(status) && status !== "queued";
}

/** The RACP event kind that publishes one terminal turn state. */
function turnEventKindForStatus(
  status: RacpTurn["status"],
): Parameters<EventHub["publish"]>[0]["kind"] {
  switch (status) {
    case "completed":
      return "turn.completed";
    case "failed":
      return "turn.failed";
    case "interrupted":
      return "turn.interrupted";
    case "canceled":
      return "turn.canceled";
    default:
      throw new Error(`turn status ${status} is not terminal`);
  }
}

function racpDurable(kind: Parameters<EventHub["publish"]>[0]["kind"]): boolean {
  return kind !== "turn.activity" && kind !== "item.delta" && kind !== "tool.progress" && kind !== "terminal.output";
}

function highestRole(roles: RacpRole[]): RacpRole {
  if (roles.includes("owner")) return "owner";
  if (roles.includes("controller")) return "controller";
  if (roles.includes("approver")) return "approver";
  return "viewer";
}

function requireSessionId(sessionId: string | undefined): string {
  if (!sessionId) throw racpError("INVALID_ARGUMENT", "sessionId is required");
  return sessionId;
}

/** Small stable hash so a reused idempotency key with other input is detected. */
export function hashInput(input: StartTurnParams["input"]): string {
  const encoded = JSON.stringify({
    text: input.text,
    attachments: input.attachments ?? [],
    ...(input.sessionMessageId ? { sessionMessageId: input.sessionMessageId } : {}),
  });
  let hash = 5381;
  for (let index = 0; index < encoded.length; index += 1) {
    hash = ((hash << 5) + hash + encoded.charCodeAt(index)) | 0;
  }
  return `${encoded.length}:${(hash >>> 0).toString(16)}`;
}

export type { UiMessage };

/** Bounded attempts to fold a promoted entry into the turn that just started. */
const PROMOTED_DELIVERY_ATTEMPTS = 8;
/** Gap between those attempts: the runtime accepts input once its run is live. */
const PROMOTED_DELIVERY_RETRY_MS = 150;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
