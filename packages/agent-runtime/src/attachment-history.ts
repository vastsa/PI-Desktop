/** Session-root-confined attachment hydration for restored user messages. */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, open, realpath, stat } from "node:fs/promises";
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

type ResolvedAttachment = {
  attachment: MessageAttachment;
  canonicalPath?: string;
  size?: number;
  fallbackPath?: string;
  inlined?: boolean;
};

export type AttachmentHistoryContext = {
  scratchDir?: string;
  projectPath?: string;
  attachmentsDir?: string;
  supportsVision: boolean;
  /**
   * Maximum aggregate raw image bytes inlined during history restoration
   * (default: 30 MB, hard-capped by MAX_INLINED_IMAGE_HISTORY_BYTES).
   * The newest attachments are considered first; older ones use the safe path fallback.
   */
  maxInlinedImageBytes?: number;
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

/** Read only the size already admitted by the history budget. */
async function readFileAtRecordedSize(
  path: string,
  expectedSize: number,
): Promise<Buffer | undefined> {
  const file = await open(path, "r");
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size !== expectedSize) return undefined;
    const bytes = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        expectedSize - offset,
        offset,
      );
      if (bytesRead === 0) return undefined;
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}

export async function hydrateAttachmentHistory(
  history: UiMessage[],
  params: AttachmentHistoryContext,
): Promise<UiMessage[]> {
  const supportsVision = params.supportsVision;
  const requestedBudget = params.maxInlinedImageBytes;
  const maxInlinedImageBytes =
    requestedBudget === undefined || !Number.isFinite(requestedBudget)
      ? MAX_INLINED_IMAGE_HISTORY_BYTES
      : Math.min(
          MAX_INLINED_IMAGE_HISTORY_BYTES,
          Math.max(0, Math.floor(requestedBudget)),
        );
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

  const resolveAttachment = async (
    sourceAttachment: NonNullable<UiMessage["attachments"]>[number],
  ): Promise<ResolvedAttachment> => {
    // History from the host never contains transient data. Strip stale in-memory
    // payloads as well so a caller cannot bypass the aggregate hydration budget.
    const cleanAttachment: MessageAttachment = {
      ...sourceAttachment,
      data: undefined,
    };
    const attachment: MessageAttachment = isSvgAttachment(
      sourceAttachment.mimeType,
      sourceAttachment.name,
      sourceAttachment.ref,
    )
      ? { ...cleanAttachment, kind: "file", mimeType: SVG_MIME_TYPE }
      : cleanAttachment;
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
      const size = (await stat(canonical)).size;
      const canInline =
        supportsVision &&
        attachment.kind === "image" &&
        size <= MAX_INLINE_IMAGE_BYTES;
      if (canInline) return { attachment, canonicalPath: canonical, size };
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

  const resolvedHistory = await Promise.all(
    history.map(async (message) => {
      if (message.role !== "user" || !message.attachments?.length) return undefined;
      return Promise.all(message.attachments.map(resolveAttachment));
    }),
  );

  // Allocate the byte budget in reverse transcript order, then reverse attachment
  // order within a message. This preserves every image when the history fits while
  // keeping the most recent visual context when the aggregate exceeds the cap.
  let remainingBytes = maxInlinedImageBytes;
  const selectedForInlining: ResolvedAttachment[] = [];
  for (let messageIndex = resolvedHistory.length - 1; messageIndex >= 0; messageIndex--) {
    const resolved = resolvedHistory[messageIndex];
    if (!resolved) continue;
    for (let attachmentIndex = resolved.length - 1; attachmentIndex >= 0; attachmentIndex--) {
      const item = resolved[attachmentIndex];
      if (
        !item?.canonicalPath ||
        item.size === undefined ||
        item.size > remainingBytes
      ) {
        continue;
      }
      remainingBytes -= item.size;
      selectedForInlining.push(item);
    }
  }

  await Promise.all(
    selectedForInlining.map(async (item) => {
      try {
        const bytes = await readFileAtRecordedSize(item.canonicalPath!, item.size!);
        if (!bytes) return;
        item.attachment = {
          ...item.attachment,
          data: bytes.toString("base64"),
        };
        item.inlined = true;
      } catch {
        // A failed transient read should not prevent the remaining history restoring.
      }
    }),
  );

  const fallbackTasks: Promise<void>[] = [];
  for (const resolved of resolvedHistory) {
    if (!resolved) continue;
    for (const item of resolved) {
      if (!item.canonicalPath || item.inlined) continue;
      fallbackTasks.push(
        (async () => {
          try {
            item.fallbackPath = await replayedAttachmentPath(
              params,
              item.attachment,
              item.canonicalPath!,
            );
          } catch {
            // Path fallback is best-effort, matching the existing restore contract.
          }
        })(),
      );
    }
  }
  await Promise.all(fallbackTasks);

  return history.map((message, index) => {
    const resolved = resolvedHistory[index];
    if (!resolved) return message;
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
  });
}
