/**
 * Decoders for approved-plan execution records returned by host-core.
 * Every shape the host may hand back (bare record, `{ execution }`,
 * `{ executions: [] }`) is normalized into a typed PlanExecution or dropped.
 */
import {
  normalizeGlobalPermissionMode,
  normalizeProposalKind,
  type PlanExecution,
} from "@pi-desktop/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function planExecutionFromUnknown(value: unknown): PlanExecution | null {
  if (!isRecord(value)) return null;
  const artifact = isRecord(value.artifact) ? value.artifact : null;
  const state =
    value.state === "queued" ||
    value.state === "running" ||
    value.state === "completed" ||
    value.state === "interrupted"
      ? value.state
      : "queued";
  if (
    typeof value.id !== "string" ||
    typeof value.proposalId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.plan !== "string" ||
    typeof value.title !== "string" ||
    typeof value.question !== "string" ||
    !artifact ||
    typeof artifact.relativePath !== "string" ||
    typeof artifact.sha256 !== "string" ||
    typeof artifact.sizeBytes !== "number"
  ) {
    return null;
  }
  return {
    id: value.id,
    proposalId: value.proposalId,
    sessionId: value.sessionId,
    // Legacy queued rows predate the discriminator and are Plan by definition.
    kind: normalizeProposalKind(value.kind),
    plan: value.plan,
    title: value.title,
    question: value.question,
    artifact: {
      relativePath: artifact.relativePath,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
    },
    targetPermissionMode: normalizeGlobalPermissionMode(
      value.targetPermissionMode,
    ),
    state,
  };
}

export function executionFromResponse(value: unknown): PlanExecution | null {
  if (isRecord(value) && value.execution) {
    return planExecutionFromUnknown(value.execution);
  }
  return planExecutionFromUnknown(value);
}

export function executionListFromResponse(value: unknown): PlanExecution[] {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.executions)
      ? value.executions
      : [];
  return raw
    .map((candidate) => planExecutionFromUnknown(candidate))
    .filter((candidate): candidate is PlanExecution => candidate !== null);
}
