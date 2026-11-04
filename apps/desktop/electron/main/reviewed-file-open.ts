import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/** Explicit reveal/open of one host-authenticated review snapshot, not a path grant. */
export async function openReviewedFile(input: unknown, dependencies: {
  target: (sessionId: string, snapshotId: string) => Promise<{ path: string }>;
  isCurrent: () => boolean;
  stripPrefix: (path: string) => string;
  openPath: (path: string) => Promise<string>;
  reveal: (path: string) => void;
}): Promise<{ ok: true }> {
  if (!input || typeof input !== "object") throw new Error("review file action required");
  const value = input as Record<string, unknown>;
  const { sessionId, snapshotId, action } = value;
  if (typeof sessionId !== "string" || !sessionId || typeof snapshotId !== "string" || !snapshotId
    || (action !== "external" && action !== "folder") || "path" in value) throw new Error("invalid review file action");
  const target = await dependencies.target(sessionId, snapshotId);
  if (!dependencies.isCurrent()) throw new Error("review host replaced");
  if (!target || typeof target.path !== "string" || !isAbsolute(target.path)) throw new Error("invalid review file target");
  const actual = await realpath(target.path);
  const canonical = (path: string) => {
    const normalized = resolve(dependencies.stripPrefix(path));
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  if (canonical(actual) !== canonical(target.path) || !(await stat(actual)).isFile()) throw new Error("review file changed location or is unavailable");
  if (!dependencies.isCurrent()) throw new Error("review host replaced");
  const path = dependencies.stripPrefix(actual);
  if (action === "folder") dependencies.reveal(path);
  else {
    const error = await dependencies.openPath(path);
    if (error) throw new Error(error);
  }
  return { ok: true };
}
