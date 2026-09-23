import type { AssistantActivityItem } from "./assistant-turns";
import { getToolAction } from "./tool-display";
import { runOutcome } from "./tool-presentation";
import { isDelegationActivityItem, subagentOutcome, type SubagentOutcome } from "./subagent-topology";

export function activityItemHasIssue(item: AssistantActivityItem): boolean {
  if (item.kind === "hostedSearch") return item.round.status === "failed";
  if (item.kind !== "tool") return false;
  const message = item.message;
  return message.toolStatus === "error" || message.toolStatus === "denied" ||
    Boolean(message.isError) ||
    (getToolAction(message.toolName) === "run" && runOutcome(message) === "failed");
}

export function visibleActivityItems(
  items: readonly AssistantActivityItem[],
  compact: boolean,
  active: boolean,
) {
  return items.filter((item) => item.kind !== "thinking" || !compact ||
    (active && item.message.status === "streaming" && !item.message.content.trim()));
}

/**
 * One turn's work, split into non-overlapping categories.
 *
 * The four work categories partition the visible items, so `toolCalls +
 * commandExecutions + searchRounds` is the same total the aggregate count used
 * to report: a command execution is not also a tool call, and a provider
 * hosted-search round is a round rather than a tool call. Delegated child work
 * stays inside its parent `Task` call and is never counted into the turn
 * (ADR turn-process-and-thinking-display).
 */
export type ActivitySummary = {
  /** Tool calls the model made directly, command executions excluded. */
  toolCalls: number;
  /** Tool calls whose `getToolAction()` is `run`. */
  commandExecutions: number;
  /** Provider-hosted search rounds, one per round. */
  searchRounds: number;
  /** Message-level reasoning entries, never streamed chunks. */
  thinkingSteps: number;
  /** Errors and denials, including failed and denied delegates. */
  issues: number;
};

export function activitySummary(
  items: readonly AssistantActivityItem[],
  statuses?: ReadonlyMap<string, SubagentOutcome>,
): ActivitySummary {
  let toolCalls = 0;
  let commandExecutions = 0;
  let searchRounds = 0;
  let thinkingSteps = 0;
  for (const item of items) {
    if (item.kind === "thinking") {
      thinkingSteps += 1;
    } else if (item.kind === "hostedSearch") {
      searchRounds += 1;
    } else if (getToolAction(item.message.toolName) === "run") {
      commandExecutions += 1;
    } else {
      toolCalls += 1;
    }
  }
  return {
    toolCalls,
    commandExecutions,
    searchRounds,
    thinkingSteps,
    issues: items.filter((item) => {
      if (!isDelegationActivityItem(item)) return activityItemHasIssue(item);
      const outcome = subagentOutcome(item.message, statuses);
      return outcome === "failed" || outcome === "denied";
    }).length,
  };
}

/** Header order: what the model called, ran, searched, then reasoned about. */
const ACTIVITY_COUNT_KEYS = [
  "chat.activityToolCalls",
  "chat.activityCommands",
  "chat.activitySearches",
  "chat.activityThinking",
] as const;

/** The categories a header shows, in order, with empty ones dropped. */
export function activityCountParts(
  summary: ActivitySummary,
): { key: string; count: number }[] {
  const counts = [
    summary.toolCalls,
    summary.commandExecutions,
    summary.searchRounds,
    summary.thinkingSteps,
  ];
  return ACTIVITY_COUNT_KEYS.flatMap((key, index) =>
    counts[index] > 0 ? [{ key, count: counts[index] }] : [],
  );
}
