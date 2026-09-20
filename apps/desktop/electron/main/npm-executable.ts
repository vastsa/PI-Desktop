import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";

/** Injectable so installer tests never run npm. */
export type DependencyCommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  envOverrides?: Record<string, string>,
) => Promise<{ code: number; stderr: string; stdout?: string }>;

/**
 * Budget for a standalone npm/Node.js validation call, covering both probes.
 * Process startup on a loaded machine costs seconds, and a probe that runs out
 * of time is indistinguishable from a missing tool.
 */
const NPM_VALIDATION_TIMEOUT_MS = 10_000;
/**
 * Ceiling for both probes when the caller has a longer budget (dependency
 * installs and the picker). Callers with a smaller budget stay bounded by it.
 */
export const NPM_VALIDATION_BUDGET_MS = 30_000;
const DEPENDENCY_STDERR_KEEP_CHARS = 8192;
const VERSION_STDOUT_MAX_CHARS = 1024;
const SEMVER = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";

export class NpmUnavailableError extends Error {}

export function isNpmLaunchError(error: unknown): boolean {
  return error instanceof NpmUnavailableError || (
    !!error && typeof error === "object" && "code" in error &&
    ["ENOENT", "EACCES", "ENOEXEC"].includes(String(error.code))
  );
}

export const defaultDependencyRunner: DependencyCommandRunner = (
  command, args, cwd, timeoutMs, envOverrides,
) => new Promise((resolve, reject) => {
  // Only the legacy, unconfigured Windows npm command needs a shell. Selected
  // paths (including spaces/metacharacters) always use direct process spawning.
  const isolatedUserConfig = join(tmpdir(), `.pi-desktop-npm-user-${randomUUID()}.npmrc`);
  const isolatedGlobalConfig = join(tmpdir(), `.pi-desktop-npm-global-${randomUUID()}.npmrc`);
  const isolatedGit = join(tmpdir(), `.pi-desktop-npm-git-${randomUUID()}`);
  const child = spawn(command, args, {
    cwd,
    shell: process.platform === "win32" && command === "npm",
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    // Never inherit auth tokens, NODE_OPTIONS, npm config or user proxies.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
      TMPDIR: process.env.TMPDIR ?? process.env.TEMP ?? "",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      npm_config_userconfig: isolatedUserConfig,
      npm_config_globalconfig: isolatedGlobalConfig,
      npm_config_registry: "https://registry.npmjs.org/",
      npm_config_proxy: "",
      npm_config_https_proxy: "",
      npm_config_noproxy: "*",
      npm_config_git: isolatedGit,
      npm_config_cache: join(cwd, ".npm-cache"),
      npm_config_ignore_scripts: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      ...envOverrides,
    },
  });
  let stderr = "";
  let stdout = "";
  let stdoutTruncated = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdoutTruncated) return;
    stdout += chunk.toString("utf8");
    if (stdout.length > VERSION_STDOUT_MAX_CHARS) {
      stdout = "";
      stdoutTruncated = true;
    }
  });
  let timedOut = false;
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > DEPENDENCY_STDERR_KEEP_CHARS * 2) {
      stderr = stderr.slice(-DEPENDENCY_STDERR_KEEP_CHARS);
    }
  });
  const killProcessTree = (signal: NodeJS.Signals) => {
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => { child.kill(signal); });
      killer.unref();
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    stderr += `\nnpm dependency install exceeded ${timeoutMs}ms and was terminated`;
    killProcessTree("SIGTERM");
    killTimer = setTimeout(() => killProcessTree("SIGKILL"), 5_000);
  }, timeoutMs);
  const settle = (fn: () => void) => {
    // The leader may exit on SIGTERM while a descendant with ignored stdio
    // survives. Kill the remaining group before close cancels escalation.
    if (timedOut && process.platform !== "win32") killProcessTree("SIGKILL");
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    fn();
  };
  child.on("error", (err) => settle(() => reject(err)));
  child.on("close", (code) => {
    settle(() => resolve({ code: timedOut ? 1 : code ?? 1, stderr, stdout }));
  });
});

export interface NpmExecutable {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function requireFile(path: string, executable: boolean): void {
  if (!isAbsolute(path) || !statSync(path).isFile()) {
    throw new Error("Select an absolute path to a regular npm executable file");
  }
  accessSync(path, executable && process.platform !== "win32" ? constants.X_OK : constants.R_OK);
}

/** No shell probing: only the inherited PATH and the explicitly selected directory. */
export async function prepareNpmExecutable(
  npmPath?: string,
  timeoutMs = NPM_VALIDATION_TIMEOUT_MS,
): Promise<NpmExecutable> {
  const budget = Math.max(1, Math.min(timeoutMs, NPM_VALIDATION_BUDGET_MS));
  const deadline = Date.now() + budget;
  let cwd: string | undefined;
  try {
    const tool: NpmExecutable = { command: npmPath ?? "npm", args: [], env: {} };
    let node = process.platform === "win32" ? "node.exe" : "node";
    if (npmPath !== undefined) {
      requireFile(npmPath, true); // stat follows symlinks; keep the selected directory.
      const directory = dirname(npmPath);
      tool.env.PATH = `${directory}${delimiter}${process.env.PATH ?? ""}`;
      if (process.platform === "win32") {
        const extension = extname(npmPath).toLowerCase();
        if (extension === ".cmd" || extension === ".bat") {
          node = join(directory, "node.exe");
          const cli = join(directory, "node_modules", "npm", "bin", "npm-cli.js");
          requireFile(node, true);
          requireFile(cli, false);
          tool.command = node;
          tool.args = [cli];
        } else if (extension !== ".exe") {
          throw new Error("Select npm.cmd beside node.exe and node_modules/npm, or an npm .exe");
        }
      }
    }
    // An empty temporary directory prevents npm from reading a plugin/project
    // .npmrc or package.json during validation; user/global config is isolated too.
    cwd = mkdtempSync(join(tmpdir(), "pi-desktop-npm-check-"));
    const versionPatterns = { "Node.js": new RegExp(`^v${SEMVER}$`), npm: new RegExp(`^${SEMVER}$`) };
    for (const [command, args, label] of [
      [node, ["--version"], "Node.js"],
      [tool.command, [...tool.args, "--version"], "npm"],
    ] as const) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("npm/Node.js validation exceeded its time budget");
      const result = await defaultDependencyRunner(
        command, [...args], cwd, Math.max(1, remaining), tool.env,
      );
      if (result.code !== 0) {
        throw new Error(`${label} --version failed (${result.code}): ${result.stderr.trim().slice(-200)}`);
      }
      if (!versionPatterns[label].test((result.stdout ?? "").trim())) {
        // Never include arbitrary stdout in a user-visible diagnostic.
        throw new Error(`${label} --version did not return a valid ${label} version`);
      }
    }
    return tool;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NpmUnavailableError(`npm/Node.js is unavailable${npmPath ? ` at ${npmPath}` : " on PATH"}: ${message}`);
  } finally {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
}

/** Only call with a main-process-owned path selected through the native dialog. */
export async function validateNpmExecutable(
  npmPath: string,
  timeoutMs = NPM_VALIDATION_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await prepareNpmExecutable(npmPath, timeoutMs);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
