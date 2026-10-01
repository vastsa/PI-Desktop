import { LiveWorkOperationLedger, type LiveWorkOperation } from "./operation-ledger.js";
import { parseLiveWorkIntent, type LiveWorkIntent, type LiveWorkQuestionAnswer } from "./intent.js";
import type {
  LiveWorkCancelQueuedOperationResult,
  LiveWorkSelectionOption,
  LiveWorkStopOperationResult,
  SessionSource,
} from "@pi-desktop/shared";

export function liveWorkUnselectedSessionId(callId: string): string {
  return `live-work-unselected:${callId}`;
}

export type WorkSnapshot = {
  sessionId: string;
  mode: "agent" | "plan" | "goal";
  state: "idle" | "running" | "waiting-permission" | "waiting-input" | "finalizing" | "unavailable";
  activeTurnId?: string;
  queue: Array<{ queueEntryId: string; position: number; summary: string }>;
  observedAt: number;
  source?: SessionSource;
  capabilities?: { steer: boolean; queue: boolean; cancelQueued: boolean };
};

export type WorkAdmission =
  | { status: "started"; turnId: string }
  | { status: "queued"; queueEntryId: string }
  | { status: "steered"; turnId: string };

export type WorkAdmissionLookup =
  | { kind: "not-found" }
  | { kind: "queued"; queueEntryId: string }
  | { kind: "running"; turnId: string }
  | { kind: "terminal"; turnId: string; status: "completed" | "failed" | "interrupted" | "canceled" }
  | { kind: "unavailable"; code: string };

export interface LiveWorkPort {
  snapshot(sessionId: string): Promise<WorkSnapshot>;
  observeTurnTarget(sessionId: string): string | null;
  lookupAdmission(input: { callId: string; sessionId: string; operationId: string; idempotencyKey: string; userMessageId: string }): Promise<WorkAdmissionLookup>;
  submit(input: { sessionId: string; text: string; userMessageId: string; voiceOrigin: { callId: string; operationId: string }; idempotencyKey: string }): Promise<WorkAdmission>;
  steer(input: { sessionId: string; expectedTurnId: string; text: string; userMessageId: string; voiceOrigin: { callId: string; operationId: string } }): Promise<{ accepted: boolean }>;
  enqueue(input: { sessionId: string; text: string; userMessageId: string; voiceOrigin: { callId: string; operationId: string }; idempotencyKey: string }): Promise<{ queueEntryId: string }>;
  stop(input: { callId: string; sessionId: string; expectedTurnId: string; urgency: "graceful" | "immediate" }): Promise<{ status: "requested" | "already-terminal" | "stale-target" | "unsupported"; message?: string }>;
  cancelQueued(input: { callId: string; sessionId: string; queueEntryId: string }): Promise<{ status: "canceled" | "already-delivered" | "not-found" | "unknown" | "unsupported" }>;
  respondInput(input: {
    callId: string;
    sessionId: string;
    answers: LiveWorkQuestionAnswer[];
  }): Promise<{ status: "resolved" | "rejected" | "unavailable"; message?: string; turnId?: string }>;
  listProjects(input: { callId: string; workBindingRevision: number; query?: string; action: "none" | "create" }): Promise<LiveWorkSelectionOption[]>;
  listSessions(input: { callId: string; workBindingRevision: number; query?: string }): Promise<LiveWorkSelectionOption[]>;
  openSelection(input: { callId: string; workBindingRevision: number; selectionRef: string }): Promise<{ status: "opened" | "ambiguous" | "expired" | "unavailable" }>;
  selectSession(input: { callId: string; workBindingRevision: number; selectionRef: string }): Promise<
    | { status: "selected"; sessionId: string; label: string; source: SessionSource }
    | { status: "ambiguous" | "expired" | "unavailable" }
  >;
}

export type LiveWorkCandidate = {
  callId: string;
  workBindingRevision: number;
  workSessionId: string;
  providerRequestId: string;
  instruction: string;
  observedTurnId?: string | null;
};

export type ProviderReceipt =
  | { status: "received"; operationId: string; providerRequestId: string; execution: "not_started" }
  | { status: "rejected"; providerRequestId: string; code: string };

export type LocalReceiptDelivery =
  | { status: "sent"; deliveryId: string }
  | { status: "not-sent" | "unknown"; deliveryId: string; code: string };

/**
 * The question a bound work session is waiting on, as far as the transport
 * could read it. It travels with the operation update so the voice surface can
 * read the question and its own options out, and so a spoken answer can be
 * checked against the question the user actually heard.
 */
export type LiveWorkPendingQuestion = {
  questions: Array<{ question: string; options: string[]; multiSelect: boolean }>;
};

export type LiveWorkOperationUpdate = {
  operation: LiveWorkOperation;
  intent?: LiveWorkIntent;
  message?: string;
  pendingQuestion?: LiveWorkPendingQuestion;
};

export type LiveWorkCoordinatorOptions = {
  resolveIntent: (input: {
    candidate: LiveWorkCandidate;
    snapshot: WorkSnapshot;
    recentOperations: Array<Pick<LiveWorkOperation, "operationId" | "instruction" | "admission" | "execution" | "selections">>;
    signal: AbortSignal;
  }) => Promise<unknown>;
  workPort: LiveWorkPort;
  onOperation?: (update: LiveWorkOperationUpdate) => void;
  onAnnouncementPolicy?: (input: { callId: string; policy: "normal" | "silent" }) => void;
  now?: () => number;
  classifyTimeoutMs?: number;
};

type CallState = {
  workSessionId: string;
  workBindingRevision: number;
  ledger: LiveWorkOperationLedger;
  tail: Promise<void>;
  controlTail: Promise<void>;
  closed: boolean;
  turnExecutions: Map<string, LiveWorkOperation["execution"]>;
  candidatePhases: Map<string, { sequence: number; phase: "pending" | "classifying" | "dispatching" }>;
  stopBarriers: Map<string, number>;
  hasWorkTarget: boolean;
  classifiers: Map<string, AbortController>;
  dispatchReaders: Set<AbortController>;
  snapshotReaders: Set<AbortController>;
  lookupReaders: Set<AbortController>;
  reconciliationTimers: Set<ReturnType<typeof setTimeout>>;
};

/**
 * Bounded call-scoped admission and intent routing. It records and routes work
 * through the supplied DesktopWorkPort; it does not own an Agent runtime.
 */
export class LiveWorkCoordinator {
  private readonly calls = new Map<string, CallState>();
  private readonly operationControlLocks = new Set<string>();
  private readonly now: () => number;
  private readonly classifyTimeoutMs: number;

  constructor(private readonly options: LiveWorkCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.classifyTimeoutMs = options.classifyTimeoutMs ?? 8_000;
  }

