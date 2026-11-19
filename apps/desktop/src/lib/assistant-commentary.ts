import { isResponsesCommentary, type AssistantCommentaryRange, type UiMessage } from "@pi-desktop/shared";

type AssistantTextProjection = {
  reply: UiMessage;
  progress: UiMessage[];
};

const projections = new WeakMap<UiMessage, AssistantTextProjection | undefined>();

function savedCommentaryRanges(message: UiMessage, source: "layout" | "replay"): AssistantCommentaryRange[] | undefined {
  const replay = message.providerReplay;
  const blocks = source === "layout" ? message.responseLayout : replay?.version === 1 ? replay.blocks : undefined;
  if (!Array.isArray(blocks)) return undefined;
  const ranges: AssistantCommentaryRange[] = [];
  let offset = 0;
  for (const block of blocks) {
    if (!block || typeof block !== "object") return undefined;
    if (block.type === "thinking" || (source === "layout" && block.type === "search")) continue;
    if (block.type !== "text" && !(source === "layout" && block.type === "commentary")) return undefined;
    if (!Number.isSafeInteger(block.length) || block.length < 0) return undefined;
    const end = offset + block.length;
    if (end > message.content.length) return undefined;
    const marked = source === "layout" ? block.type === "commentary" : isResponsesCommentary(block.signature);
    if (end > offset && marked) ranges.push({ start: offset, end });
    offset = end;
  }
  // The host may return abbreviated content. Do not apply offsets to text
  // other than the full string these lengths describe, even if thinking alone was clipped.
  return offset === message.content.length ? ranges : undefined;
}

function splitAssistantText(message: UiMessage): AssistantTextProjection | undefined {
  const ranges = message.commentaryRanges ?? savedCommentaryRanges(message, "replay") ?? savedCommentaryRanges(message, "layout");
  if (!Array.isArray(ranges) || !ranges.length) return undefined;
  const progress: UiMessage[] = [];
  let offset = 0;
  let reply = "";
  for (const range of ranges) {
    if (!range) return undefined;
    const { start, end } = range;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < offset || end <= start || end > message.content.length) return undefined;
    const content = message.content.slice(start, end);
    if (content.trim()) {
      progress.push({
        id: `${message.id}:commentary:${start}`,
        role: "assistant",
        content,
        createdAt: message.createdAt,
        status: message.status,
      });
    }
    reply += message.content.slice(offset, start);
    offset = end;
  }
  return {
    reply: { ...message, content: reply + message.content.slice(offset) },
    progress,
  };
}

/** Separate the display text without changing the stored row or replay data. */
export function projectAssistantCommentary(message: UiMessage): AssistantTextProjection | undefined {
  if (!message.commentaryRanges && !message.providerReplay && !message.responseLayout) return undefined;
  if (!projections.has(message)) projections.set(message, splitAssistantText(message));
  return projections.get(message);
}
