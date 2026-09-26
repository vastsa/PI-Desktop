/** Session-root-confined attachment hydration for restored user messages. */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  formatFileInsert,
  isSvgAttachment,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINED_IMAGE_HISTORY_BYTES,
  SVG_MIME_TYPE,
  type MessageAttachment,
  type UiMessage,
} from "@pi-desktop/shared";

export type AttachmentHistoryContext = {
  scratchDir?: string;
  projectPath?: string;
  attachmentsDir?: string;
  supportsVision: boolean;
  /**
   * Maximum aggregate raw image bytes inlined into V8 memory during history restoration
   * (default: 30,000,000 / 30 MB).
   * Older or excess images retain their file reference and fallback path without multiplying base64 heaps.
   */
  maxInlinedImageBytes?: number;
  /**
   * Optional maximum count of recent user messages eligible for inlining image attachments (default: 10).
   */
  maxInlinedImageMessages?: number;
};

function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function replayedAttachmentPath(
  params: AttachmentHistoryContext,
  attachment: NonNullable<UiMessage["attachments"]>[number],
  source: string,
): Promise<string> {
  if (!params.scratchDir || !attachment.ref.startsWith("attachments/")) {
    return source;
  }
  const root = resolve(params.scratchDir, "replayed");
  await mkdir(root, { recursive: true });
  const safeName =
    attachment.name.replace(/[^\p{L}\p{N}._-]+/gu, "_") || "attachment";
  const suffix = createHash("sha256")
    .update(attachment.ref)
    .digest("hex")
    .slice(0, 12);
  const target = resolve(root, `${safeName}-${suffix}`);
  try {
    await copyFile(source, target, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
  return target;
}

export async function hydrateAttachmentHistory(
  history: UiMessage[],
  params: AttachmentHistoryContext,
): Promise<UiMessage[]> {
  const supportsVision = params.supportsVision;
  const maxInlinedImageBytes =
    params.maxInlinedImageBytes ?? MAX_INLINED_IMAGE_HISTORY_BYTES;
  const maxInlinedImageMessages = params.maxInlinedImageMessages ?? 10;
  const roots = [
    params.scratchDir,
    params.projectPath,
    params.attachmentsDir,
  ].filter((value): value is string => Boolean(value));
  const canonicalRoots = await Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return undefined;
      }
    }),
  );

  // Pre-scan user messages from newest to oldest to allocate the cumulative inlining byte budget [P1].
  // Restricts base64 inlining to the latest N user messages within the total byte budget.
  // Excess or older images retain their file reference and fallback path without V8 heap bloat (#1077).
  const inlinableAttachmentKeys = new Set<string>();
  let remainingBudget = maxInlinedImageBytes;
  let eligibleUserMessageCount = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg?.role !== "user" || !msg.attachments?.length) continue;
    const hasImages = msg.attachments.some((a) => a.kind === "image");
    if (!hasImages) continue;
    if (eligibleUserMessageCount >= maxInlinedImageMessages) break;
    eligibleUserMessageCount += 1;

    for (let aIdx = 0; aIdx < msg.attachments.length; aIdx++) {
      const attachment = msg.attachments[aIdx];
      if (attachment?.kind !== "image") continue;
      const size = attachment.size ?? 0;
      if (size <= MAX_INLINE_IMAGE_BYTES && (remainingBudget >= size || remainingBudget === maxInlinedImageBytes)) {
        inlinableAttachmentKeys.add(`${i}:${aIdx}`);
        remainingBudget = Math.max(0, remainingBudget - size);
      }
    }
    if (remainingBudget <= 0) break;
  }

  const resolveAttachment = async (
    sourceAttachment: NonNullable<UiMessage["attachments"]>[number],
    msgIndex: number,
    attachmentIndex: number,
  ): Promise<{ attachment: MessageAttachment; fallbackPath?: string }> => {
    // Old transcripts can still label SVG as an image. Normalize before every
    // early return, and discard any stale transient data without mutating history.
    const attachment: MessageAttachment = isSvgAttachment(
      sourceAttachment.mimeType, sourceAttachment.name, sourceAttachment.ref,
    )
      ? { ...sourceAttachment, kind: "file", mimeType: SVG_MIME_TYPE, data: undefined }
      : sourceAttachment;
    const ref = attachment.ref.trim();
    if (!ref) return { attachment };
    const candidate =
      ref.startsWith("attachments/") && params.attachmentsDir
        ? resolve(params.attachmentsDir, ref.slice("attachments/".length))
        : isAbsolute(ref)
          ? resolve(ref)
          : params.projectPath
            ? resolve(params.projectPath, ref)
            : undefined;
    if (!candidate) return { attachment };
    try {
      const canonical = await realpath(candidate);
      if (!canonicalRoots.some((root) => root && pathInside(root, canonical))) {
        return { attachment };
      }
      const allowInlining = inlinableAttachmentKeys.has(`${msgIndex}:${attachmentIndex}`);
      const shouldInline = allowInlining && attachment.kind === "image" && supportsVision;
      const size = (await stat(canonical)).size;
      const bytes =
        shouldInline && size <= MAX_INLINE_IMAGE_BYTES
          ? await readFile(canonical)
          : undefined;
      if (attachment.kind === "image" && supportsVision && bytes) {
        return { attachment: { ...attachment, data: bytes.toString("base64") } };
      }
      return {
        attachment,
        fallbackPath: await replayedAttachmentPath(
          params,
          attachment,
          canonical,
        ),
      };
    } catch {
      return { attachment };
    }
  };

  return Promise.all(
    history.map(async (message, msgIndex) => {
      if (message.role !== "user" || !message.attachments?.length) return message;
      const resolved = await Promise.all(
        message.attachments.map((a, aIndex) =>
          resolveAttachment(a, msgIndex, aIndex)
        )
      );
      const fallbackPaths = resolved
        .map((item) => item.fallbackPath)
        .filter((path): path is string => Boolean(path))
        .map((path) => formatFileInsert(path, "file"))
        .join("")
        .trim();
      const content = message.content.trim()
        ? fallbackPaths
          ? `${message.content}\n${fallbackPaths}`
          : message.content
        : fallbackPaths;
      return {
        ...message,
        content,
        attachments: resolved.map((item) => item.attachment),
      };
    }),
  );
}
