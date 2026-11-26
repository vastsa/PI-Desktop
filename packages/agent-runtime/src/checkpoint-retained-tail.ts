import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isRecord } from "./agent-messages.js";
import { COMPACTION_RETAINED_TAIL_SHAPE, replayRetainedTail } from "./compaction-tail.js";
type CompactionRetentionMode = "active_turn" | "completed_turn";

function compactionRetentionMode(details: unknown): CompactionRetentionMode {
  // Checkpoints written before the task-boundary fix did not record whether
  // their retained users belonged to an in-progress turn. Treat those
  // records as active, but still reduce them to one latest user message so a
  // restart cannot restore a sequence of executable-looking old requests.
  return isRecord(details) && details.retainedTailMode === "completed_turn"
    ? "completed_turn"
    : "active_turn";
}

/**
 * The messages a stored checkpoint replays as real context after its summary.
 *
 * A checkpoint that recorded {@link COMPACTION_RETAINED_TAIL_SHAPE} keeps the
 * whole window it stored: it is a failed compaction's only record of the range
 * behind it, so narrowing the tail back to one user message would reinstate
 * exactly the amnesia the window fixes (#827). Records written before that
 * marker existed — and every successful checkpoint — keep the older
 * normalization: at most the latest user message, and none at all once the turn
 * is complete, so a restart cannot restore a sequence of executable-looking old
 * requests.
 */
export function retainedTailForContext(
  value: unknown,
  details?: unknown,
): AgentMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (
    isRecord(details) &&
    details.retainedTailShape === COMPACTION_RETAINED_TAIL_SHAPE
  ) {
    return replayRetainedTail(value) ?? [];
  }
  const messages = value
    .filter(isRecord)
    .filter((message) => message.role === "user") as unknown as AgentMessage[];
  if (compactionRetentionMode(details) === "completed_turn") return [];
  const latestUser = messages.at(-1);
  return latestUser ? [latestUser] : [];
}
