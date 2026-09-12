export type GitCloneTarget = {
  url: string;
  name: string;
};

const REPO_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const SCP_GIT = /^git@([A-Za-z0-9.-]+):(.+)$/;

function repoNameFromPath(path: string): string | null {
  const segment =
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() ?? "";
  const name = segment.replace(/\.git$/i, "");
  if (!name || name === "." || name === ".." || !REPO_NAME.test(name)) {
    return null;
  }
  return name;
}

/**
 * Accept https/http/ssh/git URLs and `git@host:path` remotes. Reject
 * credentials-in-URL, file URLs, and names that cannot be a folder.
 */
export function parseGitCloneUrl(raw: string | null | undefined): GitCloneTarget | null {
  const url = raw?.trim() ?? "";
  if (!url || url.length > 2048 || /\s/.test(url)) return null;

  const scp = url.match(SCP_GIT);
  if (scp) {
    const name = repoNameFromPath(scp[2]);
    return name ? { url, name } : null;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) {
    return null;
  }
  if (parsed.password) return null;
  const name = repoNameFromPath(parsed.pathname);
  return name ? { url, name } : null;
}

export function isGitCloneRepoName(name: string): boolean {
  return REPO_NAME.test(name);
}