  openCall(input: { callId: string; workSessionId: string; workBindingRevision: number; hasWorkTarget?: boolean }): void {
    if (!input.callId || !input.workSessionId || !Number.isSafeInteger(input.workBindingRevision) || input.workBindingRevision < 1) {
      throw new Error("Live work scope is invalid");
    }
    this.calls.set(input.callId, {
      workSessionId: input.workSessionId,
      workBindingRevision: input.workBindingRevision,
      hasWorkTarget: input.hasWorkTarget ?? true,
      ledger: new LiveWorkOperationLedger(input),
      tail: Promise.resolve(),
      controlTail: Promise.resolve(),
      closed: false,
      turnExecutions: new Map(),
      candidatePhases: new Map(),
      stopBarriers: new Map(),
      classifiers: new Map(),
      dispatchReaders: new Set(),
      snapshotReaders: new Set(),
      lookupReaders: new Set(),
      reconciliationTimers: new Set(),
    });
  }

  async receiveCandidate(
    candidate: LiveWorkCandidate,
    deliverReceipt: (receipt: ProviderReceipt) => Promise<LocalReceiptDelivery>,
  ): Promise<void> {
    const call = this.calls.get(candidate.callId);
    if (!call || call.closed || call.workBindingRevision !== candidate.workBindingRevision || call.workSessionId !== candidate.workSessionId) {
      await deliverReceipt({ status: "rejected", providerRequestId: candidate.providerRequestId, code: "LIVE_WORK_NOT_BOUND" });
      return;
    }
    const registered = call.ledger.registerCandidate(candidate.providerRequestId, candidate.instruction, candidate.workSessionId);
    if (registered.status === "replayed") {
      return;
    }
    if (registered.status === "conflict") {
      await deliverReceipt({ status: "rejected", providerRequestId: candidate.providerRequestId, code: "LIVE_WORK_REQUEST_CONFLICT" });
      return;
    }
    if (registered.status === "capacity") {
      await deliverReceipt({ status: "rejected", providerRequestId: candidate.providerRequestId, code: "LIVE_WORK_CAPACITY_EXCEEDED" });
      return;
    }
    if (registered.status === "invalid") {
      await deliverReceipt({ status: "rejected", providerRequestId: candidate.providerRequestId, code: "LIVE_WORK_INVALID_REQUEST" });
      return;
    }

    const operation = registered.operation;
    call.candidatePhases.set(candidate.providerRequestId, { sequence: operation.sequence, phase: "pending" });
    candidate = {
      ...candidate,
      observedTurnId: candidate.observedTurnId === undefined
        ? this.options.workPort.observeTurnTarget(candidate.workSessionId)
        : candidate.observedTurnId,
    };
    call.ledger.update(candidate.providerRequestId, { admission: "reviewing" });
    this.publish(call, candidate.providerRequestId);
    let localReceipt: LocalReceiptDelivery;
    try {
      localReceipt = await deliverReceipt({
        status: "received",
        operationId: operation.operationId,
        providerRequestId: candidate.providerRequestId,
        execution: "not_started",
      });
    } catch {
      localReceipt = { status: "unknown", deliveryId: operation.operationId, code: "LIVE_WORK_FEEDBACK_UNDELIVERED" };
    }
    if (localReceipt.status !== "sent") {
      call.ledger.update(candidate.providerRequestId, {
        admission: "rejected",
        failureCode: "receipt-undelivered",
      });
      this.publish(call, candidate.providerRequestId, "The receipt could not be delivered; no work was dispatched.");
      call.candidatePhases.delete(candidate.providerRequestId);
      return;
    }

    const controlLane = isControlSchedulingHint(candidate.instruction);
    const lane = controlLane ? "controlTail" : "tail";
    const ordered = call[lane].then(async () => {
      try {
        await this.classifyAndRoute(call, candidate, controlLane);
      } catch {
        if (call.closed) return;
        const current = call.ledger.get(candidate.providerRequestId);
        if (!current || current.admission === "accepted" || current.admission === "rejected" || current.admission === "withdrawn") return;
        if (current.admission === "dispatching") {
          this.markDispatchUnknown(call, candidate.providerRequestId, "The Host result is unknown. Check the bound work session before taking further action.");
          if (current.intent && isWriteIntent(current.intent)) this.reconcileAdmission(call, candidate.providerRequestId);
          return;
        }
        this.reject(call, candidate.providerRequestId, "The work session could not complete this request.", "host-rejected");
      }
    });
    call[lane] = ordered.catch(() => undefined);
    try {
      await ordered;
    } finally {
      call.candidatePhases.delete(candidate.providerRequestId);
    }
  }

  closeCall(callId: string): void {
    const call = this.calls.get(callId);
    if (!call) return;
    call.closed = true;
    for (const controller of call.classifiers.values()) controller.abort(new Error("Live work call closed"));
    call.classifiers.clear();
    for (const controller of call.dispatchReaders) controller.abort(new Error("Live work call closed"));
    call.dispatchReaders.clear();
    for (const controller of call.snapshotReaders) controller.abort(new Error("Live work call closed"));
    call.snapshotReaders.clear();
    for (const controller of call.lookupReaders) controller.abort(new Error("Live work call closed"));
    call.lookupReaders.clear();
    for (const timer of call.reconciliationTimers) clearTimeout(timer);
    call.reconciliationTimers.clear();
    for (const operation of call.ledger.values()) {
      if (operation.admission === "dispatching") {
        call.ledger.update(operation.providerRequestId, { admission: "unknown", execution: "unknown", failureCode: "dispatch-unknown" });
        this.publish(call, operation.providerRequestId, "The call ended while Host admission was in progress. Check the bound work session; this operation was not resubmitted.");
      } else if (operation.admission === "received" || operation.admission === "reviewing") {
        call.ledger.update(operation.providerRequestId, { admission: "withdrawn", failureCode: "caller-withdrawn" });
        this.publish(call, operation.providerRequestId);
      }
    }
    this.calls.delete(callId);
  }

  getOperation(callId: string, operationId: string): LiveWorkOperation | undefined {
    return this.calls.get(callId)?.ledger.getByOperationId(operationId);
  }

