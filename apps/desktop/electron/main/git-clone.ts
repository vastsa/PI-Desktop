import { spawn } from "node:child_process";
import { existsSync, lstatSync, statSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  isGitCloneRepoName,
  parseGitCloneUrl,
} from "../../src/lib/git-clone-url.ts";
import {
  allowInsecureUserEndpointsEnabled,
  noteInsecureUserEndpoint,
} from "./endpoint-policy.ts";

export { parseGitCloneUrl } from "../../src/lib/git-clone-url.ts";

export const GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { errorCode: code });
}

export type GitCloneRunResult = {
  code: number;
  stderr: string;
  errorCode?: string;
};

/**
 * How long a timed-out clone may take to exit after SIGTERM before it is
 * force-killed. `close` fires only once git and every helper that inherited
 * its stdio (`git-remote-https`, `index-pack`) have exited, so the
 * destination is no longer being written when the result resolves.
 */
export const GIT_CLONE_KILL_GRACE_MS = 15 * 1000;

export function runGitClone(
  cwd: string,
  args: string[],
  timeoutMs = GIT_CLONE_TIMEOUT_MS,
  options: { command?: string; killGraceMs?: number } = {},
): Promise<GitCloneRunResult> {
  const killGraceMs = options.killGraceMs ?? GIT_CLONE_KILL_GRACE_MS;
  return new Promise((resolveResult) => {
    const child = spawn(options.command ?? "git", args, {
      cwd,
      env: process.env,
      windowsHide: true,
    });
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: GitCloneRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolveResult(result);
    };
    const timedOutResult = (): GitCloneRunResult => ({
      code: 1,
      stderr: "git clone timed out",
      errorCode: "TIMEOUT",
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Resolving before the process tree is gone would let the caller
      // clean the destination while git still writes to it (on Windows
      // `kill` is TerminateProcess and leaves helpers running).
      graceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(timedOutResult());
      }, killGraceMs);
    }, timeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        code: 1,
        stderr: error.message,
        errorCode: error.code === "ENOENT" ? "NOT_FOUND" : "INTERNAL",
      });
    });
    child.on("close", (code) => {
      finish(timedOut ? timedOutResult() : { code: code ?? 1, stderr });
    });
  });
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A timed-out clone leaves the half-built checkout git was killed inside;
 * keeping it makes every retry of the same name hit CONFLICT until the user
 * finds and deletes the residue by hand. Only called for a destination that
 * was absent before git started, so everything there belongs to this clone.
 * A symlink at the destination is unlinked instead of recursed into.
 */
async function removeIncompleteClone(dest: string): Promise<void> {
  try {
    if (lstatSync(dest).isSymbolicLink()) unlinkSync(dest);
    else await rm(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    // ENOENT: the clone died before creating anything.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn("[git-clone] could not remove incomplete clone after timeout", {
      code: (error as NodeJS.ErrnoException).code,
    });
  }
}

export async function cloneGitRepository(input: {
  url: string;
  parentPath: string;
  name?: string;
  run?: typeof runGitClone;
}): Promise<string> {
  const target = parseGitCloneUrl(input.url, {
    allowInsecureHttp: allowInsecureUserEndpointsEnabled(),
  });
  if (!target) {
    throw codedError("INVALID_ARGUMENT", "Enter a git repository URL");
  }
  if (target) {
    try {
      const parsed = new URL(input.url);
      // A plaintext hop to the user's own git host is worth one notice.
      if (parsed.protocol === "http:" || parsed.protocol === "git:") {
        noteInsecureUserEndpoint(parsed.hostname.toLowerCase().replace(/\.+$/, ""));
      }
    } catch {
      // An scp-style remote (`git@host:path`) carries no scheme, hence no
      // plaintext URL to report.
    }
  }
  const name = input.name ?? target.name;
  if (!isGitCloneRepoName(name)) {
    throw codedError("INVALID_ARGUMENT", "Enter a git repository URL");
  }
  const parent = resolve(input.parentPath);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw codedError("NOT_FOUND", "Choose a folder to clone into");
  }
  const dest = resolve(parent, name);
  const rel = relative(parent, dest);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw codedError("INVALID_ARGUMENT", "Enter a git repository URL");
  }
  if (existsSync(dest)) {
    throw codedError("CONFLICT", `"${name}" already exists in that folder`);
  }
  // `existsSync` follows symlinks; a dangling link still occupies the name.
  const destPreexisted = pathEntryExists(dest);
  const run = input.run ?? runGitClone;
  const result = await run(parent, ["clone", "--", target.url, dest]);
  if (result.errorCode === "NOT_FOUND") {
    throw codedError("NOT_FOUND", "Git is not installed");
  }
  if (result.errorCode === "TIMEOUT") {
    if (!destPreexisted) await removeIncompleteClone(dest);
    throw codedError("TIMEOUT", "git clone timed out");
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim().split("\n").at(-1) || "git clone failed";
    throw codedError("TOOL_FAILED", detail.slice(0, 280));
  }
  return dest;
}
