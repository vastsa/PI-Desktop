import { readSystemMessage } from "./system-transcript-journal.js";
/**
 * Project pi session entries into the model context.
 *
 * The runtime owns this synchronous projection because its transcript includes
 * desktop-only entries and persisted host checkpoints. It keeps the
 * `{ messages }` shape consumed by the agent loop.
 *
 * The slice-from-latest-compaction and compactionSummary-before-retainedTail
 * order preserve the behavior D203 depends on. Retained
 * reasoning turns (#296) sit between the summary and the user tail so strict
 * DeepSeek relays still see real thinking without replaying tool-call pairs.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
} from "./pi-runtime-messages.js";
import type { Entry } from "./pi-runtime-types.js";
import { summaryWithCheckpointTodos } from "./checkpoint-todos.js";
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
        ...(entry.details && typeof entry.details === "object" && "systemMessageJson" in entry.details
          ? [readSystemMessage(entry.details.systemMessageJson)] : []),
        // The checklist copy lives in `details`, not `summary`, so the stored
        // summary a later compaction carries forward never holds a stale list.
        createCompactionSummaryMessage(
          summaryWithCheckpointTodos(entry.summary, entry.details),
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
        ...entry.retainedTail.filter((message) => isContextMessage(message) &&
          !(message.role === "system" && entry.details && typeof entry.details === "object" && "systemMessageJson" in entry.details)),
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
