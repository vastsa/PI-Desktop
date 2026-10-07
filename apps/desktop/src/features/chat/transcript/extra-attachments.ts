import { isRenderableAttachment, splitInlineContent, type MessageAttachment } from "@pi-desktop/shared";
import { splitChatText } from "../../../lib/chat-links.ts";

/**
 * Attachments that still need their own place in the message: the ones already
 * represented by a verified inline file link, and the ones the body names at
 * their inline position (`inlinePath`), stay where the user put them.
 */
export function getExtraMessageAttachments(
  content: string,
  attachments: readonly MessageAttachment[] | undefined,
  workspaceRoot?: string | null,
): (MessageAttachment & { kind: "file" | "image" })[] {
  if (!attachments?.length) return [];
  const renderable = attachments.filter(isRenderableAttachment);
  if (!renderable.length) return [];
  const inline = new Set(
    splitChatText(content, workspaceRoot)
      .map((segment) => segment.kind === "target" && segment.target.kind === "file"
        ? segment.target.path
        : null)
      .filter((path): path is string => path !== null),
  );
  return splitInlineContent(content, renderable).trailing.filter(
    (attachment) => !inline.has(attachment.ref),
  );
}
