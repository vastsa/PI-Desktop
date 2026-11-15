import { Type } from "typebox";
import type { ModeCompletionReport } from "@pi-desktop/shared";

/** Same bounds are independently enforced at the Host RPC boundary. */
const MAX_ITEMS = 64;
const MAX_CRITERION_BYTES = 4096;
const MAX_EVIDENCE_BYTES = 16 * 1024;
const MAX_REPORT_BYTES = 256 * 1024;

export const completionReportSchema = Type.Object({
  status: Type.Union([Type.Literal("completed"), Type.Literal("blocked")]),
  outcomes: Type.Array(Type.Object({
    criterion: Type.String({ description: "An acceptance criterion from the original authorized task." }),
    outcome: Type.Union([Type.Literal("met"), Type.Literal("unmet"), Type.Literal("unverified")]),
    evidence: Type.String({ description: "Fresh evidence, or what prevents verification; never invent a passing check." }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_ITEMS }),
  remainingWork: Type.Array(Type.String(), { maxItems: MAX_ITEMS }),
  blockerReason: Type.Optional(Type.String({ description: "Required for blocked: why no authorized work can currently proceed." })),
}, { additionalProperties: false });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= limit;
}

/** Validate submitted evidence, not the truth of a model's assertions. */
export function parseCompletionReport(value: unknown): ModeCompletionReport | string {
  if (!record(value)) return "report must be an object";
  if (Object.keys(value).some((key) => !["status", "outcomes", "remainingWork", "blockerReason"].includes(key))) return "unknown report field";
  if (value.status !== "completed" && value.status !== "blocked") return "report status must be completed or blocked";
  if (!Array.isArray(value.outcomes) || value.outcomes.length < 1 || value.outcomes.length > MAX_ITEMS) return "report requires 1 to 64 criterion outcomes";
  const outcomes: ModeCompletionReport["outcomes"] = [];
  const criteria = new Set<string>();
  for (const item of value.outcomes) {
    if (!record(item) || Object.keys(item).some((key) => !["criterion", "outcome", "evidence"].includes(key))) return "invalid report outcome fields";
    if (!text(item.criterion, MAX_CRITERION_BYTES)) return "report criterion must be nonblank and at most 4 KiB";
    if (criteria.has(item.criterion.trim())) return "report criteria must be unique";
    criteria.add(item.criterion.trim());
    if (item.outcome !== "met" && item.outcome !== "unmet" && item.outcome !== "unverified") return "invalid criterion outcome";
    if (!text(item.evidence, MAX_EVIDENCE_BYTES)) return "report evidence must be nonblank and at most 16 KiB";
    outcomes.push({ criterion: item.criterion, outcome: item.outcome, evidence: item.evidence });
  }
  if (!Array.isArray(value.remainingWork) || value.remainingWork.length > MAX_ITEMS
    || !value.remainingWork.every((item) => text(item, MAX_CRITERION_BYTES))) return "remainingWork must contain at most 64 nonblank items of at most 4 KiB";
  if (value.blockerReason !== undefined && !text(value.blockerReason, MAX_EVIDENCE_BYTES)) return "blockerReason must be nonblank and at most 16 KiB";
  if (value.status === "completed" && (outcomes.some((item) => item.outcome !== "met") || value.remainingWork.length || value.blockerReason !== undefined)) {
    return "completed report requires all criteria met, no remaining work, and no blocker";
  }
  if (value.status === "blocked" && (!value.blockerReason || (outcomes.every((item) => item.outcome === "met") && !value.remainingWork.length))) {
    return "blocked report requires a blockerReason and unfinished or unverified work";
  }
  const report: ModeCompletionReport = {
    status: value.status, outcomes, remainingWork: value.remainingWork,
    ...(typeof value.blockerReason === "string" ? { blockerReason: value.blockerReason } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_REPORT_BYTES) return "report exceeds 256 KiB";
  return report;
}
