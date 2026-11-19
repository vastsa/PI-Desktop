import { isResponsesCommentary, type AssistantCommentaryRange, type UiMessage } from "@pi-desktop/shared";

type AssistantTextProjection = {
  reply: UiMessage;
  progress: UiMessage[];
};

const projections = new WeakMap<UiMessage, AssistantTextProjection | undefined>();

function savedCommentaryRanges(message: UiMessage): AssistantCommentaryRange[] | undefined {
  const replay = message.providerReplay;
  if (replay?.version !== 1 || !Array.isArray(replay.blocks)) return undefined;
  const ranges: AssistantCommentaryRange[] = [];
  let offset = 0;
  for (const block of replay.blocks) {
    if (!block || (block.type !== "text" && block.type !== "thinking")) return undefined;
    if (block.type === "thinking") continue;
    if (!Number.isSafeInteger(block.length) || block.length < 0) return undefined;
    const end = offset + block.length;
    if (end > message.content.length) return undefined;
    if (end > offset && isResponsesCommentary(block.signature)) ranges.push({ start: offset, end });
    offset = end;
  }
  // The host may return abbreviated content. Do not apply offsets to text
  // other than the full string that these replay lengths describe.
  return offset === message.content.length ? ranges : undefined;
}

function splitAssistantText(message: UiMessage): AssistantTextProjection | undefined {
  const ranges = message.commentaryRanges ?? savedCommentaryRanges(message);
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
  if (!message.commentaryRanges && !message.providerReplay) return undefined;
  if (!projections.has(message)) projections.set(message, splitAssistantText(message));
  return projections.get(message);
}
