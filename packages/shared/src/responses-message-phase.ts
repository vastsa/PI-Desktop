import type { AssistantProviderReplay } from "./types/messages.js";

/** Responses adapters encode the item ID and optional phase in textSignature. */
export function responsesTextPhase(signature: unknown): "commentary" | "final_answer" | undefined {
  if (typeof signature !== "string" || !signature.startsWith("{")) return undefined;
  try {
    const item = JSON.parse(signature) as { v?: unknown; id?: unknown; phase?: unknown } | null;
    if (item?.v === 1 && typeof item.id === "string" && item.id &&
        (item.phase === "commentary" || item.phase === "final_answer")) return item.phase;
  } catch {
    // Other providers use opaque signatures, including non-JSON strings.
  }
}

export function isResponsesCommentary(signature: unknown): boolean {
  return responsesTextPhase(signature) === "commentary";
}

/** Stored assistant text split by its explicitly marked Responses phases. */
export type ResponsesCommentarySplit = {
  /** Progress commentary in order, with its UTF-16 offset in the content. */
  commentary: { offset: number; text: string }[];
  /** The content with every commentary range removed. */
  answer: string;
};

/**
 * Split stored assistant content into commentary and answer using the replay
 * block lengths. Returns `undefined` unless the replay accounts for the whole
 * content and marks at least one non-empty commentary range, so unmarked or
 * abbreviated rows keep their text untouched (no wording heuristics).
 */
export function splitResponsesCommentary(
  content: unknown, replay: AssistantProviderReplay | undefined,
): ResponsesCommentarySplit | undefined {
  if (typeof content !== "string" || !replay || replay.version !== 1 || !Array.isArray(replay.blocks)) return undefined;
  const commentary: ResponsesCommentarySplit["commentary"] = [];
  let offset = 0;
  let answerStart = 0;
  let answer = "";
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
      answer += content.slice(answerStart, offset);
      answerStart = end;
      commentary.push({ offset, text: content.slice(offset, end) });
    }
    offset = end;
  }
  if (offset !== content.length || answerStart === 0) return undefined;
  return { commentary, answer: answer + content.slice(answerStart) };
}

/** The answer part of stored assistant content; unmarked content is returned as is. */
export function responsesAnswerText(content: string, replay: AssistantProviderReplay | undefined): string {
  return splitResponsesCommentary(content, replay)?.answer ?? content;
}
