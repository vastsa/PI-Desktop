import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { FsReadResult } from "@pi-desktop/shared";
import { isAttachmentBlobRef, previewFile, resolveRealOpenablePath } from "./workspace-files.js";

/**
 * A file the user explicitly clicked that lives outside every root the app
 * manages (ADR 0339).
 *
 * The agent names files by their exact absolute path, and it works on files
 * anywhere the user points it: a download, a chat client's folder, the system
 * temp directory. Root containment cannot cover those locations. Opening a file
 * the user clicked only shows it to that same user on this machine — nothing
 * reaches the model or the network — so no path is withheld. The shape stays
 * narrow: an exact absolute path whose real target is an existing regular file.
 */

export type ExternalFileResolution =
  | { kind: "file"; path: string }
  /** Absolute, but no regular file exists there. */
  | { kind: "missing" }
  /** Not an absolute path; external resolution does not apply. */
  | { kind: "notAbsolute" };

/**
 * Resolve an absolute path to the real path of an existing regular file. A
 * home shorthand, an attachment blob reference, and any relative path are not
 * external references; directories and other non-files count as missing.
 */
export async function resolveExternalFile(path: string): Promise<ExternalFileResolution> {
  const raw = String(path ?? "").trim();
  if (!raw || raw.includes("\0") || raw.startsWith("~") || isAttachmentBlobRef(raw) || !isAbsolute(raw)) {
    return { kind: "notAbsolute" };
  }
  try {
    const real = await realpath(resolve(raw));
    if (!(await stat(real)).isFile()) return { kind: "missing" };
    return { kind: "file", path: real };
  } catch {
    return { kind: "missing" };
  }
}

/**
 * The real path a user-initiated open may act on: a path contained in the
 * managed roots answers first, and otherwise an absolute external regular file.
 */
export async function resolveUserOpenablePath(
  path: string,
  workspaceRoot: string | null | undefined,
  extraRoots: readonly string[],
): Promise<string | null> {
  const contained = await resolveRealOpenablePath(path, workspaceRoot, extraRoots);
  if (contained) return contained;
  const external = await resolveExternalFile(path);
  return external.kind === "file" ? external.path : null;
}

/** `readOpenableFile`, widened to absolute external files (ADR 0339). */
export async function readUserOpenableFile(
  path: string,
  workspaceRoot: string | null | undefined,
  extraRoots: readonly string[],
  mimeType?: string,
): Promise<FsReadResult> {
  const target = await resolveUserOpenablePath(path, workspaceRoot, extraRoots);
  if (!target) throw new Error("path outside allowed roots");
  const info = await stat(target);
  if (!info.isFile()) throw new Error("not a file");
  return previewFile(target, path, mimeType);
}
