/**
 * Locating the agent executable without going through a shell.
 *
 * Why this file exists: on Windows an npm-installed CLI is a `.cmd` shim, and
 * `spawn("opencode", …, { shell: false })` fails with ENOENT. Turning on
 * `shell: true` would work but hands a user-configured command line to
 * cmd.exe, which is a shell-injection surface we do not want in an app that
 * takes agent commands from settings.
 *
 * The npm shim names the real binary, though:
 *
 *     "%dp0%\node_modules\@opencode\cli\bin\opencode.exe"   %*
 *
 * So the shim is read, the target is resolved next to it, and the real `.exe`
 * is spawned directly. No shell is involved on any platform.
 *
 * `viaShell` exists only as a last resort for a shim we cannot parse; the
 * caller is expected to log when it is used.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"

export type ResolvedExecutable = {
  /** What to hand to `spawn`. */
  command: string
  /** Extra args that must precede the caller's args (a shell fallback only). */
  prefixArgs: string[]
  /** True when we could not avoid a shell. */
  viaShell: boolean
  /** Human-readable trail for logs and settings screens. */
  source: string
}

const EXECUTABLE_EXTENSIONS = [".exe", ".com"]
const SHIM_EXTENSIONS = [".cmd", ".bat"]

/** `"%dp0%\node_modules\x\bin\y.exe"` and the `"%~dp0\…"` spelling. */
const DP0_TARGET = /"%(~)?dp0%\\([^"]+)"/i

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Case-insensitive existence check, so `PATHEXT` casing does not matter. */
function fileExistsCaseInsensitive(dir: string, name: string): string | null {
  const direct = join(dir, name)
  if (isFile(direct)) return direct
  let entries: string[]
  try {
    entries = require("node:fs").readdirSync(dir) as string[]
  } catch {
    return null
  }
  const wanted = name.toLowerCase()
  for (const entry of entries) {
    if (entry.toLowerCase() === wanted && isFile(join(dir, entry))) return join(dir, entry)
  }
  return null
}

function extensionOf(path: string): string {
  const idx = path.lastIndexOf(".")
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return idx > slash ? path.slice(idx).toLowerCase() : ""
}

/**
 * Read an npm/pnpm shim and return the real binary it forwards to, if we can
 * find one that exists on disk.
 */
function targetFromShim(shimPath: string): string | null {
  let text: string
  try {
    text = readFileSync(shimPath, "utf8")
  } catch {
    return null
  }
  const match = DP0_TARGET.exec(text)
  if (!match) return null
  const dir = shimPath.slice(0, Math.max(shimPath.lastIndexOf("/"), shimPath.lastIndexOf("\\")))
  const relative = match[2].replace(/\//g, "\\")
  const resolved = join(dir, relative)
  return isFile(resolved) ? resolved : null
}

function windowsLookup(command: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)
  const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)

  // An explicit path is honoured as given, but still needs an extension.
  if (isAbsolute(command) || /[\\/]/.test(command)) {
    const found = tryFile(command, pathext)
    if (found) return found
  }

  for (const dir of dirs) {
    for (const ext of pathext) {
      const candidate = fileExistsCaseInsensitive(dir, command + ext.toLowerCase())
      if (candidate) return candidate
    }
    const bare = fileExistsCaseInsensitive(dir, command)
    if (bare) return bare
  }
  return null
}

function tryFile(base: string, pathext: string[]): string | null {
  if (isFile(base)) return base
  for (const ext of pathext) {
    if (EXECUTABLE_EXTENSIONS.includes(ext.toLowerCase()) || SHIM_EXTENSIONS.includes(ext.toLowerCase())) {
      const candidate = base + ext.toLowerCase()
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * Resolve `command` to something `spawn` can execute directly.
 *
 * @param command executable name or path
 * @param env      process env; injected for tests
 * @param platform `process.platform`; injected for tests
 */
export function resolveAcpExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): ResolvedExecutable {
  if (platform !== "win32") {
    return { command, prefixArgs: [], viaShell: false, source: "posix" }
  }

  const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
  const found = windowsLookup(command, env)
  if (!found) {
    // Nothing on PATH. cmd.exe will produce a clearer error than ENOENT.
    return {
      command: env.ComSpec ?? "cmd.exe",
      prefixArgs: ["/d", "/s", "/c", command],
      viaShell: true,
      source: "comspec-fallback",
    }
  }

  const ext = extensionOf(found)
  if (EXECUTABLE_EXTENSIONS.includes(ext)) {
    return { command: found, prefixArgs: [], viaShell: false, source: `path:${ext}` }
  }
  if (SHIM_EXTENSIONS.includes(ext)) {
    const target = targetFromShim(found)
    if (target) {
      return { command: target, prefixArgs: [], viaShell: false, source: "npm-shim" }
    }
    return {
      command: env.ComSpec ?? "cmd.exe",
      prefixArgs: ["/d", "/s", "/c", found],
      viaShell: true,
      source: "unparsed-shim",
    }
  }
  return { command: found, prefixArgs: [], viaShell: false, source: "path" }
}

/** Exported for the settings screen: can this command be launched as given? */
export function canResolveAcpExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): boolean {
  return existsSync(resolveAcpExecutable(command, env, platform).command)
}
