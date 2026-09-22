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
/**
 * Recall pointer (ADR 0300): the stored summary never changes; the
 * projection appends a note that pre-boundary messages are not deleted but
 * remain in the session's transcript, retrievable verbatim via the recall tool.
 * The wording is a promise, so it is only appended because `recall` exists.
 */
const RECALL_POINTER =
  "\n\n[recall] Messages before this summary boundary are not deleted: they remain in this session's transcript and are retrievable verbatim via the recall tool.";

/**
 * Session ledger (ADR 0300): a mechanical, model-free record of the work a
 * compaction boundary covers. It is stored on the checkpoint's opaque
 * `details` (host-persisted verbatim, re-derived on restart) and projected into
 * the summary message as a bounded block, so the next context window keeps an
 * at-a-glance account of files, commands, the goal and what is still broken,
 * whose verbatim text is one recall away.
 */
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Open items a projected ledger names; a checkpoint stores at most five. */
const LEDGER_BLOCK_MAX_OPEN_ITEMS = 5;

/** A one-line block cannot carry the goal's own line breaks. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function ledgerBlock(details: unknown): string {
  const ledger = (details as { ledger?: unknown } | null | undefined)?.ledger;
  if (typeof ledger !== "object" || ledger === null) return "";
  const l = ledger as Record<string, unknown>;
  const filesRead = stringArray(l.filesRead).slice(0, 40);
  const filesModified = stringArray(l.filesModified).slice(0, 40);
  const commands = stringArray(l.commands).slice(0, 20);
  const messages = typeof l.messages === "number" ? l.messages : null;
  const toolCalls = typeof l.toolCalls === "number" ? l.toolCalls : null;
  // The re-anchor half: where the work happened was never the question a next
  // window got wrong; what it was doing and what is still broken is. Both are
  // optional, so a checkpoint written before this change projects exactly the
  // block it always did.
  const goal =
    typeof l.goal === "string" && l.goal.trim().length > 0
      ? oneLine(l.goal)
      : null;
  const openItems = stringArray(l.openItems).slice(0, LEDGER_BLOCK_MAX_OPEN_ITEMS);
  const lines = [
    "\n\n[session ledger — mechanical record of the work before this boundary; verbatim text is retrievable via the recall tool]",
  ];
  if (goal) lines.push(`goal: ${goal}`);
  if (filesRead.length > 0) lines.push(`files read: ${filesRead.join(", ")}`);
  if (filesModified.length > 0)
    lines.push(`files modified: ${filesModified.join(", ")}`);
  if (commands.length > 0)
    lines.push(`commands: ${commands.map((c) => `\`${c}\``).join(", ")}`);
  if (openItems.length > 0)
    lines.push(`unresolved: ${openItems.map(oneLine).join(" | ")}`);
  if (messages !== null || toolCalls !== null)
    lines.push(
      `totals: ${messages ?? "?"} messages, ${toolCalls ?? "?"} tool calls in the compacted range`,
    );
  return lines.length > 1 ? lines.join("\n") : "";
}

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
          entry.summary + RECALL_POINTER + ledgerBlock(entry.details),
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
