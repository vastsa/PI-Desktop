import { isUserSuppliedHostname } from "@pi-desktop/shared";

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
 * A clone remote is an address the user typed, so it may be a LAN or loopback
 * git host — a self-hosted GitLab on 192.168.x.x, a local `git daemon` — under
 * the same trust rule as every other user-supplied endpoint. Cloud metadata
 * hosts stay refused. Host checks are syntactic; git performs its own DNS/SSH.
 *
 * Plain `http`/`git` carries whatever credentials the endpoint accepts over a
 * plaintext hop, so — like every other user-supplied endpoint — it needs the
 * relaxed `networkPolicy.mode` (`allowInsecureHttp`); `https`, `ssh` and
 * `git@host:path` need no opt-in and stay allowed by default.
 */
function isAllowedGitHost(host: string): boolean {
  return isUserSuppliedHostname(host);
}
export function parseGitCloneUrl(
  raw: string | null | undefined,
  options?: { allowInsecureHttp?: boolean },
): GitCloneTarget | null {
  const allowInsecureHttp = options?.allowInsecureHttp === true;
  const url = raw?.trim() ?? "";
  if (!url || url.length > 2048 || /\s/.test(url)) return null;

  const scp = url.match(SCP_GIT);
  if (scp) {
    if (!isAllowedGitHost(scp[1])) return null;
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
  if (
    (parsed.protocol === "http:" || parsed.protocol === "git:") &&
    !allowInsecureHttp
  ) {
    return null;
  }
  if (parsed.password) return null;
  if (!isAllowedGitHost(parsed.hostname)) return null;
  const name = repoNameFromPath(parsed.pathname);
  return name ? { url, name } : null;
}

export function isGitCloneRepoName(name: string): boolean {
  return REPO_NAME.test(name);
}
