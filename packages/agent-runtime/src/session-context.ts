/**
 * Project pi session entries into the model context.
 *
 * pi 0.85 moved `buildSessionContext` off the public package export and made
 * the remaining helper async for custom-entry projectors. PI-Desktop
 * synthesizes only message and compaction entries, so the projection stays
 * synchronous and keeps the `{ messages }` shape the runtime already uses.
 *
 * The slice-from-latest-compaction and compactionSummary-before-retainedTail
 * order are copied from pi-agent-core; D203 depends on that order.
 */

import {
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  type AgentMessage,
  type Entry,
} from "@earendil-works/pi-agent-core";

function isContextMessage(message: AgentMessage): boolean {
  return (
    message.role !== "assistant" ||
    (message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      message.stopReason !== "deferred")
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

export function sessionEntryToContextMessages(entry: Entry): AgentMessage[] {
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

export function buildSessionContext(pathEntries: readonly Entry[]): {
  messages: AgentMessage[];
} {
  return {
    messages: buildContextEntries(pathEntries).flatMap(
      sessionEntryToContextMessages,
    ),
  };
}
