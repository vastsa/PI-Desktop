import { realpathSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import nodePath from "node:path";

/**
 * Host env keys a stdio MCP child may inherit. Provider keys and shell secrets
 * stay out (D018). Profile / toolchain locations are required so `npx` and
 * `uvx` can find `node` / `uv` the way a terminal would.
 */
export const MCP_STDIO_HOST_ENV_KEYS = [
  "PATH",
  "Path",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PATHEXT",
  "ComSpec",
  "COMSPEC",
  "FNM_DIR",
  "FNM_ARCH",
  "NVM_HOME",
  "NVM_SYMLINK",
  "VOLTA_HOME",
  "CARGO_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
] as const;

const DEFAULT_WIN_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC";

const NODE_LAUNCHERS: Record<string, true> = {
  node: true,
  npm: true,
  npx: true,
  pnpm: true,
  yarn: true,
};
const UV_LAUNCHERS: Record<string, true> = { uv: true, uvx: true };

export type McpLaunchFs = {
  isFile: (path: string) => boolean;
  realpath: (path: string) => string;
};

export type McpStdioLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
};

export type McpStdioLaunchOptions = {
  command: string;
  args: string[];
  env: Record<string, string>;
  platform?: NodeJS.Platform;
  hostEnv?: NodeJS.ProcessEnv;
  home?: string;
  fs?: McpLaunchFs;
};

