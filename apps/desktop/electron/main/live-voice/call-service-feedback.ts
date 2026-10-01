import type { LiveWorkFeedback, LiveWorkOperationView } from "@pi-desktop/shared";
import { LiveWorkFeedbackScheduler, type LiveWorkIntent, type LiveWorkPendingQuestion, type ScheduledLiveWorkFeedback } from "@pi-desktop/host-runtime";
import type { LiveReceiptDelivery } from "./types";
import { spokenQuestion } from "./spoken-answer";
import type { LiveCallServiceDeps, Slot } from "./call-service-internals";

type FeedbackStatus = "pending" | "sent" | "context-only" | "undelivered";

type Dependencies = {
  current: () => Slot | null;
  now: () => number;
  publish: (slot: Slot) => void;
  scheduleWake?: LiveCallServiceDeps["scheduleWorkFeedbackWake"];
  sendCodexFeedback: (slot: Slot, delegationId: string, feedback: LiveWorkFeedback) => Promise<LiveReceiptDelivery>;
};

/** Owns feedback scheduling and delivery independently of Live task execution. */
export class LiveWorkFeedbackManager {
  constructor(private readonly deps: Dependencies) {}

  notifyOperation(
    slot: Slot,
    operation: LiveWorkOperationView,
    delegationId?: string,
    resultSummary?: string,
    intent?: LiveWorkIntent,
    pendingQuestion?: LiveWorkPendingQuestion,
  ): void {
    if (delegationId) slot.workFeedbackTargets.set(operation.operationId, delegationId);
    const draft = feedbackDraft(operation, resultSummary, intent, pendingQuestion);
    if (!draft) return;

    const terminalKey = draft.kind === "result" && operation.turnId
      ? `terminal:${operation.turnId}:${operation.execution}`
      : undefined;
    if (terminalKey) {
      let relatedOperations = slot.workFeedbackTerminalOperations.get(terminalKey);
      if (!relatedOperations) {
        relatedOperations = new Set<string>();
        slot.workFeedbackTerminalOperations.set(terminalKey, relatedOperations);
      }
      relatedOperations.add(operation.operationId);
      const priorStatus = slot.workFeedbackTerminalStatuses.get(terminalKey);
      if (priorStatus) {
        slot.workFeedbackStatuses.set(operation.operationId, priorStatus);
        this.deps.publish(slot);
        return;
      }
      slot.workFeedbackTerminalStatuses.set(terminalKey, "pending");
    }

    const targetDelegationId = slot.workFeedbackTargets.get(operation.operationId);
    if (slot.binding?.adapterId === "codex-live" && !targetDelegationId) {
      this.recordStatus(slot, [operation.operationId], "undelivered");
      this.deps.publish(slot);
      return;
    }
    const enqueued = slot.workFeedbackScheduler.enqueue({
      operationId: operation.operationId,
      ...(targetDelegationId ? { delegationId: targetDelegationId } : {}),
      ...draft,
    });
    if (!enqueued) return;
    this.recordStatus(slot, [operation.operationId], "pending");
    this.deps.publish(slot);
    this.pump(slot);
  }

  setPolicy(callId: string, policy: "normal" | "silent"): void {
    const slot = this.deps.current();
    if (!slot || slot.callId !== callId || !slot.workScopeOpened) return;
    slot.workFeedbackScheduler.setPolicy(policy);
    this.pump(slot);
  }

  pump(slot: Slot): void {
    if (slot.workFeedbackTimer) {
      clearTimeout(slot.workFeedbackTimer);
      slot.workFeedbackTimer = undefined;
    }
    if (this.deps.current() !== slot || slot.phase !== "connected" || !slot.workScopeOpened) return;
    const localPlaybackIdle = slot.bridge
      ? slot.bridge.isPlaybackIdle()
      : slot.workScopeOpened && slot.binding?.adapterId === "codex-live"
        ? slot.playbackMonitorReady && !slot.assistantPlaybackActive
        : true;
    const idle = !slot.userSpeaking && !slot.assistantSpeaking && localPlaybackIdle;
    const scheduled = slot.workFeedbackScheduler.takeReady(this.deps.now(), idle);
    if (scheduled) {
      slot.workFeedbackScheduler.noteDispatched(this.deps.now(), scheduled.feedback.delivery);
      void this.deliver(slot, scheduled).finally(() => this.pump(slot));
      return;
    }
    const delay = slot.workFeedbackScheduler.nextDelay(this.deps.now(), idle);
    if (delay !== null && delay > 0) {
      slot.workFeedbackTimer = (this.deps.scheduleWake ?? setTimeout)(() => {
        slot.workFeedbackTimer = undefined;
        this.pump(slot);
      }, delay);
    }
  }

