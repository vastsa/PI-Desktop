import { splitResponsesCommentary, type AssistantProviderReplay, type UiMessage } from "@pi-desktop/shared";
import type { AssistantTurnPart } from "./assistant-turns";

type MessagePart = Extract<AssistantTurnPart, { kind: "message" }>;
type CommentaryProjection = { progress: MessagePart[]; reply: MessagePart };

const projections = new WeakMap<UiMessage, CommentaryProjection | undefined>();

function splitCommentary(
  message: UiMessage, replay: AssistantProviderReplay,
): CommentaryProjection | undefined {
  const split = splitResponsesCommentary(message.content, replay);
  if (!split) return undefined;
  const progress: MessagePart[] = split.commentary
    .filter(({ text }) => text.trim())
    .map(({ offset, text }) => ({
      kind: "message",
      sourceMessageId: message.id,
      message: {
        id: `${message.id}:commentary:${offset}`, role: "assistant", content: text,
        createdAt: message.createdAt, status: message.status,
      },
    }));
  return {
    progress,
    reply: {
      kind: "message",
      message: { ...message, content: split.answer, providerReplay: undefined },
    },
  };
}

/** Display parts belong to an immutable renderer snapshot, not the saved message. */
export function projectAssistantCommentary(message: UiMessage): CommentaryProjection | undefined {
  if (message.role !== "assistant" || !message.providerReplay) return undefined;
  if (!projections.has(message)) projections.set(message, splitCommentary(message, message.providerReplay));
  return projections.get(message);
}
