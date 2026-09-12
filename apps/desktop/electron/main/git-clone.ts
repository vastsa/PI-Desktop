import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  isGitCloneRepoName,
  parseGitCloneUrl,
} from "../../src/lib/git-clone-url.ts";

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

export function runGitClone(
  cwd: string,
  args: string[],
  timeoutMs = GIT_CLONE_TIMEOUT_MS,
): Promise<GitCloneRunResult> {
  return new Promise((resolveResult) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      windowsHide: true,
    });
    let stderr = "";
    let settled = false;
    const finish = (result: GitCloneRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        code: 1,
        stderr: "git clone timed out",
        errorCode: "TIMEOUT",
      });
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
      finish({ code: code ?? 1, stderr });
    });
  });
}

export async function cloneGitRepository(input: {
  url: string;
  parentPath: string;
  name?: string;
  run?: typeof runGitClone;
}): Promise<string> {
  const target = parseGitCloneUrl(input.url);
  if (!target) {
    throw codedError("INVALID_ARGUMENT", "Enter a git repository URL");
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
  const run = input.run ?? runGitClone;
  const result = await run(parent, ["clone", "--", target.url, dest]);
  if (result.errorCode === "NOT_FOUND") {
    throw codedError("NOT_FOUND", "Git is not installed");
  }
  if (result.errorCode === "TIMEOUT") {
    throw codedError("TIMEOUT", "git clone timed out");
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim().split("\n").at(-1) || "git clone failed";
    throw codedError("TOOL_FAILED", detail.slice(0, 280));
  }
  return dest;
}
