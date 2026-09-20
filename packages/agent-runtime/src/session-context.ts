/**
 * Project pi session entries into the model context.
 *
 * pi 0.85 moved `buildSessionContext` off the public package export and made
 * the remaining helper async for custom-entry projectors. PI-Desktop
 * synthesizes only message and compaction entries, so the projection stays
 * synchronous and keeps the `{ messages }` shape the runtime already uses.
 *
 * The slice-from-latest-compaction and compactionSummary-before-retainedTail
 * order are copied from pi-agent-core; D203 depends on that order. Retained
 * reasoning turns (#296) sit between the summary and the user tail so strict
 * DeepSeek relays still see real thinking without replaying tool-call pairs.
 */

import {
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  type AgentMessage,
  type Entry,
} from "@earendil-works/pi-agent-core";
import {
  retainedReasoningFromDetails,
  retainedReasoningToMessages,
  type ReasoningReplayIdentity,
} from "./reasoning-replay.js";

/**
 * Failed, aborted, and deferred assistants are transcript rows, not context.
 * An assistant with no content blocks is not worth resending either: the
 * runtime never appends one live, a restored transcript drops them, and a
 * provider would reject or silently skip it (D446).
 */
function isContextMessage(message: AgentMessage): boolean {
  return (
    message.role !== "assistant" ||
    (message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      message.stopReason !== "deferred" &&
      message.content.length > 0)
  );
}

export function buildContextEntries(pathEntries: readonly Entry[]): Entry[] {
  for (let index = pathEntries.length - 1; index >= 0; index--) {
    const entry = pathEntries[index];
    if (entry?.type === "compaction") {
      return [entry, ...pathEntries.slice(index + 1)];
    }
  }
  return [...pathEntries];
}

export function sessionEntryToContextMessages(
  entry: Entry,
  identity?: ReasoningReplayIdentity,
): AgentMessage[] {
  switch (entry.type) {
    case "message":
      return isContextMessage(entry.message) ? [entry.message] : [];
    case "compaction":
      return [
        createCompactionSummaryMessage(
          entry.summary,
          entry.tokensBefore,
          entry.timestamp,
        ),
        ...(identity?.requiresCompletionsReasoningReplay === false
          ? []
          : retainedReasoningToMessages(
              retainedReasoningFromDetails(entry.details),
              entry.timestamp,
              identity,
            )),
        ...entry.retainedTail.filter(isContextMessage),
      ];
    case "branch_summary":
      return entry.summary
        ? [
            createBranchSummaryMessage(
              entry.summary,
              entry.fromId,
              entry.timestamp,
            ),
          ]
        : [];
    case "custom":
      return [];
  }
}

export function buildSessionContext(
  pathEntries: readonly Entry[],
  identity?: ReasoningReplayIdentity,
): {
  messages: AgentMessage[];
} {
  return {
    messages: buildContextEntries(pathEntries).flatMap((entry) =>
      sessionEntryToContextMessages(entry, identity),
    ),
  };
}
