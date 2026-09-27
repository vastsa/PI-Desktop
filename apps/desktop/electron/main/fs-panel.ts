import { readFileSync, statSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FsEntry, FsImageDataUrlResult, FsReadResult } from "@pi-desktop/shared";

/**
 * Read-only workspace file access for the work panel files tab
 * (ADR 0019). User-initiated UI browsing bypasses host-core tool
 * permissions on purpose, but stays inside the workspace root and honors
 * the default ignore subset of 15-workspace-ignore-rules.
 */

const IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  "target",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
]);

export const MAX_TEXT_BYTES = 512 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
};

const ALLOWED_IMAGE_MIME = new Set(Object.values(IMAGE_MIME));

/** Content-addressed paste/upload blobs: `attachments/<sha256>`. */
const ATTACHMENT_BLOB_RE = /^attachments\/[0-9a-f]{64}$/i;

export function isAttachmentBlobRef(path: string): boolean {
  return ATTACHMENT_BLOB_RE.test(String(path ?? "").trim().replace(/\\/g, "/"));
}

/**
 * Resolve `rel` inside `root`, rejecting absolute inputs and `..` escapes.
 * Returns the absolute path or null when the input leaves the root.
 */
export function resolveWithinRoot(root: string, rel: string): string | null {
  if (!root) return null;
  const cleanRel = String(rel ?? "").replace(/^[/\\]+/, "");
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, cleanRel);
  if (target === rootAbs) return rootAbs;
  if (!target.startsWith(rootAbs + sep)) return null;
  return target;
}

function pathIsWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Resolve a user-clicked chat file path against the workspace plus extra
 * containment roots (session scratch, attachments). Relative paths resolve
 * only inside the workspace; absolute paths must already live under one of
 * the allowed roots.
 */
export function resolveOpenablePath(
  path: string,
  workspaceRoot: string | null | undefined,
  extraRoots: readonly string[] = [],
): string | null {
  const raw = String(path ?? "").trim();
  if (!raw || raw.startsWith("~")) return null;

  const allowed = [
    ...(workspaceRoot ? [resolve(workspaceRoot)] : []),
    ...extraRoots
      .filter((root) => typeof root === "string" && root.trim())
      .map((root) => resolve(root)),
  ];
  if (allowed.length === 0) return null;

  let candidate: string;
  if (isAttachmentBlobRef(raw)) {
    const extraResolved = extraRoots
      .filter((root) => typeof root === "string" && root.trim())
      .map((root) => resolve(root));
    const attachmentRoot = extraResolved.find((root) => basename(root) === "attachments");
    if (!attachmentRoot) return null;
    const relativePath = resolveWithinRoot(
      attachmentRoot,
      raw.replace(/\\/g, "/").slice("attachments/".length),
    );
    if (!relativePath) return null;
    candidate = relativePath;
  } else if (isAbsolute(raw)) {
    candidate = resolve(raw);
  } else {
    if (!workspaceRoot) return null;
    const relativePath = resolveWithinRoot(workspaceRoot, raw);
    if (!relativePath) return null;
    candidate = relativePath;
  }

  return allowed.some((root) => pathIsWithin(root, candidate)) ? candidate : null;
}

/**
 * Same containment as `resolveOpenablePath`, then `realpath` so a symlink
 * inside an allowed root cannot be used to read a file outside it.
 */
export async function resolveRealOpenablePath(
  path: string,
  workspaceRoot: string | null | undefined,
  extraRoots: readonly string[] = [],
): Promise<string | null> {
  const lexical = resolveOpenablePath(path, workspaceRoot, extraRoots);
  if (!lexical) return null;
  const allowed = [
    ...(workspaceRoot ? [resolve(workspaceRoot)] : []),
    ...extraRoots
      .filter((root) => typeof root === "string" && root.trim())
      .map((root) => resolve(root)),
  ];
  try {
    const targetReal = await realpath(lexical);
    const realRoots = await Promise.all(
      allowed.map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return null;
        }
      }),
    );
    return realRoots.some((root) => root && pathIsWithin(root, targetReal))
      ? targetReal
      : null;
  } catch {
    return null;
  }
}

/** Resolve an existing path and its root through links before containment. */
export async function resolveRealPathWithinRoot(
  root: string,
  rel: string,
): Promise<string | null> {
  const lexical = resolveWithinRoot(root, rel);
  if (!lexical) return null;
  try {
    const [rootReal, targetReal] = await Promise.all([
      realpath(resolve(root)),
      realpath(lexical),
    ]);
    return pathIsWithin(rootReal, targetReal) ? targetReal : null;
  } catch {
    return null;
  }
}

/**
 * Containment for a path that does not exist yet. `realpath` fails on a
 * missing target, so walk up to the nearest existing ancestor, resolve *that*
 * through links, and rebuild the tail — otherwise creating a file would be
 * indistinguishable from escaping the root, and every write would be refused.
 */
