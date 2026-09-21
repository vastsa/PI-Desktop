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

export function activitySummary(items: readonly AssistantActivityItem[], statuses?: ReadonlyMap<string, SubagentOutcome>) {
  const tools = items.filter((item) => item.kind !== "thinking");
  const thinking = items.length - tools.length;
  const actions = tools.map((item) => item.kind === "hostedSearch"
    ? "search" : getToolAction(item.message.toolName));
  const label = tools.length === 0 ? "chat.activityThinking"
    : actions.every((action) => action === "run") ? "chat.activityCommands"
    : actions.every((action) => action === "search") ? "chat.activitySearches"
    : "chat.activityTools";
  return {
    label,
    count: tools.length || thinking,
    tools: tools.length,
    thinking,
    issues: items.filter((item) => {
      if (!isDelegationActivityItem(item)) return activityItemHasIssue(item);
      const outcome = subagentOutcome(item.message, statuses);
      return outcome === "failed" || outcome === "denied";
    }).length,
  };
}
