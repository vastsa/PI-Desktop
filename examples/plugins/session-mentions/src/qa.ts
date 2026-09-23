import type { ReferenceMessage, SessionQaTurn } from "./types.js";
import { stripSessionReferencePrompt } from "./prompt.js";

/**
 * The original parent-Q&A reduction: concatenate eligible parent assistant rows
 * until the next parent user row. The host adapter must supply authoritative
 * status/parent metadata; this cannot be reconstructed from stripped messages.
 */
export function pairCompletedQaTurns(messages: readonly ReferenceMessage[]): SessionQaTurn[] {
  const turns: SessionQaTurn[] = [];
  let question: string | null = null;
  const answers: string[] = [];
  const commit = () => {
    if (question && answers.length) turns.push({ question, answer: answers.join("\n\n") });
    question = null;
    answers.length = 0;
  };
  for (const message of messages) {
    if (message.parentToolCallId?.trim()) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.contentTruncated) throw new Error("Session reference contains truncated message text");
    if (message.role === "user") {
      commit();
      const text = stripSessionReferencePrompt(message.content ?? "").trim();
      question = text || (message.attachments?.length
        ? "[User message with attachments; attachment contents are not included.]" : null);
    } else if (question && !["aborted", "error", "streaming"].includes(message.status ?? "")) {
      const text = stripSessionReferencePrompt(message.content ?? "").trim();
      if (text) answers.push(text);
    }
  }
  commit();
  return turns;
}
