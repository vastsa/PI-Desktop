/** Shared public types grouped by the owning application domain. */
export type Risk = "low" | "medium" | "high";
export type PermissionDecision = "allow-once" | "allow-session" | "deny";
export type ApprovalReviewer = "user" | "auto_review";
export type SessionApprovalReviewer = ApprovalReviewer | "inherit";
export type ReviewDecision = "allow_once" | "deny" | "needs_user";
export type PermissionReviewState = "user" | "awaiting_review" | "reviewing";

/** Host audit-derived review outcomes; separate from agent turn usage. */
export type PermissionReviewHistoryEntry = {
  requestId: string;
  sessionId: string;
  reviewedAt: number;
  decision: ReviewDecision;
  reason: string;
  toolCallId?: string;
  actorId?: string;
  toolName?: string;
  latencyMs?: number;
  decisionSource?: "auto_review";
  reviewerProviderId?: string;
  reviewerModelId?: string;
  usage?: import("./messages.js").MessageUsage;
};

export type PermissionReviewHistoryResult = { entries: PermissionReviewHistoryEntry[] };

export type AutoReviewBinding = {
  providerId?: string;
  modelId?: string;
  thinkingLevel?: import("./models.js").ThinkingLevel;
  /** Replaces the built-in reviewer policy; absent means use the default. */
  policyPrompt?: string;
};

export type SessionPermissionGrant = {
  id: string;
  sessionId: string;
  actorId: string;
  toolName: string;
  scope: "path" | "command" | "external";
  label: string;
};
/** Permission mode (D115): how high-risk tool calls are approved.
 * `inherit` (sessions only) falls back to the global default. */
export const PERMISSION_MODES = ["inherit", "ask", "accept-edits", "auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/** Global default: `inherit` is not meaningful at the settings level. */
export type GlobalPermissionMode = Exclude<PermissionMode, "inherit">;

export function isGlobalPermissionMode(
  value: unknown,
): value is GlobalPermissionMode {
  return value === "ask" || value === "accept-edits" || value === "auto";
}

export function normalizeGlobalPermissionMode(
  value: unknown,
  fallback: GlobalPermissionMode = "ask",
): GlobalPermissionMode {
  return isGlobalPermissionMode(value) ? value : fallback;
}
