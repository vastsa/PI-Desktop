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
  effectiveRemotePermissionMode,
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
  attachments?: AgentPromptAttachment[];
};

export type StartTurnParams = {
  sessionId: string;
  idempotencyKey?: string;
  admission?: RacpTurnAdmission;
  input: { text: string; attachments?: AgentPromptAttachment[] };
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
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly draining = new Set<string>();

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
        if (turn) {
          turn.status = event.type === "error" ? "failed" : meta.interrupted ? "interrupted" : "completed";
          turn.endedAt = new Date(envelope.ts).toISOString();
          if (event.type === "error") {
            turn.error = { code: event.error.code, message: event.error.message, retriable: event.error.retriable ?? false, traceId: event.error.traceId ?? "" };
          }
        }
        state.activeItems.clear();
        state.activeTurnId = undefined;
        state.status = "idle";
        for (const closed of this.approvals.cancelForSession(state.id, state.revision + 1)) {
          this.emit(state, "approval.resolved", closed, meta2);
        }
        for (const [inputId] of state.pendingInputs) {
          state.pendingInputs.delete(inputId);
          this.emit(state, "input.resolved", { inputId, status: "canceled" }, meta2);
        }
        this.emit(state, mapping.kind, { event }, meta2);
        this.emitSessionChanged(state);
        void this.drain(state.id);
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
        if (item) item.content = event.type === "message_update" ? event.message : { ...(item.content as object), partialResult: event.partialResult };
        this.emit(state, mapping.kind, { itemType: mapping.itemType, itemId, event }, meta2);
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
    const effectivePermissionMode = effectiveRemotePermissionMode({
      sessionMode: summary.permissionMode,
      policy: this.policy,
      pairedDevice: principal.pairedDevice ?? false,
      approverOverride: principal.approverOverride ?? false,
    });
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
        ...(params.input.attachments ? { attachments: params.input.attachments } : {}),
        effectivePermissionMode,
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
        ...(params.input.attachments ? { attachments: params.input.attachments } : {}),
        effectivePermissionMode,
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
    if (turn.status === "queued") return this.cancelQueued(state, turn);
    if (isActive(turn.status)) await this.runtime.stop(state.id);
    return this.toRacpTurn(state, turn);
  }

  async interruptTurn(principal: Principal, turnId: string): Promise<RacpTurn> {
    this.requireRole(principal, "turn/interrupt");
    const state = this.stateForTurn(turnId);
    const turn = state.turns.get(turnId)!;
    if (turn.status === "queued") return this.cancelQueued(state, turn);
    if (isActive(turn.status)) await this.runtime.abort(state.id, turn.runtimeTurnId ?? turn.id);
    return this.toRacpTurn(state, turn);
  }

  async cancelTurn(principal: Principal, turnId: string): Promise<RacpTurn> {
    this.requireRole(principal, "turn/cancel");
    const state = this.stateForTurn(turnId);
    const turn = state.turns.get(turnId)!;
    if (turn.status !== "queued") {
      if (turn.status === "canceled") return this.toRacpTurn(state, turn);
      throw racpError("CONFLICT", "only a queued turn can be canceled");
    }
    return this.cancelQueued(state, turn);
  }

  /** Move a queued turn to the head of its session's queue ("send now"). */
  async prioritizeTurn(principal: Principal, turnId: string): Promise<RacpTurn> {
    this.requireRole(principal, "turn/prioritize");
    const state = this.stateForTurn(turnId);
    const turn = state.turns.get(turnId)!;
    if (turn.status !== "queued") {
      throw racpError("CONFLICT", "only a queued turn can be prioritized");
    }
    await this.queue.moveToHead(state.id, turn.id);
    this.renumberQueue(state);
    this.emit(state, "turn.queued", { turn: this.toRacpTurn(state, turn) }, { turnId: turn.id });
    this.notifyQueue(state.id);
    this.queue.resume(state.id);
    void this.drain(state.id);
    return this.toRacpTurn(state, turn);
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
      queuedTurns: this.queue.list(sessionId).map((record) => this.toRacpTurn(state, this.ensureTurn(state, record.id))),
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

  queuedTurns(sessionId: string): RacpTurn[] {
    return this.queueEntries(sessionId).map((entry) => entry.turn);
  }

  /** Queued turns with their prompts, in queue order. */
  queueEntries(sessionId: string): QueueEntryView[] {
    const state = this.state(sessionId);
    return this.queue.list(sessionId).map((record) => ({
      turn: this.toRacpTurn(state, this.ensureTurn(state, record.id)),
      content: record.content,
      ...(record.attachments ? { attachments: record.attachments } : {}),
    }));
  }

  /** Let the queue of an idle session run, e.g. after the runtime became free. */
  kick(sessionId: string): void {
    void this.drain(sessionId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private notifyQueue(sessionId: string): void {
    if (!this.onQueueChange) return;
    try {
      this.onQueueChange(sessionId, this.queueEntries(sessionId));
    } catch {
      // A listener failure must not affect the queue.
    }
  }

  private async drain(sessionId: string): Promise<void> {
    if (this.draining.has(sessionId)) return;
    this.draining.add(sessionId);
    try {
      while (true) {
        const state = this.state(sessionId);
        if (this.queue.isHeld(sessionId) || this.isOccupied(state)) return;
        const record = await this.queue.shift(sessionId);
        if (!record) return;
        const turn = this.ensureTurn(state, record.id);
        try {
          const started = await this.runtime.prompt({
            sessionId,
            content: record.content,
            ...(record.attachments ? { attachments: record.attachments } : {}),
            effectivePermissionMode: record.effectivePermissionMode,
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
          this.notifyQueue(sessionId);
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
        }
      }
    } finally {
      this.draining.delete(sessionId);
    }
  }

  private async cancelQueued(state: SessionState, turn: TurnRecord): Promise<RacpTurn> {
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

  private resolveTurnId(state: SessionState, runtimeTurnId: string): string {
    const alias = this.runtimeAliases.get(runtimeTurnId);
    if (alias) return alias;
    // A queued turn that started before its prompt() call returned: adopt
    // the runtime id for the head record so the two never diverge.
    const head = this.queue.peek(state.id);
    if (head && state.activeTurnId === undefined && !state.turns.has(runtimeTurnId) && this.draining.has(state.id)) {
      return head.id;
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
export function hashInput(input: { text: string; attachments?: AgentPromptAttachment[] }): string {
  const encoded = JSON.stringify({ text: input.text, attachments: input.attachments ?? [] });
  let hash = 5381;
  for (let index = 0; index < encoded.length; index += 1) {
    hash = ((hash << 5) + hash + encoded.charCodeAt(index)) | 0;
  }
  return `${encoded.length}:${(hash >>> 0).toString(16)}`;
}

export type { UiMessage };