  clear(slot: Slot): void {
    if (slot.workFeedbackTimer) clearTimeout(slot.workFeedbackTimer);
    slot.workFeedbackTimer = undefined;
    slot.workFeedbackTargets.clear();
    slot.workFeedbackStatuses.clear();
    slot.workFeedbackTerminalOperations.clear();
    slot.workFeedbackTerminalStatuses.clear();
  }

  private async deliver(slot: Slot, scheduled: ScheduledLiveWorkFeedback): Promise<void> {
    const { feedback, operationIds, delegationId } = scheduled;
    if (
      this.deps.current() !== slot || slot.abort.signal.aborted || !slot.workScopeOpened ||
      feedback.callId !== slot.callId || feedback.workBindingRevision !== slot.workBindingRevision
    ) return;
    let status: Exclude<FeedbackStatus, "pending"> = "undelivered";
    try {
      const result = slot.binding?.adapterId === "codex-live"
        ? delegationId
          ? await this.deps.sendCodexFeedback(slot, delegationId, feedback)
          : { status: "not-sent" as const, deliveryId: feedback.feedbackId, code: "LIVE_WORK_FEEDBACK_UNDELIVERED" }
        : await slot.adapter?.appendWorkFeedback?.(feedback) ?? { status: "not-sent" as const, deliveryId: feedback.feedbackId, code: "LIVE_WORK_FEEDBACK_UNDELIVERED" };
      if (result.status === "sent") status = feedback.delivery === "context-only" ? "context-only" : "sent";
    } catch {
      status = "undelivered";
    }
    if (this.deps.current() !== slot) return;
    this.recordStatus(slot, operationIds, status);
    while (slot.workFeedbackStatuses.size > 256) slot.workFeedbackStatuses.delete(slot.workFeedbackStatuses.keys().next().value as string);
    this.deps.publish(slot);
  }

  private recordStatus(slot: Slot, operationIds: string[], status: FeedbackStatus): void {
    for (const operationId of operationIds) slot.workFeedbackStatuses.set(operationId, status);
    for (const [terminalKey, relatedOperations] of slot.workFeedbackTerminalOperations) {
      if (!operationIds.some((operationId) => relatedOperations.has(operationId))) continue;
      slot.workFeedbackTerminalStatuses.set(terminalKey, status);
      for (const operationId of relatedOperations) slot.workFeedbackStatuses.set(operationId, status);
    }
  }
}

function feedbackDraft(
  operation: LiveWorkOperationView,
  resultSummary?: string,
  intent?: LiveWorkIntent,
  pendingQuestion?: LiveWorkPendingQuestion,
): Omit<LiveWorkFeedback, "feedbackId" | "callId" | "workBindingRevision" | "operationId"> & {
  dedupeKey?: string;
  operationId?: string;
  speakWhenSilent?: boolean;
} | null {
  if (intent?.kind === "speech-only") return null;
  if (intent?.kind === "clarify") {
    return { kind: "clarification", delivery: "speak-when-idle", content: intent.question, speakWhenSilent: true };
  }
  if (intent?.kind === "conversation") {
    return {
      kind: "status",
      delivery: "speak-when-idle",
      content: "This was a voice conversation; no workspace task was started. Answer the user's original request directly.",
      speakWhenSilent: true,
    };
  }
  if (intent && ["query-status", "query-result", "query-queue", "stop-current", "cancel-queued", "open-session", "select-session", "respond-input"].includes(intent.kind)) {
    return operation.summary
      ? { kind: intent.kind === "query-result" ? "result" : "status", delivery: "speak-when-idle", content: operation.summary, speakWhenSilent: true }
      : null;
  }
  if (intent && ["list-projects", "list-sessions", "create-session"].includes(intent.kind)) {
    const labels = operation.selections?.map((selection) => selection.label).filter(Boolean) ?? [];
    const list = labels.length ? ` Available choices: ${labels.join("; ")}.` : "";
    return {
      kind: "status",
      delivery: "speak-when-idle",
      content: `${operation.summary ?? "The selection is ready in the Live panel."}${list}`,
      speakWhenSilent: true,
    };
  }
  if (operation.execution === "queued") {
    return { kind: "admission", delivery: "speak-when-idle", content: "The task is queued in the selected work session." };
  }
  if (operation.execution === "waiting-permission" || operation.execution === "waiting-input") {
    const question = operation.execution === "waiting-input" ? spokenQuestion(pendingQuestion) : null;
    return {
      kind: "interaction-required",
      delivery: "speak-when-idle",
      content: question ?? (operation.execution === "waiting-permission"
        ? "The work session is waiting for permission in the desktop. Review the pending request there."
        : "The work session is waiting for your input in the desktop. Continue there when ready."),
    };
  }
  if (["completed", "failed", "interrupted", "canceled"].includes(operation.execution) && resultSummary) {
    return {
      kind: "result",
      delivery: "speak-when-idle",
      content: resultSummary,
      ...(operation.turnId ? { dedupeKey: `terminal:${operation.turnId}:${operation.execution}` } : {}),
    };
  }
  return null;
}
