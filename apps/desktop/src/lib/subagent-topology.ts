import type { UiMessage } from "@pi-desktop/shared";
import type { AssistantActivityItem } from "./assistant-turns";
import {
  delegationLifecycleKind,
  getToolAction,
  isDelegationStartTool,
  type DelegationLifecycleKind,
} from "./tool-display";
import { toolResultPayload } from "./tool-presentation";

export type DelegationActivityItem = Extract<
  AssistantActivityItem,
  { kind: "tool" }
>;

export type SubagentOutcome =
  | "running"
  | "completed"
  | "truncated"
  | "timed_out"
  | "aborted"
  | "failed"
  | "stopped"
  | "denied";

export type SubagentTiming = {
  startedAt?: number;
  completedAt?: number;
};

export function isDelegationActivityItem(
  item: AssistantActivityItem,
): item is DelegationActivityItem {
  // Only the tool that STARTS a subagent is a delegation activity item (ADR
  // 0062): the lifecycle tools (TaskWait/TaskList/TaskStop, ADR 0089) drive an
  // existing delegation and must not inflate the topology's subagent counts.
  return (
    item.kind === "tool" &&
    isDelegationStartTool(item.message.toolName) &&
    getToolAction(item.message.toolName) === "delegate"
  );
}

const DELEGATION_STATUSES = new Set<SubagentOutcome>([
  "running",
  "completed",
  "truncated",
  "timed_out",
  "aborted",
  "failed",
  "stopped",
]);

function asDelegationStatus(value: unknown): SubagentOutcome | null {
  return DELEGATION_STATUSES.has(value as SubagentOutcome)
    ? (value as SubagentOutcome)
    : null;
}

/** TaskStop listed this row, so a `running` snapshot still means stopped. */
function stoppedEntryStatus(value: unknown): SubagentOutcome {
  const status = asDelegationStatus(value);
  return !status || status === "running" ? "stopped" : status;
}

function ingestLifecycleStatuses(
  statuses: Map<string, SubagentOutcome>,
  entries: unknown,
  fromStopped: boolean,
): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    const record = asRecord(entry);
    const id = record?.delegationId;
    const status = fromStopped
      ? stoppedEntryStatus(record?.status)
      : asDelegationStatus(record?.status);
    // Later rows win: a delegation reported running by an early TaskList is
    // settled by the TaskWait/TaskStop that follows it.
    if (typeof id === "string" && id && status) statuses.set(id, status);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function addTiming(
  timings: Map<string, SubagentTiming>,
  value: unknown,
): void {
  const record = asRecord(value);
  const delegationId = record?.delegationId;
  if (typeof delegationId !== "string" || !delegationId) return;
  const startedAt = timestamp(record?.startedAt);
  const completedAt = timestamp(record?.completedAt);
  if (startedAt === undefined && completedAt === undefined) return;
  const previous = timings.get(delegationId);
  timings.set(delegationId, {
    ...(previous?.startedAt !== undefined || startedAt !== undefined
      ? { startedAt: startedAt ?? previous?.startedAt }
      : {}),
    ...(previous?.completedAt !== undefined || completedAt !== undefined
      ? { completedAt: completedAt ?? previous?.completedAt }
      : {}),
  });
}

/**
 * Runtime timing for each delegation, including the initial `Task` start and
 * the later lifecycle snapshot that carries `completedAt`.
 *
 * A `Task` tool call ends as soon as the background delegate starts, so its
 * `toolDurationMs` is not the delegate's runtime. TaskList/TaskWait/TaskStop
 * repeat the registry timing and are the source of truth for settled nodes.
 */
export function collectDelegationTimings(
  items: readonly AssistantActivityItem[],
): ReadonlyMap<string, SubagentTiming> {
  const timings = new Map<string, SubagentTiming>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const payload = asRecord(toolResultPayload(item.message));
    if (!payload) continue;
    if (isDelegationActivityItem(item)) addTiming(timings, payload);
    const delegations = [
      ...(Array.isArray(payload.delegations) ? payload.delegations : []),
      ...(Array.isArray(payload.stopped) ? payload.stopped : []),
    ];
    for (const delegation of delegations) {
      addTiming(timings, delegation);
    }
  }
  return timings;
}

/**
 * Wall-clock span of one topology card, keyed by that card's own Task ids so
 * a later fan-out in the same turn cannot stretch an earlier card's elapsed
 * time. `completedAt` is omitted while any of those delegates is still running.
 */
export function delegationTimingBounds(
  items: readonly DelegationActivityItem[],
  timings: ReadonlyMap<string, SubagentTiming>,
): { startedAt?: number; completedAt?: number } {
  let startedAt: number | undefined;
  let completedAt: number | undefined;
  let pending = false;
  for (const item of items) {
    const payload = asRecord(toolResultPayload(item.message));
    const id = payload?.delegationId;
    if (typeof id !== "string" || !id) continue;
    const timing = timings.get(id);
    const start = timing?.startedAt ?? timestamp(payload?.startedAt);
    const end = timing?.completedAt ?? timestamp(payload?.completedAt);
    if (start !== undefined) {
      startedAt = startedAt === undefined ? start : Math.min(startedAt, start);
    }
    if (end === undefined) pending = true;
    else {
      completedAt = completedAt === undefined ? end : Math.max(completedAt, end);
    }
  }
  return {
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(!pending && completedAt !== undefined ? { completedAt } : {}),
  };
}

