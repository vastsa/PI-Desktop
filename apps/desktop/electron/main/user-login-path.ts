/**
 * Login-shell PATH for GUI-launched Electron (issue #571).
 *
 * Finder/Dock starts the app with `/usr/bin:/bin:/usr/sbin:/sbin`. MCP stdio
 * spawn uses `shell: false` and that PATH, so `uvx`/`npx` from Homebrew/nvm
 * become `ENOENT`. Host-core already probes the login shell for Bash
 * (ADR 0045); stdio MCP lives in Electron main and needs the same PATH.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const PROBE_TIMEOUT_MS = 5_000;

export type LoginPathProbe = () => string | undefined;

/** `null` means not probed yet; `undefined` means the probe produced nothing. */
let cachedProbe: string | undefined | null = null;

export function resetUserLoginPathCacheForTests(): void {
  cachedProbe = null;
}

function defaultProbe(): string | undefined {
  if (process.platform === "win32") return undefined;
  const shell = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && existsSync(candidate),
  );
  if (!shell) return undefined;
  try {
    const result = spawnSync(shell, ["-lic", 'printf %s "$PATH"'], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || result.error || typeof result.stdout !== "string") {
      return undefined;
    }
    const path = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
    return path || undefined;
  } catch {
    return undefined;
  }
}

/** Directories a login shell usually puts on PATH, if they exist on disk. */
export function wellKnownUserBinDirs(home = homedir()): string[] {
  if (process.platform === "win32") return [];
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
  ].filter((dir) => existsSync(dir));
}

export function mergePathParts(...groups: Array<string | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    if (!group) continue;
    for (const part of group.split(delimiter)) {
      if (!part || seen.has(part)) continue;
      seen.add(part);
      out.push(part);
    }
  }
  return out.join(delimiter);
}

export function probedLoginPath(probe: LoginPathProbe = defaultProbe): string | undefined {
  if (cachedProbe !== null) return cachedProbe;
  cachedProbe = probe() ?? undefined;
  return cachedProbe;
}

/**
 * PATH a GUI-launched stdio child should search: login-shell PATH, then
 * well-known user bins that exist, then the inherited process PATH.
 * Windows keeps the inherited PATH (ADR 0045).
 */
export function userLookupPath(
  inherited = process.env.PATH ?? "",
  probe: LoginPathProbe = defaultProbe,
): string {
  if (process.platform === "win32") return inherited;
  return mergePathParts(probedLoginPath(probe), wellKnownUserBinDirs().join(delimiter), inherited);
}

