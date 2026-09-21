import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

async function resolveGitDirectory(workspacePath: string): Promise<string> {
  const dotGitPath = join(workspacePath, ".git");

  try {
    const pointer = await readFile(dotGitPath, "utf8");
    const match = pointer.match(/^gitdir:\s*(.+)$/m);
    if (match?.[1]) {
      return resolve(workspacePath, match[1].trim());
    }
  } catch {
    // Standard repositories store .git as a directory, so reading it fails.
  }

  return dotGitPath;
}

export async function withGitBranch<
  T extends { path?: string; name?: string } | null | undefined,
>(workspace: T): Promise<T> {
  if (!workspace || !workspace.path) return workspace;

  try {
    const gitDirectory = await resolveGitDirectory(workspace.path);
    const head = await readFile(join(gitDirectory, "HEAD"), "utf8");
    const match = head.match(/ref:\s*refs\/heads\/(.+)$/m);
    return {
      ...workspace,
      branch: match?.[1]?.trim() || "detached",
    };
  } catch {
    return { ...workspace, branch: undefined };
  }
}