/**
 * Latest status per delegation id, read from the lifecycle tools' results.
 *
 * `Task` returns the moment the delegate starts (ADR 0089), so its own result
 * says `running` for the rest of the transcript no matter how the delegate
 * ended. TaskWait/TaskList report `details.delegations[]`; TaskStop reports
 * `details.stopped[]`. Those rows — which are deliberately not topology nodes —
 * are what tells a delegation card how its subagent actually finished.
 *
 * When `turnLive` is false the parent turn has ended, so any leftover
 * `running` node is reconstructed as `aborted` (the runtime aborts them at
 * run end). A `TaskStop` snapshot that still says `running` is `stopped`.
 */
export function collectDelegationStatuses(
  items: readonly AssistantActivityItem[],
  options?: { turnLive?: boolean },
): ReadonlyMap<string, SubagentOutcome> {
  const statuses = new Map<string, SubagentOutcome>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    // Read the row before the guard narrows `item` away: every tool item is a
    // potential delegation node, so excluding them leaves TS with `never`.
    const { message } = item;
    if (isDelegationActivityItem(item)) continue;
    const payload = asRecord(toolResultPayload(message));
    if (!payload) continue;
    ingestLifecycleStatuses(statuses, payload.delegations, false);
    ingestLifecycleStatuses(statuses, payload.stopped, true);
  }
  if (options?.turnLive === false) {
    for (const item of items) {
      if (item.kind !== "tool" || !isDelegationActivityItem(item)) continue;
      const payload = asRecord(toolResultPayload(item.message));
      const id = payload?.delegationId;
      if (typeof id !== "string" || !id) continue;
      const current = statuses.get(id);
      if (!current || current === "running") statuses.set(id, "aborted");
    }
  }
  return statuses;
}

/** One subagent named on a lifecycle row's roster (ADR 0089). */
export type DelegationRosterEntry = {
  delegationId: string;
  agentName: string;
  status: SubagentOutcome;
  durationMs?: number;
};

/**
 * The subagents a lifecycle row reports on, in the order the runtime listed
 * them.
 *
 * `TaskWait`/`TaskList` report `details.delegations[]` and `TaskStop` reports
 * `details.stopped[]`; both carry the agent name and status, which is what a
 * reader needs. Without this the row could only show its `delegationIds`
 * argument, which is a list of bare UUIDs (D268).
 */
export function delegationRoster(
  message: UiMessage,
): DelegationRosterEntry[] {
  if (!delegationLifecycleKind(message.toolName)) return [];
  const payload = asRecord(toolResultPayload(message));
  if (!payload) return [];
  const roster: DelegationRosterEntry[] = [];
  const pushEntries = (entries: unknown, fromStopped: boolean) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const record = asRecord(entry);
      const delegationId = record?.delegationId;
      if (typeof delegationId !== "string" || !delegationId) continue;
      const agent = record?.agent;
      const startedAt = timestamp(record?.startedAt);
      const completedAt = timestamp(record?.completedAt);
      roster.push({
        delegationId,
        agentName: typeof agent === "string" ? agent : "",
        status: fromStopped
          ? stoppedEntryStatus(record?.status)
          : (asDelegationStatus(record?.status) ?? "running"),
        ...(startedAt !== undefined && completedAt !== undefined
          ? { durationMs: Math.max(0, completedAt - startedAt) }
          : {}),
      });
    }
  };
  pushEntries(payload.delegations, false);
  pushEntries(payload.stopped, true);
  return roster;
}

/**
 * What a lifecycle row should say in one line: the subagents it reports on, by
 * name, deduplicated so a repeated agent is counted rather than listed twice.
 */
export function delegationRosterSummary(
  roster: readonly DelegationRosterEntry[],
): string {
  if (roster.length === 0) return "";
  const counts = new Map<string, number>();
  for (const entry of roster) {
    if (!entry.agentName) continue;
    counts.set(entry.agentName, (counts.get(entry.agentName) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(", ");
}

/** Roster status rolled up for the row's own badge. */
export function delegationRosterOutcome(
  roster: readonly DelegationRosterEntry[],
): SubagentOutcome | null {
  if (roster.length === 0) return null;
  if (roster.some((entry) => entry.status === "running")) return "running";
  const failed = roster.find(
    (entry) => entry.status === "failed" || entry.status === "denied",
  );
  if (failed) return failed.status;
  const warned = roster.find((entry) => entry.status !== "completed");
  return warned ? warned.status : "completed";
}

export function lifecycleKindOf(
  message: UiMessage,
): DelegationLifecycleKind | null {
  return delegationLifecycleKind(message.toolName);
}

export function subagentOutcome(
  message: UiMessage,
  statuses?: ReadonlyMap<string, SubagentOutcome>,
): SubagentOutcome {
  const payload = asRecord(toolResultPayload(message));
  if (payload) {
    const delegationId = payload.delegationId;
    if (typeof delegationId === "string") {
      const settled = statuses?.get(delegationId);
      if (settled) return settled;
    }
    const status = asDelegationStatus(payload.status);
    if (status) return status;
  }
  if (message.toolStatus === "running") return "running";
  if (message.toolStatus === "error") return "failed";
  if (message.toolStatus === "denied") return "denied";
  return "completed";
}

export function summarizeSubagentActivity(
  items: readonly DelegationActivityItem[],
  statuses?: ReadonlyMap<string, SubagentOutcome>,
) {
  const outcomes = items.map((item) => subagentOutcome(item.message, statuses));
  return {
    total: outcomes.length,
    finished: outcomes.filter((outcome) => outcome !== "running").length,
    running: outcomes.filter((outcome) => outcome === "running").length,
    issues: outcomes.filter(
      (outcome) => outcome === "failed" || outcome === "denied",
    ).length,
    warnings: outcomes.filter(
      (outcome) =>
        outcome === "truncated" ||
        outcome === "timed_out" ||
        outcome === "aborted" ||
        outcome === "stopped",
    ).length,
  };
}
