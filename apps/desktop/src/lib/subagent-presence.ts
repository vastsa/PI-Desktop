import type { UiMessage } from "@pi-desktop/shared";
import { delegationIdForMessage } from "./subagent-panel";
import { collectDelegationStatuses, collectDelegationTimings, delegationIsCreating, isDelegationActivityItem, subagentOutcome } from "./subagent-topology";
import { delegationLifecycleKind, getToolSummary, isDelegationStartTool } from "./tool-display";
import { toolResultPayload } from "./tool-presentation";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export type PresenceStatus = "queued" | "running" | "completed" | "failed" | "stopped";
export interface SubagentPresenceItem {
  id: string;
  agent: string;
  status: PresenceStatus;
  task: string;
  detail: string;
  model: string;
  startedAt: number | null;
  completedAt: number | null;
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}
export function isActiveDelegate(item: SubagentPresenceItem) {
  return item.status === "running" || item.status === "queued";
}

/** Inspect the current root turn only. A steering message does not start a new turn. */
export function projectSubagentPresence(messages: readonly UiMessage[]): SubagentPresenceItem[] {
  let start = messages.length;
  while (start > 0) {
    const m = messages[--start];
    if (m.role === "user" && !m.parentToolCallId && !m.steering) break;
  }
  const tools = [];
  const children = new Map<string, UiMessage[]>();
  const snapshots = new Map<string, Record<string, unknown>>();
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (m.parentToolCallId) {
      const rows = children.get(m.parentToolCallId);
      if (rows) rows.push(m); else children.set(m.parentToolCallId, [m]);
    } else if (m.role === "tool" && (isDelegationStartTool(m.toolName) || delegationLifecycleKind(m.toolName))) {
      tools.push({kind: "tool" as const, message: m});
      const payload = record(toolResultPayload(m));
      for (const list of [payload.delegations, payload.stopped]) {
        if (Array.isArray(list)) for (const entry of list) {
          const row = record(entry);
          if (typeof row.delegationId === "string") snapshots.set(row.delegationId, row);
        }
      }
    }
  }
  const statuses = collectDelegationStatuses(tools);
  const timings = collectDelegationTimings(tools);
  const items = tools.filter(isDelegationActivityItem).map(({message: m}): SubagentPresenceItem => {
    const id = delegationIdForMessage(m);
    const payload = record(toolResultPayload(m));
    const args = record(m.toolArgs);
    const snapshot = snapshots.get(id);
    const rows = children.get(m.toolCallId ?? m.id) ?? [];
    const assistants = rows.filter(row => row.role === "assistant");
    const latest = rows.at(-1);
    const outcome = subagentOutcome(m, statuses);
    const status = outcome === "running" ? (delegationIsCreating(m) ? "queued" : "running")
      : outcome === "aborted" || outcome === "stopped" ? "stopped" : outcome === "completed" ? "completed" : "failed";
    let inputTokens: number | null = null, outputTokens: number | null = null;
    for (const row of assistants) if (row.usage) {
      inputTokens = (inputTokens ?? 0) + row.usage.inputTokens;
      outputTokens = (outputTokens ?? 0) + row.usage.outputTokens;
    }
    const usage = record(payload.usage);
    const turnCount = Math.max(count(snapshot?.turns) ?? -1, count(payload.turns) ?? -1, assistants.length || -1);
    return {
      id, agent: text(payload.agent) || text(args.agent) || text(latest?.agentName), status,
      task: text(args.description) || text(args.task),
      detail: text(record(payload.error).message) || text(payload.report) ||
        (latest?.role === "tool" ? [latest.toolName, getToolSummary(latest.toolName, latest.toolArgs)].filter(Boolean).join(" · ") : text(latest?.content)) || text(snapshot?.lastToolName),
      model: text(payload.modelId) || text(assistants.at(-1)?.modelId) || text(args.model),
      startedAt: timings.get(id)?.startedAt ?? count(Date.parse(m.createdAt)), completedAt: timings.get(id)?.completedAt ?? null,
      inputTokens: count(usage.inputTokens) ?? inputTokens, outputTokens: count(usage.outputTokens) ?? outputTokens,
      turns: turnCount >= 0 ? turnCount : null,
    };
  });
  return items.some(isActiveDelegate) ? items.sort((a,b) => Number(isActiveDelegate(b)) - Number(isActiveDelegate(a))) : [];
}

export function presenceMetrics(item: SubagentPresenceItem, now: number) {
  const end = item.completedAt ?? (isActiveDelegate(item) ? now : null);
  const elapsed = item.startedAt !== null && end !== null ? Math.max(0, end - item.startedAt) : null;
  return { elapsed, speed: elapsed && item.outputTokens !== null ? item.outputTokens * 1000 / elapsed : null };
}
