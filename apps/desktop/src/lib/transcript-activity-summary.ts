import type { UiMessage } from "@pi-desktop/shared";
import type { AssistantActivityItem, AssistantTurnPart } from "./assistant-turns";
import { activityItemHasIssue } from "./activity-summary";
import { getToolAction } from "./tool-display";
import { isDelegationActivityItem, subagentOutcome, type SubagentOutcome } from "./subagent-topology";
import { messageContentFacts } from "./transcript-summary";

const toolFacts = new WeakMap<UiMessage, { action: ReturnType<typeof getToolAction>; issue: boolean }>();
const outcomes = new WeakMap<UiMessage, {
  fallback?: SubagentOutcome;
  byStatuses: WeakMap<ReadonlyMap<string, SubagentOutcome>, SubagentOutcome>;
}>();

function cachedOutcome(message: UiMessage, statuses?: ReadonlyMap<string, SubagentOutcome>) {
  let cache = outcomes.get(message);
  if (!cache) {
    cache = { byStatuses: new WeakMap() };
    outcomes.set(message, cache);
  }
  const cached = statuses ? cache.byStatuses.get(statuses) : cache.fallback;
  if (cached) return cached;
  const outcome = subagentOutcome(message, statuses);
  if (statuses) cache.byStatuses.set(statuses, outcome);
  else cache.fallback = outcome;
  return outcome;
}

/** Same labels/counts as activitySummary, with payload work keyed by message. */
export function cachedActivitySummary(items: readonly AssistantActivityItem[], statuses?: ReadonlyMap<string, SubagentOutcome>) {
  let tools = 0;
  let thinking = 0;
  let issues = 0;
  let allRun = true;
  let allSearch = true;
  for (const item of items) {
    if (item.kind === "thinking") { thinking += 1; continue; }
    tools += 1;
    if (item.kind === "hostedSearch") {
      allRun = false;
      if (item.round.status === "failed") issues += 1;
      continue;
    }
    let facts = toolFacts.get(item.message);
    if (!facts) {
      facts = { action: getToolAction(item.message.toolName), issue: activityItemHasIssue(item) };
      toolFacts.set(item.message, facts);
    }
    allRun &&= facts.action === "run";
    allSearch &&= facts.action === "search";
    if (isDelegationActivityItem(item)) {
      const outcome = cachedOutcome(item.message, statuses);
      if (outcome === "failed" || outcome === "denied") issues += 1;
    } else if (facts.issue) issues += 1;
  }
  return {
    label: tools === 0 ? "chat.activityThinking" : allRun ? "chat.activityCommands" : allSearch ? "chat.activitySearches" : "chat.activityTools",
    count: tools || thinking, tools, thinking, issues,
  };
}

/** Precompute the legacy group's fallback formula without a per-second scan. */
export function activityTimingInputs(items: readonly AssistantActivityItem[]) {
  const startedAt = Date.parse(items[0]?.message.createdAt || "");
  let recordedEnd = -Infinity;
  let missingStartDuration = -Infinity;
  for (const { message } of items) {
    const completed = Date.parse(message.toolCompletedAt || "");
    const created = Date.parse(message.createdAt);
    const duration = message.toolDurationMs || 0;
    if (completed) recordedEnd = Math.max(recordedEnd, completed);
    else if (created) recordedEnd = Math.max(recordedEnd, created + duration);
    else missingStartDuration = Math.max(missingStartDuration, duration);
  }
  return { startedAt, recordedEnd, missingStartDuration };
}
export function cachedVisibleActivityItems(items: readonly AssistantActivityItem[], compact: boolean, active: boolean) {
  return items.filter((item) => item.kind !== "thinking" || !compact ||
    (active && item.message.status === "streaming" && !messageContentFacts(item.message).hasContent));
}

export function cachedVisibleProcessSteps(parts: readonly AssistantTurnPart[], compact: boolean, active: boolean) {
  let count = 0;
  for (const part of parts) {
    if (part.kind === "message") {
      if (messageContentFacts(part.message).hasContent) count += 1;
    } else {
      for (const item of part.items) {
        if (item.kind !== "thinking" || !compact ||
          (active && item.message.status === "streaming" && !messageContentFacts(item.message).hasContent)) count += 1;
      }
    }
  }
  return count;
}
