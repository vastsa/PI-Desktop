/**
 * Last-view pixel admission for provider image blocks (issue #1913).
 *
 * Host Read and prompt attachments refuse an oversized image before it is
 * persisted, but older sessions, plugin and MCP tool results can still carry
 * one. A provider rejects such an image with a non-retriable 400, and every
 * later request replays it, so the session can never continue. Replacing the
 * block with a notice is deterministic for the same bytes: the request prefix
 * stays stable across turns and prompt caching keeps working.
 */
import type { Message } from "@earendil-works/pi-ai";
import {
  imageExceedsInlineDimensions,
  omittedImageNotice,
  probeBase64ImageDimensions,
} from "@pi-desktop/shared";

type ContentBlock = Exclude<Message["content"], string>[number];

function admittedBlocks<T extends ContentBlock>(content: T[]): T[] {
  let next: T[] | undefined;
  content.forEach((block, index) => {
    if (block.type !== "image" || typeof block.data !== "string") return;
    const dimensions = probeBase64ImageDimensions(block.data);
    if (!imageExceedsInlineDimensions(dimensions)) return;
    next ??= content.slice();
    next[index] = { type: "text", text: omittedImageNotice(dimensions) } as T;
  });
  return next ?? content;
}

/**
 * Replace every image whose known pixel size exceeds the provider limit with
 * a text notice. Returns the input array when nothing was replaced.
 */
export function omitOversizedImages(messages: Message[]): Message[] {
  let next: Message[] | undefined;
  messages.forEach((message, index) => {
    if (message.role !== "user" && message.role !== "toolResult") return;
    if (!Array.isArray(message.content)) return;
    const content = admittedBlocks(message.content as ContentBlock[]);
    if (content === message.content) return;
    next ??= messages.slice();
    next[index] = { ...message, content } as Message;
  });
  return next ?? messages;
}
