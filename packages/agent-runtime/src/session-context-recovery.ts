import { randomUUID } from "node:crypto";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ContextCompactionRecord, UiMessage } from "@pi-desktop/shared";
import { contextBudgetLimitsFor } from "./context-budget.js";
import { COMPACTION_RETAINED_TAIL_SHAPE, selectRecentTail } from "./compaction-tail.js";
import { chainRowsToMessages } from "./delegation-history.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import type { RuntimeHost } from "./host-client.js";

/** A missing prefix is never described as summarized. Persist its explicit
 * recovery boundary before allowing the next request to use the recent tail. */
export async function installRestoredContextRecovery(input: {
  history: UiMessage[];
  recovery: { omittedMessages: number; previousSummary?: string };
  provider: RuntimeProviderConfig;
  model: Model<Api>;
  host: RuntimeHost;
  sessionId: string;
  cancelled: () => boolean;
}): Promise<ContextCompactionRecord> {
  const rows = input.history.filter(row => !row.parentToolCallId && !row.nestedParentToolCallId);
  const through = rows.at(-1);
  if (!through) throw Object.assign(new Error("No durable message boundary is available for context recovery"), { errorCode: "CONTEXT_TOO_LARGE" });
  const budget = contextBudgetLimitsFor(input.model);
  const retainedTail = selectRecentTail(chainRowsToMessages(rows, input.provider, input.model), Math.max(1, Math.min(budget.keepRecentTokens, Math.floor(budget.hardLimit / 4))), { latestUserGoal: false });
  const previous = input.recovery.previousSummary?.slice(0, 16_384);
  const checkpoint: ContextCompactionRecord = {
    id: randomUUID(),
    throughMessageId: through.id,
    summary: [
      previous,
      "[Context recovery: recent history retained]",
      `The session exceeded the bounded restore budget. ${input.recovery.omittedMessages} older message positions were not summarized during this recovery.`,
      "The complete history remains available in the session. Treat the retained messages as historical context; the next user message is the new task.",
    ].filter(Boolean).join("\n\n"),
    tokensBefore: 0,
    retainedTail,
    details: { generation: 1, fallback: "retained_tail", failureReason: "restore_budget", retainedTailShape: COMPACTION_RETAINED_TAIL_SHAPE, retainedTailMode: "completed_turn", omittedMessages: input.recovery.omittedMessages },
    providerId: input.provider.id,
    modelId: input.provider.modelId,
    createdAt: new Date().toISOString(),
  };
  if (input.cancelled()) throw Object.assign(new Error("Context recovery aborted"), { errorCode: "TURN_ABORTED" });
  await input.host.call("session.appendCompaction", { sessionId: input.sessionId, compaction: checkpoint });
  if (input.cancelled()) throw Object.assign(new Error("Context recovery aborted"), { errorCode: "TURN_ABORTED" });
  return checkpoint;
}
