import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionMessageOrigin, UiMessage } from "@pi-desktop/shared";
import type { RuntimeHost } from "./host-client.js";

export type ReceivedSessionMessage = UiMessage & { sessionMessage: SessionMessageOrigin };

/** Only called after pi decided to make another actual request in this run. */
export async function receiveCurrentTurnMessages(input: {
  host: RuntimeHost;
  sessionId: string;
  turnId: string;
  isCurrent: () => boolean;
  signal?: AbortSignal;
}): Promise<ReceivedSessionMessage[]> {
  const requestId = randomUUID();
  const guard = () => {
    input.signal?.throwIfAborted();
    if (!input.isCurrent()) throw new DOMException("The receiving turn stopped", "AbortError");
  };
  for (let attempt = 0; ; attempt += 1) {
    guard();
    let result: { messages: ReceivedSessionMessage[] };
    try {
      result = await input.host.call("session.collaboration.receive", {
        sessionId: input.sessionId, turnId: input.turnId, requestId,
      });
    } catch (error) {
      guard();
      // A missing reply is not rejection. Repeat the SAME durable receipt key;
      // exhaustion fails this request instead of starting a duplicate turn.
      if (attempt >= 2) throw error;
      continue;
    }
    guard();
    if (!result || !Array.isArray(result.messages) || result.messages.length > 8) {
      throw new Error("Invalid current-turn delivery response");
    }
    const ids = new Set<string>();
    for (const message of result.messages) {
      const origin = message.sessionMessage;
      if (message.role !== "user" || typeof message.content !== "string" ||
          !origin?.messageId || !origin.sourceSessionId ||
          origin.targetSessionId !== input.sessionId ||
          (origin.kind !== "message" && origin.kind !== "completion") ||
          message.id !== `session-message:${origin.messageId}` ||
          message.steering === true || (message.attachments?.length ?? 0) > 0 || ids.has(message.id)) {
        throw new Error("Current-turn delivery provenance mismatch");
      }
      ids.add(message.id);
    }
    return result.messages;
  }
}

/** Checkpointing/extensions can rewrite context, but not drop fresh host input. */
export function includeCurrentTurnMessages(context: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  const texts = new Set(incoming.filter((m) => m.role === "user").map((m) => m.content));
  return [...context.filter((m) => !(m.role === "user" && texts.has(m.content))), ...incoming];
}
