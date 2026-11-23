import { readSystemMessage } from "./system-transcript-journal.js";
import { recoverMalformedToolCalls } from "./tool-call-recovery.js";
/**
 * Project pi session entries into the model context.
 *
 * The runtime owns this synchronous projection because its transcript includes
 * desktop-only entries and persisted host checkpoints. It keeps the
 * `{ messages }` shape consumed by the agent loop.
 *
 * Context starts at the latest compaction (D203). Summary-first order keeps
 * recovery notices ahead of the messages they describe and retained reasoning
 * between the summary and the user tail (#296). A successful active-turn
 * checkpoint without reasoning to replay can follow its retained request so
 * the model resumes from the checkpoint.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { checkpointFallback } from "@pi-desktop/shared";
import {
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
} from "./pi-runtime-messages.js";
import type { Entry } from "./pi-runtime-types.js";
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
    case "compaction": {
      const details = entry.details;
      const system = details && typeof details === "object" && "systemMessageJson" in details
        ? [readSystemMessage(details.systemMessageJson)] : [];
      const reasoning = identity?.requiresCompletionsReasoningReplay === false
        ? []
        : retainedReasoningToMessages(
            retainedReasoningFromDetails(details), entry.timestamp, identity,
          );
      const tail = entry.retainedTail.filter((message) => isContextMessage(message) &&
        !(message.role === "system" && system.length > 0));
      const resume = details && typeof details === "object" &&
        "retainedTailMode" in details && details.retainedTailMode === "active_turn" &&
        checkpointFallback(details) === undefined &&
        entry.summary.trim().length > 0 && reasoning.length === 0 &&
        tail.length === 1 && tail[0]?.role === "user";
      const summary = createCompactionSummaryMessage(
        entry.summary, entry.tokensBefore, entry.timestamp, Boolean(resume),
      );
      return resume
        ? [...system, ...tail, summary]
        : [...system, summary, ...reasoning, ...tail];
    }
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
    messages: recoverMalformedToolCalls(buildContextEntries(pathEntries).flatMap((entry) =>
      sessionEntryToContextMessages(entry, identity),
    )),
  };
}
