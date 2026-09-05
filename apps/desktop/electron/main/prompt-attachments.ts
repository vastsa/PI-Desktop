/**
 * Prompt attachment preparation for the main process.
 *
 * Resolves renderer-supplied attachment paths against the session roots
 * (project, session scratch, content-addressed attachments), stores image
 * bytes as content-addressed blobs, and decides whether an image is inlined
 * for a vision-capable model or handed to the agent as a file reference.
 */
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  ErrorCodes,
  formatFileInsert,
  type AgentPromptAttachment,
  type MessageAttachment,
} from "@pi-desktop/shared";

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
  "webp",
]);
const IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};
export const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

type PromptPath = {
  absolute: string;
  root: "project" | "scratch" | "attachment";
};

export type PreparedPromptAttachment = {
  message: MessageAttachment;
  fallbackPath: string;
  inlineData?: string;
};

function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function canonicalPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function promptMimeType(path: string, supplied?: string): string {
  const value = supplied?.trim().toLowerCase();
  if (value) return value;
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return IMAGE_MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function isImagePromptAttachment(
  attachment: AgentPromptAttachment,
  path: string,
): boolean {
  const mimeType = promptMimeType(path, attachment.mimeType);
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return (
    attachment.kind === "image" ||
    mimeType.startsWith("image/") ||
    IMAGE_MIME_TYPES.has(mimeType) ||
    IMAGE_EXTENSIONS.has(extension)
  );
}

function resolvePromptPath(
  dataRoot: string,
  sessionId: string,
  projectPath: string | undefined,
  rawPath: string,
): PromptPath | undefined {
  const trimmed = rawPath.trim();
  if (!trimmed) return undefined;
  const scratchRoot = join(dataRoot, "scratch", sessionId);
  const attachmentRoot = join(dataRoot, "attachments");
  const roots: Array<{ path: string; root: PromptPath["root"] }> = [
    { path: scratchRoot, root: "scratch" },
    { path: attachmentRoot, root: "attachment" },
    ...(projectPath ? [{ path: projectPath, root: "project" as const }] : []),
  ];
  const candidate = isAbsolute(trimmed)
    ? resolve(trimmed)
    : trimmed.startsWith("attachments/")
      ? resolve(dataRoot, trimmed)
      : projectPath
        ? resolve(projectPath, trimmed)
        : undefined;
  if (!candidate) return undefined;
  const realCandidate = canonicalPath(candidate);
  if (!realCandidate) return undefined;
  for (const entry of roots) {
    const realRoot = canonicalPath(entry.path);
    if (realRoot && pathInside(realRoot, realCandidate)) {
      try {
        if (!statSync(realCandidate).isFile()) return undefined;
      } catch {
        return undefined;
      }
      return { absolute: realCandidate, root: entry.root };
    }
  }
  return undefined;
}

function displayPromptPath(
  promptPath: PromptPath,
  projectPath: string | undefined,
): string {
  if (promptPath.root !== "project" || !projectPath) return promptPath.absolute;
  const relativePath = relative(projectPath, promptPath.absolute);
  return relativePath && !relativePath.startsWith("..")
    ? relativePath
    : promptPath.absolute;
}

function ensureAttachmentBlob(dataRoot: string, bytes: Buffer): string {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const root = join(dataRoot, "attachments");
  mkdirSync(root, { recursive: true });
  const target = join(root, hash);
  if (!existsSync(target)) {
    try {
      writeFileSync(target, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
  }
  return `attachments/${hash}`;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function ensureAttachmentBlobFromFile(
  dataRoot: string,
  source: string,
): Promise<string> {
  const hash = await hashFile(source);
  const root = join(dataRoot, "attachments");
  mkdirSync(root, { recursive: true });
  const target = join(root, hash);
  if (!existsSync(target)) {
    try {
      await copyFile(source, target, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
  }
  return `attachments/${hash}`;
}

async function fallbackPathForStoredAttachment(
  dataRoot: string,
  sessionId: string,
  source: PromptPath,
  name: string,
): Promise<string> {
  if (source.root !== "attachment") return source.absolute;
  const root = join(dataRoot, "scratch", sessionId, "replayed");
  mkdirSync(root, { recursive: true });
  const safeName = name.replace(/[^\p{L}\p{N}._-]+/gu, "_") || "attachment";
  const target = join(root, `${safeName}-${createHash("sha256").update(source.absolute).digest("hex").slice(0, 12)}`);
  if (!existsSync(target)) {
    try {
      await copyFile(source.absolute, target, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
  }
  return target;
}

export async function preparePromptAttachments(
  dataRoot: string,
  sessionId: string,
  projectPath: string | undefined,
  attachments: readonly AgentPromptAttachment[],
  supportsVision: boolean,
): Promise<PreparedPromptAttachment[]> {
  const prepared: PreparedPromptAttachment[] = [];
  for (const attachment of attachments) {
    const source = resolvePromptPath(dataRoot, sessionId, projectPath, attachment.path);
    if (!source) {
      throw Object.assign(new Error(`Attachment path is outside the session roots: ${attachment.path}`), {
        errorCode: ErrorCodes.PATH_OUTSIDE_WORKSPACE,
      });
    }
    const name = attachment.name.trim() || source.absolute.split(/[\\/]/).at(-1) || "attachment";
    const mimeType = promptMimeType(source.absolute, attachment.mimeType);
    const isImage = isImagePromptAttachment(attachment, source.absolute);
    if (!isImage) {
      prepared.push({
        message: {
          kind: "file",
          name,
          ref: attachment.path,
          ...(mimeType !== "application/octet-stream" ? { mimeType } : {}),
          ...(Number.isFinite(attachment.size) ? { size: attachment.size } : {}),
        },
        fallbackPath: displayPromptPath(source, projectPath),
      });
      continue;
    }

    const size = statSync(source.absolute).size;
    const inline = supportsVision && size <= MAX_INLINE_IMAGE_BYTES;
    const bytes = inline ? await readFile(source.absolute) : undefined;
    const ref =
      source.root === "attachment" && attachment.path.trim().startsWith("attachments/")
        ? attachment.path.trim()
        : bytes
          ? ensureAttachmentBlob(dataRoot, bytes)
          : await ensureAttachmentBlobFromFile(dataRoot, source.absolute);
    const fallbackPath = inline
      ? displayPromptPath(source, projectPath)
      : await fallbackPathForStoredAttachment(
          dataRoot,
          sessionId,
          source,
          name,
        );
    prepared.push({
      message: {
        kind: "image",
        name,
        ref,
        mimeType,
        size,
      },
      fallbackPath,
      ...(bytes
        ? { inlineData: bytes.toString("base64") }
        : {}),
    });
  }
  return prepared;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Use the renderer's id for the new user row when it is a UUID the session
 * does not already hold (D288); otherwise mint one. The renderer inserted its
 * optimistic row under that id, so the durable echo lands on the same row.
 */
export function durableUserMessageId(
  requested: unknown,
  existing: ReadonlyArray<{ id?: unknown }>,
): string {
  if (
    typeof requested === "string" &&
    UUID_PATTERN.test(requested) &&
    !existing.some((message) => message?.id === requested)
  ) {
    return requested;
  }
  return crypto.randomUUID();
}

export function appendPromptFallbackPaths(
  content: string,
  attachments: readonly PreparedPromptAttachment[],
): string {
  const paths = attachments
    .filter((attachment) => !attachment.inlineData)
    .map((attachment) => formatFileInsert(attachment.fallbackPath, "file"))
    .join("")
    .trim();
  const text = content.trim();
  if (!text) return paths;
  return paths ? `${text}\n${paths}` : text;
}