function pathFor(platform: string): nodePath.PlatformPath {
  return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

function defaultFs(): McpLaunchFs {
  return {
    isFile: (target) => {
      try {
        return statSync(target).isFile();
      } catch {
        return false;
      }
    },
    realpath: (target) => {
      try {
        return realpathSync(target);
      } catch {
        return target;
      }
    },
  };
}

function hostValue(
  hostEnv: NodeJS.ProcessEnv,
  key: string,
  win32: boolean,
): string | undefined {
  const direct = hostEnv[key];
  if (typeof direct === "string" && direct.length > 0) return direct;
  if (!win32) return undefined;
  const found = Object.keys(hostEnv).find((entry) => entry.toLowerCase() === key.toLowerCase());
  const value = found ? hostEnv[found] : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hostPath(hostEnv: NodeJS.ProcessEnv, win32: boolean): string {
  return hostValue(hostEnv, "PATH", win32) ?? hostValue(hostEnv, "Path", win32) ?? "";
}

function launcherName(command: string, paths: nodePath.PlatformPath): string {
  return paths
    .basename(command)
    .toLowerCase()
    .replace(/\.(cmd|bat|exe|ps1)$/i, "");
}

function pathextList(hostEnv: NodeJS.ProcessEnv, win32: boolean): string[] {
  if (!win32) return [""];
  const raw = hostValue(hostEnv, "PATHEXT", win32) ?? DEFAULT_WIN_PATHEXT;
  const exts = raw
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  // Official Node ships an extensionless Git-Bash `npx` next to `npx.cmd`.
  // Windows PATHEXT order must win so spawn never picks the shell script.
  return [...exts, ""];
}

function lookOnPath(
  name: string,
  pathValue: string,
  paths: nodePath.PlatformPath,
  exts: string[],
  isFile: (path: string) => boolean,
): string | undefined {
  for (const dir of pathValue.split(paths.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const variants = ext
        ? [...new Set([ext.toLowerCase(), ext, ext.toUpperCase()])]
        : [""];
      for (const variant of variants) {
        const candidate = paths.join(dir, `${name}${variant}`);
        if (isFile(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

function firstFile(candidates: string[], isFile: (path: string) => boolean): string | undefined {
  return candidates.find(isFile);
}

function discoverFnmNode(
  hostEnv: NodeJS.ProcessEnv,
  home: string,
  paths: nodePath.PlatformPath,
  fs: McpLaunchFs,
  win32: boolean,
): string | undefined {
  const localApp = hostValue(hostEnv, "LOCALAPPDATA", win32) ?? paths.join(home, "AppData", "Local");
  const dataHome = hostValue(hostEnv, "XDG_DATA_HOME", win32) ?? paths.join(home, ".local", "share");
  const roots = [
    hostValue(hostEnv, "FNM_DIR", win32),
    paths.join(localApp, "fnm"),
    paths.join(home, ".fnm"),
    paths.join(dataHome, "fnm"),
    paths.join(home, "Library", "Application Support", "fnm"),
  ].filter((root): root is string => Boolean(root));
  const binaries = win32
    ? (versionDir: string) => [
        paths.join(versionDir, "installation", "node.exe"),
        paths.join(versionDir, "node.exe"),
        paths.join(versionDir, "installation", "bin", "node.exe"),
      ]
    : (versionDir: string) => [
        paths.join(versionDir, "installation", "bin", "node"),
        paths.join(versionDir, "bin", "node"),
        paths.join(versionDir, "installation", "node"),
      ];
  for (const root of roots) {
    const versionDir = fs.realpath(paths.join(root, "aliases", "default"));
    const found = firstFile(binaries(versionDir), fs.isFile);
    if (found) return found;
  }
  return undefined;
}

function discoverNvmWindowsNode(
  hostEnv: NodeJS.ProcessEnv,
  paths: nodePath.PlatformPath,
  isFile: (path: string) => boolean,
): string | undefined {
  const symlink = hostValue(hostEnv, "NVM_SYMLINK", true);
  const programFiles = hostValue(hostEnv, "ProgramFiles", true) ?? paths.join("C:", "Program Files");
  return firstFile(
    [
      ...(symlink ? [paths.join(symlink, "node.exe")] : []),
      paths.join(programFiles, "nodejs", "node.exe"),
    ],
    isFile,
  );
}

function discoverVoltaNode(
  hostEnv: NodeJS.ProcessEnv,
  home: string,
  paths: nodePath.PlatformPath,
  isFile: (path: string) => boolean,
  win32: boolean,
): string | undefined {
  const volta = hostValue(hostEnv, "VOLTA_HOME", win32) ?? paths.join(home, ".volta");
  return firstFile(
    [paths.join(volta, "bin", win32 ? "node.exe" : "node")],
    isFile,
  );
}

function discoverUnixNode(
  home: string,
  paths: nodePath.PlatformPath,
  isFile: (path: string) => boolean,
): string | undefined {
  return firstFile(
    [
      paths.join(home, ".local", "share", "fnm", "aliases", "default", "bin", "node"),
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
    ],
    isFile,
  );
}

export function discoverNodeExecutable(
  options: Pick<McpStdioLaunchOptions, "platform" | "hostEnv" | "home" | "fs">,
): string | undefined {
  const platform = options.platform ?? process.platform;
  const hostEnv = options.hostEnv ?? process.env;
  const home = options.home ?? osHomedir();
  const fs = options.fs ?? defaultFs();
  const paths = pathFor(platform);
  const win32 = platform === "win32";
  const onPath = lookOnPath("node", hostPath(hostEnv, win32), paths, pathextList(hostEnv, win32), fs.isFile);
  if (onPath) return onPath;
  return (
    discoverFnmNode(hostEnv, home, paths, fs, win32) ??
    (win32 ? discoverNvmWindowsNode(hostEnv, paths, fs.isFile) : undefined) ??
    discoverVoltaNode(hostEnv, home, paths, fs.isFile, win32) ??
    (win32 ? undefined : discoverUnixNode(home, paths, fs.isFile))
  );
}

export function discoverUvExecutable(
  options: Pick<McpStdioLaunchOptions, "platform" | "hostEnv" | "home" | "fs">,
): string | undefined {
  const platform = options.platform ?? process.platform;
  const hostEnv = options.hostEnv ?? process.env;
  const home = options.home ?? osHomedir();
  const fs = options.fs ?? defaultFs();
  const paths = pathFor(platform);
  const win32 = platform === "win32";
  const exts = pathextList(hostEnv, win32);
  const onPath = lookOnPath("uv", hostPath(hostEnv, win32), paths, exts, fs.isFile);
  if (onPath) return onPath;
  const cargo = hostValue(hostEnv, "CARGO_HOME", win32) ?? paths.join(home, ".cargo");
  const localBin = paths.join(home, ".local", "bin");
  return firstFile(
    win32
      ? [
          paths.join(localBin, "uv.exe"),
          paths.join(cargo, "bin", "uv.exe"),
          paths.join(home, "AppData", "Roaming", "uv", "uv.exe"),
        ]
      : [
          paths.join(localBin, "uv"),
          paths.join(cargo, "bin", "uv"),
          "/opt/homebrew/bin/uv",
          "/usr/local/bin/uv",
        ],
    fs.isFile,
  );
}

function siblingTool(
  executable: string,
  name: string,
  paths: nodePath.PlatformPath,
  isFile: (path: string) => boolean,
  win32: boolean,
): string | undefined {
  const dir = paths.dirname(executable);
  const candidates = win32
    ? [`${name}.exe`, `${name}.cmd`, name]
    : [name, `${name}.exe`];
  return firstFile(
    candidates.map((file) => paths.join(dir, file)),
    isFile,
  );
}

function npxCliFromNode(
  nodePath: string,
  paths: nodePath.PlatformPath,
  isFile: (path: string) => boolean,
): string | undefined {
  const dir = paths.dirname(nodePath);
  return firstFile(
    [
      paths.join(dir, "node_modules", "npm", "bin", "npx-cli.js"),
      paths.join(dir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
      paths.join(dir, "..", "node_modules", "npm", "bin", "npx-cli.js"),
    ],
    isFile,
  );
}

function npmCliFromNode(
  nodePath: string,
  paths: nodePath.PlatformPath,
  isFile: (path: string) => boolean,
): string | undefined {
  const dir = paths.dirname(nodePath);
  return firstFile(
    [
      paths.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
      paths.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      paths.join(dir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
    ],
    isFile,
  );
}

function isCmdShim(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command);
}

/**
 * Quote one argument for `cmd.exe /d /s /c`. Arguments stay literal: `&` `|`
 * inside quotes are data, not a second command.
 */
export function quoteWindowsCmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"]/.test(arg) && !/[&<>()^|%!]/.test(arg)) return arg;
  // Escape % so cmd.exe does not expand environment variables inside quotes,
  // then double internal quotes so they survive the cmd parser.
  return `"${arg.replace(/%/g, "%%").replace(/"/g, '""')}"`;
}

function wrapCmdShim(
  file: string,
  args: string[],
  hostEnv: NodeJS.ProcessEnv,
  paths: nodePath.PlatformPath,
): Pick<McpStdioLaunch, "command" | "args" | "windowsHide" | "windowsVerbatimArguments"> {
  const comspec =
    hostValue(hostEnv, "ComSpec", true) ??
    hostValue(hostEnv, "COMSPEC", true) ??
    paths.join(hostValue(hostEnv, "SystemRoot", true) ?? "C:\\Windows", "System32", "cmd.exe");
  const line = [file, ...args].map(quoteWindowsCmdArg).join(" ");
  // Outer quotes survive cmd.exe /s /c stripping — it removes the first and
  // last quote, keeping inner quoting intact even when the .cmd path has spaces.
  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsHide: true,
    windowsVerbatimArguments: true,
  };
}

function prependPath(
  pathValue: string,
  dirs: string[],
  delimiter: string,
  win32: boolean,
): string {
  const existing = pathValue.split(delimiter).filter(Boolean);
  const seen = new Set(existing.map((dir) => (win32 ? dir.toLowerCase() : dir)));
  const extra: string[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const key = win32 ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(dir);
  }
  return [...extra, ...existing].join(delimiter);
}

function withToolPath(
  env: Record<string, string>,
  executable: string | undefined,
  paths: nodePath.PlatformPath,
  win32: boolean,
): Record<string, string> {
  if (!executable) return env;
  const dir = paths.dirname(executable);
  const current = env.PATH ?? env.Path ?? "";
  const next = prependPath(current, [dir], paths.delimiter, win32);
  const out = { ...env, PATH: next };
  if ("Path" in out && win32) out.Path = next;
  return out;
}

/**
 * Turn a configured stdio command into something `spawn({ shell: false })`
 * can actually start: resolve `npx`/`uvx` onto real binaries (fnm, uv,
 * nvm-windows, PATH), rewrite npm shims to `node` + `npx-cli.js`, and wrap
 * remaining Windows `.cmd` files with `cmd.exe` so arguments stay literal.
 */
export function resolveMcpStdioLaunch(options: McpStdioLaunchOptions): McpStdioLaunch {
  const platform = options.platform ?? process.platform;
  const hostEnv = options.hostEnv ?? process.env;
  const home = options.home ?? osHomedir();
  const fs = options.fs ?? defaultFs();
  const paths = pathFor(platform);
  const win32 = platform === "win32";
  const command = options.command.trim();
  const args = options.args;
  const name = launcherName(command, paths);
  const discoverOpts = { platform, hostEnv, home, fs };

  let env = options.env;
  let launchCommand = command;
  let launchArgs = args;
  let windowsHide: boolean | undefined;
  let windowsVerbatimArguments: boolean | undefined;

  if (NODE_LAUNCHERS[name]) {
    const node = discoverNodeExecutable(discoverOpts);
    env = withToolPath(env, node, paths, win32);
    if (node && (name === "npx" || name === "npm")) {
      const cli =
        name === "npx" ? npxCliFromNode(node, paths, fs.isFile) : npmCliFromNode(node, paths, fs.isFile);
      if (cli) {
        launchCommand = node;
        launchArgs = [cli, ...args];
      } else {
        const shim = siblingTool(node, name, paths, fs.isFile, win32);
        if (shim) launchCommand = shim;
      }
    } else if (node && name === "node") {
      launchCommand = node;
    } else if (node) {
      const shim = siblingTool(node, name, paths, fs.isFile, win32);
      if (shim) {
        launchCommand = shim;
      } else {
        const found = lookOnPath(name, hostPath(hostEnv, win32), paths, pathextList(hostEnv, win32), fs.isFile);
        if (found) launchCommand = found;
      }
    }
    if (launchCommand === command) {
      const found = lookOnPath(name, hostPath(hostEnv, win32), paths, pathextList(hostEnv, win32), fs.isFile);
      if (found) {
        launchCommand = found;
        env = withToolPath(env, found, paths, win32);
      }
    }
  } else if (UV_LAUNCHERS[name]) {
    const uv = discoverUvExecutable(discoverOpts);
    env = withToolPath(env, uv, paths, win32);
    if (uv && name === "uvx") {
      const uvx = siblingTool(uv, "uvx", paths, fs.isFile, win32);
      if (uvx && !isCmdShim(uvx)) {
        launchCommand = uvx;
      } else {
        launchCommand = uv;
        launchArgs = ["tool", "run", ...args];
      }
    } else if (uv) {
      launchCommand = uv;
    }
  } else if (paths.isAbsolute(command) && fs.isFile(command)) {
    env = withToolPath(env, command, paths, win32);
  } else {
    const found = lookOnPath(name, hostPath(hostEnv, win32), paths, pathextList(hostEnv, win32), fs.isFile);
    if (found) {
      launchCommand = found;
      env = withToolPath(env, found, paths, win32);
    }
  }

  if (win32 && isCmdShim(launchCommand)) {
    const wrapped = wrapCmdShim(launchCommand, launchArgs, hostEnv, paths);
    launchCommand = wrapped.command;
    launchArgs = wrapped.args;
    windowsHide = wrapped.windowsHide;
    windowsVerbatimArguments = wrapped.windowsVerbatimArguments;
  } else if (win32) {
    windowsHide = true;
  }

  return {
    command: launchCommand,
    args: launchArgs,
    env,
    windowsHide,
    windowsVerbatimArguments,
  };
}

/** Decode MCP child stderr; cmd.exe on Windows writes the ANSI/OEM code page. */
export function decodeMcpStderr(
  chunk: Buffer | string,
  platform: NodeJS.Platform = process.platform,
  oem = false,
): string {
  if (typeof chunk === "string") return chunk;
  if (platform !== "win32" || !oem) return chunk.toString("utf8");
  try {
    return new TextDecoder("gbk").decode(chunk);
  } catch {
    return chunk.toString("utf8");
  }
}
