import { readdir, readFile, realpath, stat } from "node:fs/promises";
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

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

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

/** Resolve an existing absolute path inside one allowed root through links. */
async function resolveRealAbsoluteWithinRoot(
  root: string,
  absolute: string,
): Promise<string | null> {
  if (!root) return null;
  const rootAbs = resolve(root);
  const target = resolve(absolute);
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return null;
  try {
    const [rootReal, targetReal] = await Promise.all([
      realpath(rootAbs),
      realpath(target),
    ]);
    return pathIsWithin(rootReal, targetReal) ? targetReal : null;
  } catch {
    return null;
  }
}

/**
 * Absolute message refs are only valid inside the data root's own
 * `scratch/` and `attachments/` subdirectories. Anything else under the data
 * root (logs, caches) is not a message attachment and must not be readable.
 */
async function resolveAbsoluteAttachmentPath(
  dataRoot: string,
  absolute: string,
): Promise<string | null> {
  const normalized = absolute.replace(/\\/g, "/");
  const dataPrefix = `${resolve(dataRoot).replace(/\\/g, "/")}/`;
  if (!normalized.startsWith(dataPrefix)) return null;
  const rest = normalized.slice(dataPrefix.length);
  if (!rest.startsWith("scratch/") && !rest.startsWith("attachments/")) {
    return null;
  }
  return resolveRealAbsoluteWithinRoot(dataRoot, absolute);
}

/** Resolve a stored image `ref` to its absolute path inside one allowed root. */
async function resolveReferencedPath(
  dataRoot: string,
  workspaceRoot: string | null,
  ref: string,
): Promise<string | null> {
  const trimmed = String(ref ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("attachments/")) {
    return resolveRealPathWithinRoot(
      join(dataRoot, "attachments"),
      trimmed.slice("attachments/".length),
    );
  }
  if (isAbsolute(trimmed)) {
    return resolveAbsoluteAttachmentPath(dataRoot, trimmed);
  }
  return workspaceRoot
    ? resolveRealPathWithinRoot(workspaceRoot, trimmed)
    : null;
}

/**
 * Read an image referenced by a stored message attachment (or a local
 * Markdown image) into a bounded data URL for in-chat display. The ref may be
 * a workspace-relative path, an `attachments/<sha256>` path, or an absolute
 * path inside the data root (scratch/attachments). Every resolution stays
 * inside an allowed root after real-path checks, so a malicious ref can never
 * read an arbitrary file off disk. When a stored `mimeType` is available it
 * wins over extension sniffing, because pasted attachments are stored as
 * extension-less `attachments/<sha256>` blobs.
 */
export async function readReferencedImage(
  dataRoot: string,
  workspaceRoot: string | null,
  ref: string,
  mimeType?: string,
): Promise<FsImageDataUrlResult> {
  const target = await resolveReferencedPath(dataRoot, workspaceRoot, ref);
  if (!target) {
    return { kind: "missing", errorCode: "PATH_OUTSIDE_ALLOWED_ROOT" };
  }
  let info;
  try {
    info = await stat(target);
  } catch {
    return { kind: "missing", errorCode: "FILE_NOT_FOUND" };
  }
  if (!info.isFile()) return { kind: "notImage", errorCode: "NOT_A_FILE" };
  if (info.size > MAX_IMAGE_BYTES) {
    return { kind: "tooLarge", size: info.size, errorCode: "IMAGE_TOO_LARGE" };
  }
  const declared = String(mimeType ?? "").trim().toLowerCase();
  const imageMime =
    declared.startsWith("image/") && declared !== "image/*"
      ? declared
      : (IMAGE_MIME[target.split(".").pop()?.toLowerCase() ?? ""] ?? "");
  if (!imageMime) {
    return { kind: "notImage", size: info.size, errorCode: "NOT_AN_IMAGE" };
  }
  const buffer = await readFile(target);
  // Re-check after the read so a file that grew between stat and readFile
  // cannot bypass the bound.
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { kind: "tooLarge", size: buffer.length, errorCode: "IMAGE_TOO_LARGE" };
  }
  return {
    kind: "image",
    dataUrl: `data:${imageMime};base64,${buffer.toString("base64")}`,
    size: buffer.length,
  };
}

export async function readWorkspaceFile(
  root: string,
  rel: string,
): Promise<FsReadResult> {
  const target = await resolveRealPathWithinRoot(root, rel);
  if (!target) throw new Error("path escapes workspace root");
  const info = await stat(target);
  if (!info.isFile()) throw new Error("not a file");

  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  const imageMime = IMAGE_MIME[ext];
  if (imageMime) {
    if (info.size > MAX_IMAGE_BYTES) {
      return { kind: "tooLarge", size: info.size };
    }
    const buffer = await readFile(target);
    return {
      kind: "image",
      dataUrl: `data:${imageMime};base64,${buffer.toString("base64")}`,
      size: info.size,
    };
  }

  if (info.size > MAX_TEXT_BYTES) {
    return { kind: "tooLarge", size: info.size };
  }
  const buffer = await readFile(target);
  if (looksBinary(buffer)) {
    return { kind: "binary", size: info.size };
  }
  return { kind: "text", content: buffer.toString("utf8"), size: info.size };
}
