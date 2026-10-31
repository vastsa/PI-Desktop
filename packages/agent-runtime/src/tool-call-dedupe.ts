import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { rejectMalformedToolCalls } from "./tool-call-recovery.js";

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

function callIdsIn(messages: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string") ids.add(wireCallId(block.id));
    }
  }
  return ids;
}

function idAllocator(ids: Iterable<string>): () => string {
  const reserved = new Set(ids);
  let nextId = 0;
  return () => {
    let id: string;
    do { id = `call_pi_repeat_${++nextId}`; } while (reserved.has(id));
    reserved.add(id);
    return id;
  };
}

/** Give new executions unique identities before Pi executes or journals them. */
export function createToolCallIdentity(initialHistory: readonly unknown[] = []): (
  stream: AssistantMessageEventStream, history: readonly unknown[],
) => AssistantMessageEventStream {
  const seenIds = callIdsIn(initialHistory);
  return (stream, history) => {
    for (const id of callIdsIn(history)) seenIds.add(id);
    const previousIds = new Set(seenIds);
    const normalize = (message: AssistantMessage): AssistantMessage => {
      message = rejectMalformedToolCalls(message);
      if (message.stopReason === "error" || message.stopReason === "aborted") return message;
      const used = new Set(previousIds);
      const freshId = idAllocator([...previousIds, ...callIdsIn([message])]);
      let changed = false;
      const content = message.content.map((block) => {
        if (block.type !== "toolCall") return block;
        const wire = wireCallId(block.id);
        if (!used.has(wire)) { used.add(wire); return block; }
        changed = true;
        return { ...block, id: freshId() };
      });
      const normalized = changed ? { ...message, content } : message;
      for (const id of callIdsIn([normalized])) seenIds.add(id);
      return normalized;
    };
    return new Proxy(stream, {
      get(target, property, receiver) {
        if (property === "result") return async () => normalize(await target.result());
        if (property === Symbol.asyncIterator) return async function* () {
          for await (const event of target) {
            if (event.type !== "done") { yield event; continue; }
            const message = normalize(event.message);
            yield message.stopReason === "error"
              ? { type: "error", reason: "error", error: message }
              : { ...event, message };
          }
        };
        return Reflect.get(target, property, receiver);
      },
    });
  };
}

/**
 * Keep one result per execution, with unique ids in the provider request.
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
 * A repeated id is a snapshot only while its call is waiting for a result.
 * Once answered, the provider may reuse it for a new execution (#1815). Keep
 * that execution and its result under a fresh request-local id, so endpoints
 * requiring globally unique ids still accept the request. Never mutate the
 * live transcript or carry a reused Responses item id onto the renamed call.
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
  let changed = false;
  const freshId = idAllocator(callIdsIn(messages));
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
      let contentChanged = false;
      const kept = content.flatMap((block) => {
        if (!isRecord(block) || block.type !== "toolCall") return [block];
        const id = typeof block.id === "string" ? block.id : undefined;
        if (id === undefined) return [block];
        calls += 1;
        const wire = wireCallId(id);
        if ((openCalls.get(wire) ?? 0) > 0) {
          note(wire);
          contentChanged = true;
          return [];
        }
        const requestId = keptCalls.has(wire) ? freshId() : id;
        keptCalls.set(wire, requestId);
        openCalls.set(wire, (openCalls.get(wire) ?? 0) + 1);
        if (requestId !== id) contentChanged = true;
        return [requestId === id ? block : { ...block, id: requestId }];
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
      if (contentChanged) changed = true;
      next.push(
        contentChanged ? ({ ...message, content: kept } as AgentMessage) : message,
      );
      continue;
    }

    if (message.role === "toolResult") {
      const id = (message as { toolCallId?: unknown }).toolCallId;
      if (typeof id === "string") {
        const wire = wireCallId(id);
        const waiting = openCalls.get(wire) ?? 0;
        if (keptResults.has(wire) && waiting === 0) {
          note(wire);
          continue;
        }
        keptResults.add(wire);
        if (waiting > 0) {
          openCalls.set(wire, waiting - 1);
          const owner = keptCalls.get(wire);
          // One call id, one result: pi-ai pairs a result to its call by the
          // composite id, so a result whose item half disagrees would leave the
          // call pending and earn a second, synthesized output for this id.
          if (owner !== undefined && owner !== id) {
            changed = true;
            next.push({ ...message, toolCallId: owner } as AgentMessage);
            continue;
          }
        }
      }
    }
    next.push(message);
  }

  return {
    messages: droppedCount === 0 && !changed ? messages : next,
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
