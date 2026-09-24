import type { AgentMessage } from "@earendil-works/pi-agent-core";

type RecordLike = Record<string, unknown>;

const MAX_LOGGED_DUPLICATE_TOOL_CALLS = 8;

export type DuplicateToolCallDrop = {
  messages: AgentMessage[];
  droppedCount: number;
  /** Messages removed whole because every tool call in them was a replay. */
  droppedMessages: number;
  droppedIds: string[];
};

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null;
}

/**
 * The id a provider validates, which is not always the id we store.
 *
 * PI-Desktop keeps pi-ai's composite Responses call id (`<call_id>|<item_id>`)
 * so a replay can address the server-side item, and the adapter sends only the
 * part before the separator as `call_id`. Two entries whose composite ids
 * differ in the item half therefore still collide on the wire, so every
 * comparison below uses this wire-visible id (D620).
 */
function wireCallId(id: string): string {
  const separator = id.indexOf("|");
  return separator < 0 ? id : id.slice(0, separator);
}

/**
 * Keep the first call and result for every tool-call id in a provider request.
 *
 * The transcript can contain repeated snapshots of one call. Returning the
 * original array when nothing changes preserves the common path's identity and
 * avoids copying messages that are already valid.
 *
 * A request that separates a call from its result is not merely untidy: pi-ai
 * closes a call whose result does not follow it with a synthesized
 * "No result provided" output *and* sends the real result, so one call id
 * carries two outputs and the endpoint rejects the whole turn (D608, D620).
 * Dropping a replayed assistant message whole — rather than keeping the text it
 * is left with — is what keeps that separation out of the request, and the
 * duplication the runtime itself produces repeats a message whole, so that is
 * the shape the drop covers. A message that replays one call while carrying a
 * new one keeps its new call where it is, which leaves the replayed call's own
 * result one message later; no writer reaches that partial replay, and the
 * guard leaves it alone rather than reordering what the model sees.
 *
 * Ids are compared by the part the provider validates, so two entries whose
 * item half differs count as one call. That shared id is the only id sharing
 * this guard accepts: a provider that reused one `call_id` for two distinct
 * calls would lose the second call and its result, reported under that id.
 */
export function dedupeToolCallMessages(
  messages: AgentMessage[],
): DuplicateToolCallDrop {
  const keptCalls = new Map<string, string>();
  const keptResults = new Set<string>();
  /** Wire ids whose call is still waiting for a result in this request. */
  const openCalls = new Map<string, number>();
  const droppedIds = new Set<string>();
  let droppedCount = 0;
  let droppedMessages = 0;
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
      let calls = 0;
      const kept = content.filter((block) => {
        if (!isRecord(block) || block.type !== "toolCall") return true;
        const id = typeof block.id === "string" ? block.id : undefined;
        if (id === undefined) return true;
        calls += 1;
        const wire = wireCallId(id);
        if (keptCalls.has(wire)) {
          note(wire);
          return false;
        }
        keptCalls.set(wire, id);
        openCalls.set(wire, (openCalls.get(wire) ?? 0) + 1);
        return true;
      });
      // Every call this message carried was already claimed by an earlier one,
      // so the message is that earlier message's snapshot rather than new
      // context. Its text is a copy too, and keeping the copy would place a
      // message between a call and the result answering it.
      if (
        calls > 0 &&
        kept.every((block) => !isRecord(block) || block.type !== "toolCall")
      ) {
        droppedMessages += 1;
        continue;
      }
      next.push(
        kept.length === content.length ? message : ({ ...message, content: kept } as AgentMessage),
      );
      continue;
    }

    if (message.role === "toolResult") {
      const id = (message as { toolCallId?: unknown }).toolCallId;
      if (typeof id === "string") {
        const wire = wireCallId(id);
        if (keptResults.has(wire)) {
          note(wire);
          continue;
        }
        keptResults.add(wire);
        const waiting = openCalls.get(wire) ?? 0;
        if (waiting > 0) {
          openCalls.set(wire, waiting - 1);
          const owner = keptCalls.get(wire);
          // One call id, one result: pi-ai pairs a result to its call by the
          // composite id, so a result whose item half disagrees would leave the
          // call pending and earn a second, synthesized output for this id.
          if (owner !== undefined && owner !== id) {
            next.push({ ...message, toolCallId: owner } as AgentMessage);
            continue;
          }
        }
      }
    }
    next.push(message);
  }

  return {
    messages: droppedCount === 0 ? messages : next,
    droppedCount,
    droppedMessages,
    droppedIds: [...droppedIds],
  };
}

export function reportDuplicateToolCallDrop(
  sessionId: string,
  drop: DuplicateToolCallDrop,
): void {
  if (drop.droppedCount === 0) return;
  const replayed =
    drop.droppedMessages > 0
      ? ` (${drop.droppedMessages} replayed message${
          drop.droppedMessages === 1 ? "" : "s"
        })`
      : "";
  process.stderr.write(
    `[agent-runtime] dropped ${drop.droppedCount} duplicate tool call ${
      drop.droppedCount === 1 ? "entry" : "entries"
    }${replayed} before the request (session=${sessionId} ids=${drop.droppedIds.join(",")})\n`,
  );
}
