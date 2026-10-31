import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/**
 * The two roots a chat reference can mean for an isolated session: the checkout
 * the user sees (the worktree) and the parent checkout the project identity
 * still points at (ADR 0329).
 */
export type WorktreeRefContext = { worktree: string; parent: string };

/**
 * Rewrite an absolute chat reference that points into the parent checkout onto
 * the same relative path inside the session's worktree.
 *
 * References can be produced before isolation or by producers that only know
 * the project path (project instructions, MCP tools, an attachment captured
 * from the parent checkout). The session's files live in the worktree, so the
 * original path is outside the allowed roots and the click fails even though
 * the branch has the same file. Relative references, paths already inside the
 * worktree, and paths with no worktree counterpart are returned unchanged so
 * the caller keeps reporting the accurate reason.
 */
export async function rebaseWorktreeRef(
  ref: string,
  context: WorktreeRefContext | null,
  isFile: (path: string) => Promise<boolean> = defaultIsFile,
): Promise<string> {
  if (!context || !isAbsolute(ref)) return ref;
  if (relativeWithin(context.worktree, ref) !== null) return ref;
  const relativePath = relativeWithin(context.parent, ref);
  if (!relativePath) return ref;
  const candidate = resolve(context.worktree, ...relativePath.split("/"));
  return (await isFile(candidate)) ? candidate : ref;
}

/**
 * The project UI treats Windows and macOS paths as case-insensitive, and a
 * reference may use either separator. Compare in normalized form without
 * changing the spelling returned to the caller.
 */
function relativeWithin(root: string, candidate: string): string | null {
  const rootPath = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const candidatePath = candidate.replaceAll("\\", "/");
  const caseInsensitive = process.platform !== "linux";
  const normalizedRoot = caseInsensitive ? rootPath.toLowerCase() : rootPath;
  const normalizedCandidate = caseInsensitive
    ? candidatePath.toLowerCase()
    : candidatePath;
  if (!normalizedCandidate.startsWith(`${normalizedRoot}/`)) return null;
  return candidatePath.slice(rootPath.length + 1);
}

async function defaultIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
