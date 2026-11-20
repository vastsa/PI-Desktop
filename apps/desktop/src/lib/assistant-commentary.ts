import { isResponsesCommentary, type AssistantProviderReplay, type UiMessage } from "@pi-desktop/shared";
import type { AssistantTurnPart } from "./assistant-turns";

type MessagePart = Extract<AssistantTurnPart, { kind: "message" }>;
type CommentaryProjection = { progress: MessagePart[]; reply: MessagePart };

const projections = new WeakMap<UiMessage, CommentaryProjection | undefined>();

function splitCommentary(
  message: UiMessage, replay: AssistantProviderReplay,
): CommentaryProjection | undefined {
  const { content } = message;
  if (typeof content !== "string" || replay.version !== 1 || !Array.isArray(replay.blocks)) return undefined;
  const progress: MessagePart[] = [];
  let offset = 0;
  let replyStart = 0;
  let replyText = "";
  for (const block of replay.blocks) {
    if (
      !block || (block.type !== "text" && block.type !== "thinking") ||
      !Number.isSafeInteger(block.length) || block.length < 0 ||
      (block.signature !== undefined && typeof block.signature !== "string")
    ) return undefined;
    // Thinking has its own string. Every text block, signed or not, consumes
    // exactly its UTF-16 length in the stored content.
    if (block.type === "thinking") continue;
    const end = offset + block.length;
    if (end > content.length) return undefined;
    if (end > offset && isResponsesCommentary(block.signature)) {
      replyText += content.slice(replyStart, offset);
      replyStart = end;
      const text = content.slice(offset, end);
      if (text.trim()) {
        progress.push({
          kind: "message",
          sourceMessageId: message.id,
          message: {
            id: `${message.id}:commentary:${offset}`, role: "assistant", content: text,
            createdAt: message.createdAt, status: message.status,
          },
        });
      }
    }
    offset = end;
  }
  // Never use a partial match (e.g. an abbreviated history row), and keep
  // ordinary rows by identity when no text was explicitly marked.
  if (offset !== content.length || replyStart === 0) return undefined;
  return {
    progress,
    reply: {
      kind: "message",
      message: { ...message, content: replyText + content.slice(replyStart), providerReplay: undefined },
    },
  };
}

/** Display parts belong to an immutable renderer snapshot, not the saved message. */
export function projectAssistantCommentary(message: UiMessage): CommentaryProjection | undefined {
  if (message.role !== "assistant" || !message.providerReplay) return undefined;
  if (!projections.has(message)) projections.set(message, splitCommentary(message, message.providerReplay));
  return projections.get(message);
}