export async function resolveRealPathForCreateWithinRoot(
  root: string,
  rel: string,
): Promise<string | null> {
  const lexical = resolveWithinRoot(root, rel);
  if (!lexical) return null;
  let rootReal: string;
  try {
    rootReal = await realpath(resolve(root));
  } catch {
    return null;
  }
  const tail: string[] = [];
  let cursor = lexical;
  for (;;) {
    try {
      const real = await realpath(cursor);
      const target = tail.length ? join(real, ...tail) : real;
      return pathIsWithin(rootReal, target) ? target : null;
    } catch {
      const parent = dirname(cursor);
      // Ran out of ancestors before finding one that exists: the path is not
      // under anything we can vouch for.
      if (parent === cursor) return null;
      tail.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export function isIgnoredName(name: string): boolean {
  return IGNORED_NAMES.has(name);
}

export async function listDir(root: string, rel: string): Promise<FsEntry[]> {
  const dir = await resolveRealPathWithinRoot(root, rel);
  if (!dir) throw new Error("path escapes workspace root");
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries: FsEntry[] = [];
  for (const dirent of dirents) {
    if (isIgnoredName(dirent.name)) continue;
    let kind: FsEntry["kind"];
    let size = 0;
    if (dirent.isDirectory()) {
      kind = "dir";
    } else if (dirent.isFile()) {
      kind = "file";
      try {
        size = (await stat(join(dir, dirent.name))).size;
      } catch {
        size = 0;
      }
    } else if (dirent.isSymbolicLink()) {
      // Broken links and links whose real target leaves the workspace are
      // omitted. The same real-path check runs again when opening the entry.
      try {
        const target = await resolveRealPathWithinRoot(
          root,
          rel ? `${rel}/${dirent.name}` : dirent.name,
        );
        if (!target) continue;
        const info = await stat(target);
        kind = info.isDirectory() ? "dir" : "file";
        size = info.isFile() ? info.size : 0;
      } catch {
        continue;
      }
    } else {
      continue;
    }
    entries.push({ name: dirent.name, kind, size });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8000));
  for (const byte of probe) {
    if (byte === 0) return true;
  }
  return false;
}

/**
 * Image MIME for in-app preview. A known image extension always wins so a
 * client cannot reclassify `notes.md` as `image/png`. Extension-less
 * `attachments/<sha256>` blobs use an allowlisted stored mimeType.
 */
export function imageMimeFor(displayPath: string, mimeType?: string): string | undefined {
  const base = displayPath.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (ext && IMAGE_MIME[ext]) return IMAGE_MIME[ext];
  if (ext) return undefined;
  const declared = String(mimeType ?? "").trim().toLowerCase();
  return ALLOWED_IMAGE_MIME.has(declared) ? declared : undefined;
}

/**
 * Classify one already-contained regular file for in-app preview.
 * Used by the host Files tab and by `pi.fs.readPreview` so the two
 * surfaces cannot drift on size caps or image detection.
 */
export function previewFile(
  fullPath: string,
  rel: string,
  mimeType?: string,
): FsReadResult {
  const info = statSync(fullPath);
  if (!info.isFile()) throw new Error("not a file");

  const imageMime = imageMimeFor(rel, mimeType);
  if (imageMime) {
    if (info.size > MAX_IMAGE_BYTES) {
      return { kind: "tooLarge", size: info.size };
    }
    const buffer = readFileSync(fullPath);
    if (buffer.length > MAX_IMAGE_BYTES) {
      return { kind: "tooLarge", size: buffer.length };
    }
    return {
      kind: "image",
      dataUrl: `data:${imageMime};base64,${buffer.toString("base64")}`,
      size: buffer.length,
    };
  }

  if (info.size > MAX_TEXT_BYTES) {
    return { kind: "tooLarge", size: info.size };
  }
  const buffer = readFileSync(fullPath);
  if (looksBinary(buffer)) {
    return { kind: "binary", size: info.size };
  }
  return { kind: "text", content: buffer.toString("utf8"), size: info.size };
}

export async function readWorkspaceFile(
  root: string,
  rel: string,
): Promise<FsReadResult> {
  const target = await resolveRealPathWithinRoot(root, rel);
  if (!target) throw new Error("path escapes workspace root");
  const info = await stat(target);
  if (!info.isFile()) throw new Error("not a file");
  return previewFile(target, rel);
}

/**
 * Read a workspace file, a content-addressed `attachments/<sha256>` blob, or
 * an absolute path already inside scratch/attachments. Containment matches
 * `fs/open` (D320) plus a realpath check.
 */
export async function readOpenableFile(
  path: string,
  workspaceRoot: string | null | undefined,
  extraRoots: readonly string[],
  mimeType?: string,
): Promise<FsReadResult> {
  const target = await resolveRealOpenablePath(path, workspaceRoot, extraRoots);
  if (!target) throw new Error("path outside allowed roots");
  const info = await stat(target);
  if (!info.isFile()) throw new Error("not a file");
  return previewFile(target, path, mimeType);
}

/**
 * Bounded image data URL for in-chat display. Never returns file bytes for
 * non-images, so a markdown `![](secret.txt)` cannot dump text into the
 * renderer cache.
 */
export async function readOpenableImage(
  path: string,
  workspaceRoot: string | null | undefined,
  extraRoots: readonly string[],
  mimeType?: string,
): Promise<FsImageDataUrlResult> {
  const target = await resolveRealOpenablePath(path, workspaceRoot, extraRoots);
  if (!target) {
    return { kind: "missing", errorCode: "PATH_OUTSIDE_ALLOWED_ROOT" };
  }
  try {
    const result = previewFile(target, path, mimeType);
    if (result.kind === "image" && result.dataUrl) {
      return { kind: "image", dataUrl: result.dataUrl, size: result.size };
    }
    if (result.kind === "tooLarge") {
      return { kind: "tooLarge", size: result.size, errorCode: "IMAGE_TOO_LARGE" };
    }
    return { kind: "notImage", size: result.size, errorCode: "NOT_AN_IMAGE" };
  } catch {
    return { kind: "missing", errorCode: "FILE_NOT_FOUND" };
  }
}
