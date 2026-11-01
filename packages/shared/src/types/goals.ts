/** Host-owned autonomous goals; approval artifacts retain their legacy types. */
export type GoalStatus = "active" | "paused" | "blocked" | "completed" | "budget_exhausted" | "cancelled";
/** null is an explicit unlimited turn budget, never an omitted required field. */
export type GoalBudget = { maxTurns: number | null; maxTokens?: number };
export const DEFAULT_GOAL_BUDGET: GoalBudget = { maxTurns: 20 };
export type GoalOutcome = { criterion: string; outcome: "met" | "unmet" | "unverified"; evidence: string };
/** Model-reported current-state audit, not independent host verification. */
export type GoalAuditItem = { requirement: string; outcome: "met" | "unmet" | "unverified"; evidence: string };
export type GoalAudit = { version: 1; objective: string; items: GoalAuditItem[]; remainingWork: string[] };
export type GoalReport = {
  progressSummary: string;
  status: "active" | "blocked" | "completed";
  outcomes: GoalOutcome[];
  /** Required for new completed reports; absent on legacy stored reports. */
  audit?: GoalAudit;
};
export type SessionGoal = {
  id: string;
  sessionId: string;
  revision: number;
  status: GoalStatus;
  objective: string;
  criteria: string[];
  progressSummary: string;
  roundsStarted: number;
  tokenUsage: number;
  /** Persisted accumulated active time, excluding pause/offline time. */
  elapsedSeconds?: number;
  /** Host timestamp for the current active interval, in Unix milliseconds. */
  activeSinceMs?: number;
  budget: GoalBudget;
  /** User changes queued until the claimed execution round settles. */
  pendingBudget?: GoalBudget;
  /** Finish the current round, then pause without interrupting it. */
  pauseRequested?: boolean;
  /** Scope frozen when the Host claims this round; display edits apply next round. */
  activeScope?: { objective: string; criteria: string[] };
  activeTurnId?: string;
  stopReason?: string;
  outcomes: GoalOutcome[];
  /** Required for new completed reports; absent on legacy stored reports. */
  audit?: GoalAudit;
};
/** Private host-to-runtime provenance. Never accepted from model tool arguments. */
export type GoalTurnContext = {
  goalId: string;
  turnId: string;
  provenance: "user-goal" | "goal-continuation";
};
/** Null with identity/revision is an ordered logical-removal tombstone. */
export type GoalResult = { goal: SessionGoal | null; goalId?: string; revision?: number };
export type GoalChangedEvent = GoalResult & { sessionId: string };
export type GoalControlRequest = {
  sessionId: string;
  goalId: string;
  expectedRevision: number;
  action: "pause" | "stop" | "resume" | "cancel" | "edit" | "budget" | "delete";
  /** User edits replace scope without pausing; existing evidence is reset. */
  objective?: string;
  budget?: GoalBudget;
};
export function goalCanResume(goal: SessionGoal): boolean {
  return !goal.activeTurnId && ["paused", "blocked", "budget_exhausted"].includes(goal.status);
}
export function goalIsTerminal(goal: SessionGoal): boolean {
  return goal.status === "completed" || goal.status === "cancelled";
}