  async stopOperation(input: { callId: string; operationId: string }): Promise<LiveWorkStopOperationResult> {
    return this.withOperationControl(`stop:${input.callId}:${input.operationId}`, { status: "unknown" }, async () => {
      const call = this.calls.get(input.callId);
      if (!call || call.closed) return { status: "stale-target" };
      const operation = call.ledger.getByOperationId(input.operationId);
      if (!operation?.turnId || !["running", "waiting-permission", "waiting-input"].includes(operation.execution)) {
        return { status: "already-terminal" };
      }
      const expectedTurnId = operation.turnId;
      const snapshot = await this.safeSnapshot(call, operation.workSessionId);
      if (call.closed) return { status: "stale-target" };
      if (!snapshot) return { status: "unknown" };
      if (snapshot.activeTurnId !== expectedTurnId || !isBusy(snapshot.state)) return { status: "already-terminal" };
      const result = await this.withDispatchTimeout(call, this.options.workPort.stop({
        callId: input.callId,
        sessionId: operation.workSessionId,
        expectedTurnId,
        urgency: "graceful",
      })).catch(() => null);
      if (call.closed) return { status: "stale-target" };
      return result ?? { status: "unknown" };
    });
  }

  async cancelQueuedOperation(input: { callId: string; operationId: string }): Promise<LiveWorkCancelQueuedOperationResult> {
    return this.withOperationControl(`cancel:${input.callId}:${input.operationId}`, { status: "unknown" }, async () => {
      const call = this.calls.get(input.callId);
      if (!call || call.closed) return { status: "stale-target" };
      const operation = call.ledger.getByOperationId(input.operationId);
      if (
        !operation?.queueEntryId || operation.execution !== "queued" ||
        operation.admission !== "accepted" || !operation.workSessionId
      ) return { status: "not-found" };
      const queueEntryId = operation.queueEntryId;
      const result = await this.withDispatchTimeout(call, this.options.workPort.cancelQueued({
        callId: input.callId,
        sessionId: operation.workSessionId,
        queueEntryId,
      })).catch(() => null);
      if (call.closed) return { status: "stale-target" };
      if (!result) return { status: "unknown" };
      if (result.status === "canceled") {
        const current = call.ledger.get(operation.providerRequestId);
        if (current?.execution === "queued" && current.queueEntryId === queueEntryId) {
          call.ledger.update(operation.providerRequestId, { execution: "canceled", admission: "withdrawn" });
          this.publish(call, operation.providerRequestId, "Queued work was canceled.");
        }
      }
      return result;
    });
  }

  listOperations(callId: string): LiveWorkOperation[] {
    return this.calls.get(callId)?.ledger.values() ?? [];
  }

  private async withOperationControl<T>(key: string, duplicateResult: T, action: () => Promise<T>): Promise<T> {
    if (this.operationControlLocks.has(key)) return duplicateResult;
    this.operationControlLocks.add(key);
    try {
      return await action();
    } finally {
      this.operationControlLocks.delete(key);
    }
  }

  findOperationByTurn(input: { sessionId: string; turnId: string; idempotencyKey?: string }): { callId: string; operationId: string } | undefined {
    for (const [callId, call] of this.calls) {
      const operation = call.ledger.values().find((candidate) =>
        candidate.workSessionId === input.sessionId &&
        (matchesTurn(candidate, input.turnId, input.idempotencyKey) || candidate.turnId === input.turnId),
      );
      if (operation) return { callId, operationId: operation.operationId };
    }
    return undefined;
  }

  reportTurnResult(input: {
    callId: string;
    operationId: string;
    summary: string;
    resultState?: "available" | "unavailable";
    sourceMessageId?: string;
  }): void {
    const call = this.calls.get(input.callId);
    const operation = call?.ledger.getByOperationId(input.operationId);
    if (!call || !operation) return;
    const summary = input.summary.slice(0, 480);
    if (!isWriteIntent(operation.intent)) return;
    const related = operation.turnId
      ? call.ledger.values().filter((item) => item.turnId === operation.turnId && isWriteIntent(item.intent))
      : [operation];
    for (const item of related) {
      call.ledger.update(item.providerRequestId, {
        resultSummary: summary,
        resultState: input.resultState ?? "available",
        ...(input.sourceMessageId ? { resultSourceMessageId: input.sourceMessageId } : {}),
      });
      this.publish(call, item.providerRequestId);
    }
  }

  reportTurnTerminal(input: {
    sessionId: string;
    runtimeTurnId: string;
    turnId: string;
    idempotencyKey?: string;
    status: "completed" | "failed" | "interrupted" | "canceled";
  }): void {
    const execution = input.status === "completed"
      ? "completed"
      : input.status === "failed"
        ? "failed"
        : input.status === "interrupted"
          ? "interrupted"
          : "canceled";
    for (const call of this.calls.values()) {
      rememberExecution(call, input.runtimeTurnId, execution, input.idempotencyKey);
      rememberExecution(call, input.turnId, execution, input.idempotencyKey);
    }
    for (const call of this.calls.values()) {
      for (const operation of call.ledger.values()) {
        if (
          operation.workSessionId !== input.sessionId ||
          (!matchesTurn(operation, input.runtimeTurnId, input.idempotencyKey) &&
            !matchesTurn(operation, input.turnId, input.idempotencyKey)) ||
          (!isInFlight(operation.execution) && operation.admission !== "dispatching" && operation.admission !== "unknown")
        ) continue;
        call.ledger.update(operation.providerRequestId, {
          admission: "accepted",
          execution,
          turnId: input.turnId,
          ...(isWriteIntent(operation.intent) ? { resultState: "pending" as const } : {}),
        });
        this.publish(call, operation.providerRequestId);
      }
    }
  }

  reportTurnStarted(input: { sessionId: string; turnId: string; idempotencyKey?: string }): void {
    for (const call of this.calls.values()) rememberExecution(call, input.turnId, "running", input.idempotencyKey);
    this.updateMatchingTurn(input.sessionId, input.turnId, "running", input.idempotencyKey);
  }

  reportTurnWaiting(input: { sessionId: string; turnId: string; state: "waiting-permission" | "waiting-input"; idempotencyKey?: string }): void {
    for (const call of this.calls.values()) rememberExecution(call, input.turnId, input.state, input.idempotencyKey);
    this.updateMatchingTurn(input.sessionId, input.turnId, input.state, input.idempotencyKey);
  }

