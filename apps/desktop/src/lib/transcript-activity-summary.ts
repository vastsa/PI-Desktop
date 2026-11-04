import type { UiMessage } from "@pi-desktop/shared";
import type { AssistantActivityItem, AssistantTurnPart } from "./assistant-turns";
import {
  ACTIVITY_BUCKET_ORDER,
  type ActivityBucket,
  type ActivityBucketId,
} from "./activity-group-label";
import { getToolAction } from "./tool-display";
import { messageContentFacts } from "./transcript-summary";

const actionCache = new WeakMap<UiMessage, ActivityBucketId>();

/** Which label bucket a tool row belongs to, cached per message. */
function cachedAction(message: UiMessage): ActivityBucketId {
  const cached = actionCache.get(message);
  if (cached) return cached;
  // Every `ToolAction` is a bucket id, so the mapping is the identity.
  const action = getToolAction(message.toolName);
  actionCache.set(message, action);
  return action;
}

/**
 * What a group or a whole turn did, in one scan.
 *
 * The counts behind the group header: rows per action (reasoning counted apart,
 * because it is not an operation), the operation total, and the reasoning total.
 * Payload reads are cached per message so a streaming tail only costs the row
 * that changed.
 */
export function cachedActivitySummary(items: readonly AssistantActivityItem[]): {
  /** Every action, in label reading order, zero counts included. */
  buckets: ActivityBucket[];
  tools: number;
  thinking: number;
} {
  const counts = new Map<ActivityBucketId, number>();
  let tools = 0;
  let thinking = 0;
  for (const item of items) {
    if (item.kind === "thinking") {
      thinking += 1;
      continue;
    }
    tools += 1;
    // A hosted search is a search even though it carries no tool name.
    const id = item.kind === "hostedSearch" ? "search" : cachedAction(item.message);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return {
    buckets: ACTIVITY_BUCKET_ORDER.map((id) => ({ id, count: counts.get(id) ?? 0 })),
    tools,
    thinking,
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
export function cachedVisibleActivityItems(items: readonly AssistantActivityItem[], hideThinking: boolean, active: boolean) {
  return items.filter((item) => item.kind !== "thinking" || !hideThinking ||
    (active && item.message.status === "streaming" && !messageContentFacts(item.message).hasContent));
}

export function cachedVisibleProcessSteps(parts: readonly AssistantTurnPart[], hideThinking: boolean, active: boolean) {
  let count = 0;
  for (const part of parts) {
    if (part.kind === "message") {
      if (messageContentFacts(part.message).hasContent) count += 1;
    } else {
      for (const item of part.items) {
        if (item.kind !== "thinking" || !hideThinking ||
          (active && item.message.status === "streaming" && !messageContentFacts(item.message).hasContent)) count += 1;
      }
    }
  }
  return count;
}
