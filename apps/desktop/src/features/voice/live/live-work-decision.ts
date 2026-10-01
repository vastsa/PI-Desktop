import type { PlanProposal } from "@pi-desktop/shared";
import { headAsk, type AskQueues } from "../../../lib/pending-asks";
import { headPermission, type PermissionQueues } from "../../../lib/pending-permissions";

/**
 * A decision the bound Live work session is waiting for.
 *
 * Live Voice never answers or approves one of these: the existing session card
 * owns the decision (Live Voice Work Session spec). The live surfaces only have
 * to say *which* session waits and show what is being asked, so the user can
 * reach the card instead of hunting for it.
 */
export type LiveWorkDecision =
  | { kind: "ask"; sessionId: string; question: string; additionalQuestions: number }
  | { kind: "permission"; sessionId: string; toolName: string }
  | { kind: "plan"; sessionId: string; title: string }
  | { kind: "waiting"; sessionId: string };

/** Ask questions and plan titles are shown verbatim; keep them bounded. */
export const LIVE_WORK_DECISION_TEXT_LIMIT = 240;

function boundedText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, LIVE_WORK_DECISION_TEXT_LIMIT);
}

/**
 * The pending decision of one work session, read from the renderer queues.
 *
 * `awaiting` is the observed backend state (`waiting-input` /
 * `waiting-permission` on an operation of this call). It is the fallback for a
 * renderer that no longer holds the queue entry — a reload, or an ask that
 * arrived before the renderer subscribed — because the backend still knows the
 * session waits. Local queue entries win: they carry the actual question.
 */
export function liveWorkDecision(input: {
  sessionId: string | undefined;
  awaiting: boolean;
  asks: AskQueues;
  permissions: PermissionQueues;
  planCheckpoints: Record<string, PlanProposal>;
}): LiveWorkDecision | undefined {
  const sessionId = input.sessionId?.trim();
  if (!sessionId) return undefined;

  const ask = headAsk(input.asks, sessionId);
  if (ask) {
    return {
      kind: "ask",
      sessionId,
      question: boundedText(ask.questions[0]?.question),
      additionalQuestions: Math.max(0, ask.questions.length - 1),
    };
  }

  const permission = headPermission(input.permissions, sessionId);
  if (permission) {
    return { kind: "permission", sessionId, toolName: boundedText(permission.toolName) || "tool" };
  }

  const plan = input.planCheckpoints[sessionId];
  if (plan?.status === "pending") {
    return { kind: "plan", sessionId, title: boundedText(plan.title) };
  }

  return input.awaiting ? { kind: "waiting", sessionId } : undefined;
}

/** Whether any operation of this call reports the session waiting on the user. */
export function operationAwaitsDecision(
  operations: ReadonlyArray<{ workSessionId?: string; execution: string }> | undefined,
  sessionId: string | undefined,
): boolean {
  if (!sessionId) return false;
  return (operations ?? []).some(
    (operation) =>
      operation.workSessionId === sessionId &&
      (operation.execution === "waiting-input" || operation.execution === "waiting-permission"),
  );
}