  private async classifyAndRoute(call: CallState, candidate: LiveWorkCandidate, controlLane: boolean): Promise<void> {
    const operation = call.ledger.get(candidate.providerRequestId);
    if (!operation || call.closed) return;
    call.candidatePhases.set(candidate.providerRequestId, { sequence: operation.sequence, phase: "classifying" });
    const initial = call.hasWorkTarget
      ? await this.safeSnapshot(call, candidate.workSessionId)
      : emptyWorkSnapshot(candidate.workSessionId, this.now());
    if (call.closed) return;
    if (!initial || initial.sessionId !== candidate.workSessionId || initial.state === "unavailable") {
      this.reject(call, candidate.providerRequestId, "The selected work session is unavailable.");
      return;
    }
    const recentOperations = call.ledger.values()
      .filter((item) => item.providerRequestId !== candidate.providerRequestId)
      .slice(-8)
      .map(({ operationId, instruction, admission, execution, selections }) => ({ operationId, instruction, admission, execution, ...(selections ? { selections } : {}) }));
    const controller = new AbortController();
    call.classifiers.set(candidate.providerRequestId, controller);
    let classifierTimedOut = false;
    const rawIntent = await this.withTimeout(
      this.options.resolveIntent({ candidate, snapshot: initial, recentOperations, signal: controller.signal }),
      this.classifyTimeoutMs,
      controller,
    ).catch((error: unknown) => {
      classifierTimedOut = errorCode(error) === "LIVE_WORK_CLASSIFIER_TIMEOUT";
      return null;
    }).finally(() => call.classifiers.delete(candidate.providerRequestId));
    if (call.closed) return;
    const intent = parseLiveWorkIntent(rawIntent);
    if (!intent) {
      call.ledger.update(candidate.providerRequestId, {
        intent: { kind: "clarify", question: "I could not confirm what you want me to do. Please clarify." },
      });
      this.reject(
        call,
        candidate.providerRequestId,
        classifierTimedOut ? "Work classification timed out. Please try again." : "I could not confirm what you want me to do. Please clarify.",
        classifierTimedOut ? "classifier-timeout" : "classifier-invalid",
      );
      return;
    }
    if (call.closed) return;
    call.ledger.update(candidate.providerRequestId, { intent });
    if (controlLane && !isControlIntent(intent) && intent.kind !== "conversation" && intent.kind !== "clarify") {
      this.reject(call, candidate.providerRequestId, "I could not confirm a control request. Please clarify what you want me to stop or check.");
      return;
    }
    if (this.withdrawIfBehindStopBarrier(call, candidate, operation.sequence, intent)) return;
    if (intent.kind === "conversation") {
      this.acceptWithoutExecution(call, candidate.providerRequestId, "This is a Live conversation; no work was started.");
      return;
    }
    if (intent.kind === "clarify") {
      this.reject(call, candidate.providerRequestId, intent.question);
      return;
    }
    if (intent.kind === "speech-only") {
      this.options.onAnnouncementPolicy?.({ callId: candidate.callId, policy: intent.automaticAnnouncements });
      this.acceptWithoutExecution(call, candidate.providerRequestId, "Announcement preference updated for this call.");
      return;
    }
    if (intent.kind === "respond-input") {
      // A spoken answer resolves the session's own open question. It never
      // creates a turn and never approves a permission or Plan; the work port
      // re-checks every option label against that question before resolving.
      const result = await this.withDispatchTimeout(call, this.options.workPort.respondInput({
        callId: candidate.callId,
        sessionId: candidate.workSessionId,
        answers: intent.answers,
      })).catch(() => null);
      if (call.closed) return;
      if (result?.status === "resolved") {
        this.acceptControl(
          call,
          candidate.providerRequestId,
          result.message ?? "Answered the open question in the work session.",
          result.turnId ?? candidate.observedTurnId ?? "",
        );
      } else if (!result) {
        this.markDispatchUnknown(
          call,
          candidate.providerRequestId,
          "The answer result is unknown. The question may still be open; check the session before answering again.",
        );
      } else {
        this.reject(
          call,
          candidate.providerRequestId,
          result.message ?? "That answer was not accepted. Answer the question in the desktop.",
          "host-rejected",
        );
      }
      return;
    }
    if (intent.kind === "query-status" || intent.kind === "query-result" || intent.kind === "query-queue") {
      const fresh = await this.safeSnapshot(call, candidate.workSessionId);
      if (call.closed) return;
      if (!fresh) {
        this.reject(call, candidate.providerRequestId, "The bound work session status is unavailable.");
        return;
      }
      if (intent.kind === "query-result") {
        const target = intent.operationRef
          ? call.ledger.getByOperationId(intent.operationRef)
          : [...call.ledger.values()].reverse().find((item) => isWriteIntent(item.intent) && isTerminalExecution(item.execution));
        if (intent.operationRef && !target) {
          this.reject(call, candidate.providerRequestId, "That work result is not available in this call.");
          return;
        }
        const resultTarget = target && isWriteIntent(target.intent)
          ? target
          : target?.targetTurnId
            ? [...call.ledger.values()].reverse().find((item) => item.turnId === target.targetTurnId && isWriteIntent(item.intent))
            : undefined;
        this.acceptWithoutExecution(call, candidate.providerRequestId, formatResult(resultTarget));
        return;
      }
      if (intent.kind === "query-queue" && fresh.capabilities?.queue === false) {
      this.reject(call, candidate.providerRequestId, "This session backend does not provide a queue.");
      return;
    }
    if (intent.kind === "query-status" && intent.operationRef) {
        const target = call.ledger.getByOperationId(intent.operationRef);
        if (!target) {
          this.reject(call, candidate.providerRequestId, "That work operation is not available in this call.");
          return;
        }
        this.acceptWithoutExecution(call, candidate.providerRequestId, formatOperationStatus(target));
        return;
      }
      this.acceptWithoutExecution(call, candidate.providerRequestId, formatStatus(fresh, intent));
      return;
    }
    if (intent.kind === "stop-current") {
      const fresh = await this.safeSnapshot(call, candidate.workSessionId);
      if (call.closed) return;
      const expectedTurnId = candidate.observedTurnId;
      if (!fresh || !expectedTurnId || fresh.activeTurnId !== expectedTurnId || !isBusy(fresh.state)) {
        this.reject(call, candidate.providerRequestId, "The observed task has ended; nothing else was stopped.");
        return;
      }
      this.advanceStopBarrier(call, candidate.workSessionId, operation.sequence);
      call.candidatePhases.set(candidate.providerRequestId, { sequence: operation.sequence, phase: "dispatching" });
      const result = await this.withDispatchTimeout(call, this.options.workPort.stop({
        callId: candidate.callId,
        sessionId: candidate.workSessionId,
        expectedTurnId,
        urgency: intent.urgency,
      })).catch(() => null);
      if (call.closed) return;
      if (result?.status === "requested") this.acceptControl(call, candidate.providerRequestId, result.message ?? "Task stop requested.", expectedTurnId);
      else if (!result) this.markDispatchUnknown(call, candidate.providerRequestId, "The stop result is unknown. Check the task before taking further action.");
      else this.reject(call, candidate.providerRequestId, result.message ?? (result.status === "already-terminal" ? "The observed task has already ended." : "The stop request was not accepted."), "host-rejected");
      return;
    }
    if (intent.kind === "cancel-queued") {
      const target = call.ledger.getByOperationId(intent.operationRef);
      if (!target?.queueEntryId) {
        this.reject(call, candidate.providerRequestId, "That queued operation is not available to cancel.");
        return;
      }
      const result = await this.withDispatchTimeout(call, this.options.workPort.cancelQueued({
        callId: candidate.callId,
        sessionId: target.workSessionId,
        queueEntryId: target.queueEntryId,
      })).catch(() => null);
      if (call.closed) return;
      if (result?.status === "canceled") {
        call.ledger.update(target.providerRequestId, { execution: "canceled", admission: "withdrawn" });
        this.acceptWithoutExecution(call, candidate.providerRequestId, "Queued work was canceled.");
      } else if (!result) this.markDispatchUnknown(call, candidate.providerRequestId, "The queue cancellation result is unknown. Check queue status before taking further action.");
      else this.reject(call, candidate.providerRequestId, result.status === "unsupported"
        ? "This session backend does not support queue cancellation."
        : "That queued operation has already been delivered or is unavailable.", "host-rejected");
      return;
    }
    if (intent.kind === "list-projects" || intent.kind === "list-sessions") {
      const selections = intent.kind === "list-projects"
        ? await this.options.workPort.listProjects({
            callId: candidate.callId,
            workBindingRevision: candidate.workBindingRevision,
            ...(intent.query ? { query: intent.query } : {}),
            action: "none",
          })
        : await this.options.workPort.listSessions({
            callId: candidate.callId,
            workBindingRevision: candidate.workBindingRevision,
            ...(intent.query ? { query: intent.query } : {}),
          });
      if (call.closed) return;
      call.ledger.update(candidate.providerRequestId, { selections });
      this.acceptWithoutExecution(call, candidate.providerRequestId, selections.length
        ? "I found matching projects or sessions. Choose an item in the Live panel to open or use it."
        : "No matching projects or sessions were found.");
      return;
    }
    if (intent.kind === "select-session") {
      const selection = call.ledger.values().flatMap((item) => item.selections ?? [])
        .find((item) => item.kind === "session" && item.selectionRef === intent.selectionRef);
      if (!selection) {
        this.reject(call, candidate.providerRequestId, "That session choice expired. Ask to list sessions again.");
        return;
      }
      if (selection.duplicateLabel) {
        this.reject(call, candidate.providerRequestId, "Several sessions have the same label. Ask for a more specific session name.");
        return;
      }
      const selected = await this.options.workPort.selectSession({
        callId: candidate.callId,
        workBindingRevision: candidate.workBindingRevision,
        selectionRef: intent.selectionRef,
      });
      if (call.closed) return;
      if (selected.status !== "selected") {
        this.reject(call, candidate.providerRequestId, selected.status === "ambiguous"
          ? "Several sessions have the same label. Ask for a more specific session name."
          : "That session choice expired or is no longer available. Ask to list sessions again.");
        return;
      }
      call.workSessionId = selected.sessionId;
      call.hasWorkTarget = true;
      call.ledger.retarget(candidate.providerRequestId, selected.sessionId, selected.label, selected.source);
      this.acceptWithoutExecution(call, candidate.providerRequestId, `Selected ${selected.label}. The next work request will use this session.`);
      return;
    }
    if (intent.kind === "open-session") {
      const selection = call.ledger.values().flatMap((item) => item.selections ?? [])
        .find((item) => item.kind === "session" && item.selectionRef === intent.selectionRef);
      if (!selection) {
        this.reject(call, candidate.providerRequestId, "That session choice expired. Ask to list sessions again.");
        return;
      }
      if (selection.duplicateLabel) {
        this.reject(call, candidate.providerRequestId, "Several sessions have the same label. Choose the intended session in the Live panel.");
        return;
      }
      const result = await this.options.workPort.openSelection({
        callId: candidate.callId,
        workBindingRevision: candidate.workBindingRevision,
        selectionRef: intent.selectionRef,
      });
      if (call.closed) return;
      if (result.status === "opened") this.acceptWithoutExecution(call, candidate.providerRequestId, "Opened the selected session. The work call remains bound to its original session.");
      else if (result.status === "ambiguous") this.reject(call, candidate.providerRequestId, "Several sessions have the same label. Choose the intended session in the Live panel.");
      else this.reject(call, candidate.providerRequestId, "That session choice expired or is no longer available. Ask to list sessions again.");
      return;
    }
    if (intent.kind === "create-session") {
      const availableProjects = call.ledger.values().flatMap((item) => item.selections ?? [])
        .filter((item) => item.kind === "project");
      const selectedProject = intent.projectRef
        ? availableProjects.find((item) => item.selectionRef === intent.projectRef)
        : undefined;
      const selections = selectedProject
        ? [{ ...selectedProject, action: "create" as const }]
        : await this.options.workPort.listProjects({
            callId: candidate.callId,
            workBindingRevision: candidate.workBindingRevision,
            action: "create",
          });
      if (call.closed) return;
      call.ledger.update(candidate.providerRequestId, { selections });
      this.acceptWithoutExecution(call, candidate.providerRequestId, selections.length
        ? "Choose a registered project in the Live panel to create a session. This will not change the current work-call binding."
        : "No registered projects are available for a new session.");
      return;
    }

    const fresh = await this.safeSnapshot(call, candidate.workSessionId);
    if (call.closed) return;
    if (!fresh || fresh.mode !== "agent" || fresh.state === "finalizing" || fresh.state === "unavailable") {
      this.reject(call, candidate.providerRequestId, "The selected work session cannot accept this request now.");
      return;
    }
    if (call.closed) return;
    if (this.withdrawIfBehindStopBarrier(call, candidate, operation.sequence, intent)) return;
    call.ledger.update(candidate.providerRequestId, { admission: "dispatching" });
    call.candidatePhases.set(candidate.providerRequestId, { sequence: operation.sequence, phase: "dispatching" });
    this.publish(call, candidate.providerRequestId);
    try {
      if (intent.kind === "steer-current") {
        if (fresh.capabilities?.steer === false) {
          this.reject(call, candidate.providerRequestId, "This session backend cannot steer a running turn. Submit a separate task instead.", "host-rejected");
          return;
        }
        const expectedTurnId = candidate.observedTurnId;
        if (!expectedTurnId || fresh.activeTurnId !== expectedTurnId || !isBusy(fresh.state)) {
          this.reject(call, candidate.providerRequestId, "The observed task has ended; the addition was not sent.");
          return;
        }
        const result = await this.withDispatchTimeout(call, this.options.workPort.steer({
          sessionId: candidate.workSessionId,
          expectedTurnId,
          text: candidate.instruction,
          userMessageId: operation.userMessageId!,
          voiceOrigin: { callId: candidate.callId, operationId: operation.operationId },
        }));
        if (call.closed) return;
        if (!result.accepted) {
          this.reject(call, candidate.providerRequestId, "The observed task did not accept the addition.");
          return;
        }
        call.ledger.update(candidate.providerRequestId, {
          admission: "accepted",
          execution: rememberedExecution(call, expectedTurnId, voiceIdempotencyKey(candidate.callId, operation.operationId)) ?? "running",
          turnId: expectedTurnId,
        });
        this.publish(call, candidate.providerRequestId, "Addition delivered to the current task.");
        return;
      }
      const shouldQueue = intent.kind === "queue-task" || (intent.kind === "new-task" && isBusy(fresh.state) && intent.relationToActive === "independent");
      if (intent.kind === "new-task" && isBusy(fresh.state) && intent.relationToActive !== "independent") {
        this.reject(call, candidate.providerRequestId, "Should this be added to the current task or queued as separate work?");
        return;
      }
      if (shouldQueue) {
        if (fresh.capabilities?.queue === false) {
          this.reject(call, candidate.providerRequestId, "This session backend does not provide a work queue.", "host-rejected");
          return;
        }
        const result = await this.withDispatchTimeout(call, this.options.workPort.enqueue({
          sessionId: candidate.workSessionId,
          text: candidate.instruction,
          userMessageId: operation.userMessageId!,
          voiceOrigin: { callId: candidate.callId, operationId: operation.operationId },
          idempotencyKey: `voice:${candidate.callId}:${operation.operationId}`,
        }));
        if (call.closed) return;
        call.ledger.update(candidate.providerRequestId, { admission: "accepted", execution: "queued", queueEntryId: result.queueEntryId });
        this.publish(call, candidate.providerRequestId, "Work accepted by the Host queue.");
        return;
      }
      const result = await this.withDispatchTimeout(call, this.options.workPort.submit({
        sessionId: candidate.workSessionId,
        text: candidate.instruction,
        userMessageId: operation.userMessageId!,
        voiceOrigin: { callId: candidate.callId, operationId: operation.operationId },
        idempotencyKey: `voice:${candidate.callId}:${operation.operationId}`,
      }));
      if (call.closed) return;
      call.ledger.update(candidate.providerRequestId, {
        admission: "accepted",
        execution: result.status === "queued"
          ? "queued"
          : rememberedExecution(call, result.turnId, voiceIdempotencyKey(candidate.callId, operation.operationId)) ?? "running",
        ...(result.status === "queued" ? { queueEntryId: result.queueEntryId } : { turnId: result.turnId }),
      });
      this.publish(call, candidate.providerRequestId, result.status === "queued" ? "Work accepted by the Host queue." : "Work started in the bound session.");
    } catch (error) {
      if (call.closed) return;
      const code = errorCode(error);
      if (code && isKnownAdmissionRejection(code)) {
        this.reject(call, candidate.providerRequestId, rejectionMessage(code), code === "WORKSPACE_CHANGED" || code === "LIVE_WORK_SCOPE_CHANGED" ? "scope-changed" : "host-rejected");
        return;
      }
      this.markDispatchUnknown(call, candidate.providerRequestId, "The admission result is unknown. Do not submit this operation again.");
      this.reconcileAdmission(call, candidate.providerRequestId);
    }
  }

