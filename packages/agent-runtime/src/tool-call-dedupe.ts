import type { AgentMessage } from "@earendil-works/pi-agent-core";

type RecordLike = Record<string, unknown>;

const MAX_LOGGED_DUPLICATE_TOOL_CALLS = 8;

export type DuplicateToolCallDrop = {
  messages: AgentMessage[];
  droppedCount: number;
  droppedIds: string[];
};

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null;
}

/**
 * Keep the first call and result for every tool-call id in a provider request.
 *
 * The transcript can contain repeated snapshots of one call. Returning the
 * original array when nothing changes preserves the common path's identity and
 * avoids copying messages that are already valid.
 */
export function dedupeToolCallMessages(
  messages: AgentMessage[],
): DuplicateToolCallDrop {
  const claimedCalls = new Set<string>();
  const claimedResults = new Set<string>();
  const droppedIds = new Set<string>();
  let droppedCount = 0;
  const note = (id: string) => {
    droppedCount += 1;
    if (droppedIds.size < MAX_LOGGED_DUPLICATE_TOOL_CALLS) {
      droppedIds.add(id);
    }
  };
  const next: AgentMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        next.push(message);
        continue;
      }
      const kept = content.filter((block) => {
        if (!isRecord(block) || block.type !== "toolCall") return true;
        const id = typeof block.id === "string" ? block.id : undefined;
        if (id === undefined) return true;
        if (claimedCalls.has(id)) {
          note(id);
          return false;
        }
        claimedCalls.add(id);
        return true;
      });
      if (kept.length === 0 && content.length > 0) continue;
      next.push(kept.length === content.length ? message : ({ ...message, content: kept } as AgentMessage));
      continue;
    }

    if (message.role === "toolResult") {
      const id = (message as { toolCallId?: unknown }).toolCallId;
      if (typeof id === "string") {
        if (claimedResults.has(id)) {
          note(id);
          continue;
        }
        claimedResults.add(id);
      }
    }
    next.push(message);
  }

  return {
    messages: droppedCount === 0 ? messages : next,
    droppedCount,
    droppedIds: [...droppedIds],
  };
}

export function reportDuplicateToolCallDrop(
  sessionId: string,
  drop: DuplicateToolCallDrop,
): void {
  if (drop.droppedCount === 0) return;
  process.stderr.write(
    `[agent-runtime] dropped ${drop.droppedCount} duplicate tool call ${
      drop.droppedCount === 1 ? "entry" : "entries"
    } before the request (session=${sessionId} ids=${drop.droppedIds.join(",")})\n`,
  );
}
