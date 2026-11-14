import type {
  GlobalPermissionMode,
  PlanProposal,
  PlanningStateEvent,
} from "@pi-desktop/shared";

/** Fail closed when no effective session permission is available. */
export const PLAN_APPROVAL_DEFAULT_MODE: GlobalPermissionMode = "ask";

export type PlanCheckpointStatus =
  | "pending"
  | "resolving"
  | "approved"
  | "queued"
  | "running"
  | "completed"
  | "rejected"
  | "expired"
  | "interrupted";

export function isPendingPlan(
  proposal: Pick<PlanProposal, "status"> | null | undefined,
): boolean {
  return proposal?.status === "pending";
}

export function isActivePlanExecution(
  proposal: Pick<PlanProposal, "executionState"> | null | undefined,
): boolean {
  return (
    proposal?.executionState === "queued" ||
    proposal?.executionState === "running"
  );
}

export function planCheckpointStatus(
  proposal: PlanProposal,
  resolving = false,
): PlanCheckpointStatus {
  if (resolving && proposal.status === "pending") return "resolving";
  if (proposal.status === "pending") return "pending";
  if (proposal.status === "approved") {
    if (proposal.executionState === "queued") return "queued";
    if (proposal.executionState === "running") return "running";
    if (proposal.executionState === "completed") return "completed";
    if (proposal.executionState === "interrupted") return "interrupted";
    return "approved";
  }
  if (proposal.status === "rejected") return "rejected";
  if (proposal.status === "expired") return "expired";
  return "interrupted";
}

function timestampFor(proposal: PlanProposal): number {
  const updated = Date.parse(proposal.updatedAt);
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(proposal.createdAt);
  return Number.isFinite(created) ? created : 0;
}

export function latestPlanProposal(
  proposals: readonly PlanProposal[],
  sessionId?: string,
): PlanProposal | undefined {
  return proposals
    .filter((proposal) => !sessionId || proposal.sessionId === sessionId)
    .reduce<PlanProposal | undefined>(
      (latest, proposal) =>
        !latest || timestampFor(proposal) >= timestampFor(latest)
          ? proposal
          : latest,
      undefined,
    );
}

/**
 * Host execution notifications may carry only the execution descriptor. Keep
 * that update attached to the last immutable proposal for its session so a
 * session switch never loses the latest Plan status.
 */
export function mergePlanCheckpoint(
  current: PlanProposal | undefined,
  event: PlanningStateEvent,
): PlanProposal | undefined {
  if (event.proposal) return event.proposal;
  if (!current) return undefined;
  if (event.proposalId && event.proposalId !== current.id) return current;

  const next: PlanProposal = { ...current };
  if (event.kind !== undefined) next.kind = event.kind;
  if (event.title !== undefined) next.title = event.title;
  if (event.question !== undefined) next.question = event.question;
  if (event.artifact !== undefined) next.artifact = event.artifact;
  if (event.version !== undefined) next.version = event.version;
  if (event.executionId !== undefined) next.executionId = event.executionId;
  if (event.executionState !== undefined) {
    next.executionState = event.executionState;
    if (current.status === "pending") {
      next.status = "approved";
      next.action = "approve";
    }
  }

  // A host state transition without a proposal still closes a pending row.
  // The exact terminal proposal is preferred whenever the host includes it.
  if (current.status === "pending" && event.state === "planning") {
    next.status = "interrupted";
  } else if (current.status === "pending" && event.state === "inactive") {
    next.status = "approved";
    next.action = "approve";
  }
  return next;
}

export function terminalizeMissingPlan(
  current: PlanProposal | undefined,
  state: PlanningStateEvent["state"] | undefined,
  now = Date.now(),
): PlanProposal | undefined {
  if (!current || current.status !== "pending") return current;
  const expiresAt = current.expiresAt ? Date.parse(current.expiresAt) : NaN;
  const status = Number.isFinite(expiresAt) && expiresAt <= now
    ? "expired"
    : state === "inactive"
      ? "approved"
      : "interrupted";
  return {
    ...current,
    status,
    ...(status === "approved" ? { action: "approve" as const } : {}),
    updatedAt: new Date(now).toISOString(),
  };
}