  private async safeSnapshot(call: CallState, sessionId: string): Promise<WorkSnapshot | null> {
    const controller = new AbortController();
    call.snapshotReaders.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const snapshot = await Promise.race([
        this.options.workPort.snapshot(sessionId),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            if (timer) call.reconciliationTimers.delete(timer);
            resolve(null);
          }, 2_000);
          call.reconciliationTimers.add(timer);
        }),
        new Promise<null>((resolve) => {
          onAbort = () => resolve(null);
          controller.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      return snapshot && snapshot.sessionId === sessionId && snapshot.state !== "unavailable" ? snapshot : null;
    } catch {
      return null;
    } finally {
      if (timer) {
        clearTimeout(timer);
        call.reconciliationTimers.delete(timer);
      }
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      call.snapshotReaders.delete(controller);
    }
  }

  private advanceStopBarrier(call: CallState, sessionId: string, sequence: number): void {
    const barrier = Math.max(call.stopBarriers.get(sessionId) ?? 0, sequence);
    call.stopBarriers.set(sessionId, barrier);
    for (const [providerRequestId, phase] of call.candidatePhases) {
      if (phase.sequence >= barrier) continue;
      const operation = call.ledger.get(providerRequestId);
      if (operation?.workSessionId !== sessionId || !operation.intent || !isWriteIntent(operation.intent)) continue;
      if (phase.phase === "dispatching") {
        if (operation.admission !== "dispatching") continue;
        call.ledger.update(providerRequestId, { admission: "unknown", execution: "unknown" });
        this.publish(call, providerRequestId, "Admission was still resolving when stop was requested; checking the Host result without resubmitting.");
        this.reconcileAdmission(call, providerRequestId);
        continue;
      }
      if (operation.admission === "accepted" || operation.admission === "rejected" || operation.admission === "withdrawn") continue;
      call.ledger.update(providerRequestId, { admission: "withdrawn", execution: "not-started", failureCode: "caller-withdrawn" });
      this.publish(call, providerRequestId, "Voice work received before the stop request was withdrawn before Host admission.");
    }
  }

  private withdrawIfBehindStopBarrier(
    call: CallState,
    candidate: LiveWorkCandidate,
    sequence: number,
    intent: LiveWorkIntent,
  ): boolean {
    if (!isWriteIntent(intent) || sequence >= (call.stopBarriers.get(candidate.workSessionId) ?? 0)) return false;
    const phase = call.candidatePhases.get(candidate.providerRequestId)?.phase;
    if (phase === "dispatching") return false;
    const current = call.ledger.get(candidate.providerRequestId);
    if (!current || current.admission === "withdrawn") return true;
    call.ledger.update(candidate.providerRequestId, { admission: "withdrawn", execution: "not-started", failureCode: "caller-withdrawn" });
    this.publish(call, candidate.providerRequestId, "Voice work received before the stop request was withdrawn before Host admission.");
    return true;
  }

  private reconcileAdmission(call: CallState, providerRequestId: string): void {
    const delays = [500, 1_500, 5_000, 10_000];
    const schedule = (attempt: number) => {
      if (call.closed || attempt >= delays.length) return;
      const timer = setTimeout(() => {
        call.reconciliationTimers.delete(timer);
        const operation = call.ledger.get(providerRequestId);
        if (call.closed || !operation || operation.admission !== "unknown") return;
        const controller = new AbortController();
        call.lookupReaders.add(controller);
        let lookupTimer: ReturnType<typeof setTimeout> | undefined;
        const lookupPromise = Promise.resolve().then(() => this.options.workPort.lookupAdmission({
          callId: operation.callId,
          sessionId: operation.workSessionId,
          operationId: operation.operationId,
          idempotencyKey: voiceIdempotencyKey(operation.callId, operation.operationId),
          userMessageId: operation.userMessageId!,
        }));
        const timedOut = new Promise<null>((resolve) => {
          const scheduledTimer = setTimeout(() => {
            call.reconciliationTimers.delete(scheduledTimer);
            resolve(null);
          }, 2_000);
          lookupTimer = scheduledTimer;
          call.reconciliationTimers.add(scheduledTimer);
        });
        let onAbort: (() => void) | undefined;
        const aborted = new Promise<null>((resolve) => {
          onAbort = () => resolve(null);
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        void Promise.race([lookupPromise, timedOut, aborted]).then((lookup) => {
          if (call.closed || controller.signal.aborted) return;
          if (lookup === null) {
            schedule(attempt + 1);
            return;
          }
          if (lookup.kind === "queued") {
            call.ledger.update(providerRequestId, { admission: "accepted", execution: "queued", queueEntryId: lookup.queueEntryId });
            this.publish(call, providerRequestId, "Work was found in the Host queue.");
            return;
          }
          if (lookup.kind === "running") {
            call.ledger.update(providerRequestId, { admission: "accepted", execution: "running", turnId: lookup.turnId });
            this.publish(call, providerRequestId, "The Host confirmed this work is running.");
            return;
          }
          if (lookup.kind === "terminal") {
            const execution = lookup.status;
            call.ledger.update(providerRequestId, { admission: "accepted", execution, turnId: lookup.turnId, resultState: "pending" });
            this.publish(call, providerRequestId, "The Host confirmed this work has ended; its result is being synchronized.");
            return;
          }
          schedule(attempt + 1);
        }).catch(() => schedule(attempt + 1)).finally(() => {
          if (lookupTimer) {
            clearTimeout(lookupTimer);
            call.reconciliationTimers.delete(lookupTimer);
          }
          if (onAbort) controller.signal.removeEventListener("abort", onAbort);
          call.lookupReaders.delete(controller);
        });
      }, delays[attempt]);
      call.reconciliationTimers.add(timer);
    };
    schedule(0);
  }

  private acceptWithoutExecution(call: CallState, providerRequestId: string, message: string): void {
    call.ledger.update(providerRequestId, {
      admission: "accepted",
      execution: "not-started",
      summary: message.slice(0, 480),
    });
    this.publish(call, providerRequestId, message);
  }

  private acceptControl(call: CallState, providerRequestId: string, message: string, targetTurnId: string): void {
    call.ledger.update(providerRequestId, { admission: "accepted", execution: "not-started", targetTurnId });
    this.publish(call, providerRequestId, message);
  }

  private reject(
    call: CallState,
    providerRequestId: string,
    message: string,
    failureCode?: LiveWorkOperation["failureCode"],
  ): void {
    call.ledger.update(providerRequestId, {
      admission: "rejected",
      execution: "not-started",
      ...(failureCode ? { failureCode } : {}),
    });
    this.publish(call, providerRequestId, message);
  }

  private markDispatchUnknown(call: CallState, providerRequestId: string, message: string): void {
    call.ledger.update(providerRequestId, { admission: "unknown", execution: "unknown", failureCode: "dispatch-unknown" });
    this.publish(call, providerRequestId, message);
  }

  private publish(call: CallState, providerRequestId: string, message?: string): void {
    if (message) {
      call.ledger.update(providerRequestId, { summary: message.slice(0, 480) });
    }
    const operation = call.ledger.get(providerRequestId);
    if (operation) this.options.onOperation?.({ operation, ...(operation.intent ? { intent: operation.intent } : {}), ...(message ? { message } : {}) });
  }

  private updateMatchingTurn(
    sessionId: string,
    turnId: string,
    execution: LiveWorkOperation["execution"],
    idempotencyKey?: string,
  ): void {
    for (const call of this.calls.values()) {
      for (const operation of call.ledger.values()) {
        if (
          !matchesTurn(operation, turnId, idempotencyKey) ||
          (!isInFlight(operation.execution) && operation.admission !== "dispatching" && operation.admission !== "unknown")
        ) continue;
        call.ledger.update(operation.providerRequestId, {
          ...(operation.admission === "dispatching" || operation.admission === "unknown" ? { admission: "accepted" as const } : {}),
          execution,
          turnId,
        });
        this.publish(call, operation.providerRequestId);
      }
    }
  }

  private withTimeout<T>(promise: Promise<T>, milliseconds: number, controller: AbortController): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (controller.signal.aborted) {
        reject(controller.signal.reason ?? new Error("Live work intent canceled"));
        return;
      }
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(controller.signal.reason ?? new Error("Live work intent canceled"));
      };
      timer = setTimeout(() => {
        const error = Object.assign(new Error("Live work intent timed out"), { code: "LIVE_WORK_CLASSIFIER_TIMEOUT" });
        controller.abort(error);
        reject(error);
      }, milliseconds);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => { cleanup(); resolve(value); },
        (error: unknown) => { cleanup(); reject(error); },
      );
    });
  }

  private async withDispatchTimeout<T>(call: CallState, promise: Promise<T>): Promise<T> {
    const controller = new AbortController();
    call.dispatchReaders.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("Live work dispatch timed out"), { code: "LIVE_WORK_DISPATCH_TIMEOUT" })), 2_000);
          call.reconciliationTimers.add(timer);
        }),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(controller.signal.reason ?? new Error("Live work call closed"));
          controller.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
        call.reconciliationTimers.delete(timer);
      }
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      call.dispatchReaders.delete(controller);
    }
  }
}

function emptyWorkSnapshot(sessionId: string, observedAt: number): WorkSnapshot {
  return { sessionId, mode: "agent", state: "idle", queue: [], observedAt };
}

function isBusy(state: WorkSnapshot["state"]): boolean {
  return state === "running" || state === "waiting-permission" || state === "waiting-input";
}

function isControlSchedulingHint(instruction: string): boolean {
  const text = instruction.trim().toLocaleLowerCase();
  return /^(?:please\s+)?(?:stop|cancel|abort)\s+(?:(?:the|my)\s+)?(?:current|active|running)\s+(?:task|work|turn)\b/u.test(text) ||
    /^(?:what(?:'s| is)\s+the\s+status|status\s+of\s+(?:the\s+)?(?:current|active|last|previous)\s+(?:task|work)|what\s+(?:happened|did\s+the\s+(?:task|work)\s+do)|show\s+(?:the\s+)?(?:task\s+)?result)\b/u.test(text) ||
    /^(?:请)?(?:停止|停掉|中止)(?:当前|正在运行的)?(?:任务|工作|会话)/u.test(text) ||
    /^(?:请)?(?:取消|撤销)(?:当前|正在运行的)?(?:任务|排队任务)/u.test(text) ||
    /^(?:查询|查看|告诉我)(?:当前|最近|刚才的)?(?:任务|工作)?(?:状态|结果|进展)/u.test(text);
}

function isControlIntent(intent: LiveWorkIntent): boolean {
  return intent.kind === "stop-current" || intent.kind === "cancel-queued" || intent.kind === "speech-only" ||
    intent.kind === "respond-input" ||
    intent.kind === "query-status" || intent.kind === "query-result" || intent.kind === "query-queue";
}

function isWriteIntent(intent: LiveWorkIntent | undefined): boolean {
  return intent?.kind === "new-task" || intent?.kind === "queue-task" || intent?.kind === "steer-current";
}

function isInFlight(execution: LiveWorkOperation["execution"]): boolean {
  return execution === "queued" || execution === "running" || execution === "waiting-permission" || execution === "waiting-input" || execution === "unknown";
}

function matchesTurn(operation: LiveWorkOperation, turnId: string, idempotencyKey?: string): boolean {
  return operation.turnId === turnId || operation.queueEntryId === turnId ||
    (idempotencyKey !== undefined && idempotencyKey === voiceIdempotencyKey(operation.callId, operation.operationId));
}

function voiceIdempotencyKey(callId: string, operationId: string): string {
  return `voice:${callId}:${operationId}`;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const record = error as { code?: unknown; errorCode?: unknown };
  if (typeof record.errorCode === "string") return record.errorCode;
  return typeof record.code === "string" ? record.code : undefined;
}

function isKnownAdmissionRejection(code: string | undefined): boolean {
  return code !== undefined && new Set([
    "AGENT_BUSY",
    "FORBIDDEN",
    "INVALID_PARAMS",
    "CONFLICT",
    "NOT_FOUND",
    "LIVE_WORK_NOT_READY",
    "LIVE_WORK_SESSION_UNAVAILABLE",
    "LIVE_WORK_BACKEND_UNSUPPORTED",
    "LIVE_WORK_SCOPE_CHANGED",
    "WORKSPACE_CHANGED",
    "LIVE_WORK_SELECTION_EXPIRED",
  ]).has(code);
}

function rejectionMessage(code: string): string {
  if (code === "AGENT_BUSY") return "The work session became busy before acceptance. Ask whether to add this to the active task or queue it separately.";
  if (code === "LIVE_WORK_SCOPE_CHANGED") return "The bound workspace changed. Start a new work call to authorize the current workspace.";
  if (code === "WORKSPACE_CHANGED") return "The bound workspace changed before Host admission. Start a new work call to authorize the current workspace.";
  if (code === "FORBIDDEN") return "The Host permission policy did not accept this work request.";
  return "The Host explicitly rejected this work request. Nothing was queued or started.";
}

function rememberExecution(
  call: CallState,
  turnId: string,
  execution: LiveWorkOperation["execution"],
  idempotencyKey?: string,
): void {
  const prior = call.turnExecutions.get(turnId);
  if (isTerminalExecution(prior) && !isTerminalExecution(execution)) return;
  call.turnExecutions.set(turnId, execution);
  if (idempotencyKey) {
    const idempotencyAlias = `idempotency:${idempotencyKey}`;
    const priorAlias = call.turnExecutions.get(idempotencyAlias);
    if (!isTerminalExecution(priorAlias) || isTerminalExecution(execution)) {
      call.turnExecutions.set(idempotencyAlias, execution);
    }
  }
  while (call.turnExecutions.size > 64) call.turnExecutions.delete(call.turnExecutions.keys().next().value as string);
}

function rememberedExecution(call: CallState, turnId: string, idempotencyKey: string): LiveWorkOperation["execution"] | undefined {
  return call.turnExecutions.get(`idempotency:${idempotencyKey}`) ?? call.turnExecutions.get(turnId);
}

function isTerminalExecution(execution: LiveWorkOperation["execution"] | undefined): boolean {
  return execution === "completed" || execution === "failed" || execution === "interrupted" || execution === "canceled";
}

function formatStatus(snapshot: WorkSnapshot, intent: LiveWorkIntent): string {
  if (intent.kind === "query-queue") {
    return snapshot.queue.length
      ? `There are ${snapshot.queue.length} queued work item${snapshot.queue.length === 1 ? "" : "s"}.`
      : "The Host work queue is empty.";
  }
  if (snapshot.state === "idle") return "The bound work session is idle.";
  if (snapshot.state === "running") return "The bound work session is running.";
  if (snapshot.state === "waiting-permission") return "The work session is waiting for a permission decision in the desktop UI.";
  if (snapshot.state === "waiting-input") return "The work session is waiting for input in the desktop UI.";
  return "The bound work session status is unavailable.";
}

function formatOperationStatus(operation: LiveWorkOperation): string {
  if (operation.execution === "queued") return "That work operation is queued.";
  if (operation.execution === "running") return "That work operation is running.";
  if (operation.execution === "waiting-permission") return "That work operation is waiting for a permission decision in the desktop UI.";
  if (operation.execution === "waiting-input") return "That work operation is waiting for input in the desktop UI.";
  if (isTerminalExecution(operation.execution)) return `That work operation is ${operation.execution}.`;
  if (operation.admission === "unknown") return "The admission result for that work operation is still unknown.";
  if (operation.admission === "rejected") return operation.summary ?? "That work operation was not accepted.";
  return "That work operation has not started.";
}

function formatResult(operation: LiveWorkOperation | undefined): string {
  if (!operation) return "No completed work result is recorded for this call.";
  if (!isWriteIntent(operation.intent)) return "That operation records a control request; its acknowledgement is separate from the task result.";
  if (!isTerminalExecution(operation.execution)) return "That work operation has not finished yet.";
  if (operation.resultSummary) return operation.resultSummary;
  if (operation.resultState === "unavailable") return `The task ended with status ${operation.execution}; its final result is unavailable.`;
  if (operation.resultState === "pending") return `The task ended with status ${operation.execution}; its result is still being synchronized.`;
  if (operation.execution === "completed") return "The task ended. Detailed results are available in the bound work session.";
  if (operation.execution === "failed") return "The task failed. The work session contains the error details.";
  if (operation.execution === "interrupted") return "The task was interrupted. Review any completed changes in the work session.";
  return "The task was canceled. Review any completed changes in the work session.";
}
