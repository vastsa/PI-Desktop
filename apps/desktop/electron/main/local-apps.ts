/**
 * Host-side discovery of installed OS applications for the plugin launcher
 * (issue #2085).
 *
 * The scan only reads well-known locations (Start Menu shortcuts, macOS
 * application bundles, freedesktop `.desktop` entries). It never spawns a
 * process: no `child_process`, no `exec`, no shell.
 *
 * Every filesystem / Electron capability is injected, so the module can be
 * imported by a plain Node test process. `createDefaultLocalAppDeps()` wires
 * the real `node:fs` + Electron `shell` / `app` implementations and is meant
 * for production only; it loads Electron through a dynamic `import()` (the
 * same pattern as `plugin-runtime.ts`), so importing this module never pulls
 * Electron into a unit test.
 */
import {
  discoverLinuxApps,
  discoverMacApps,
  discoverWindowsApps,
} from "./local-apps-platform.ts";
import { joinPath } from "./local-app-parse.ts";

export {
  LOCAL_APP_ID_PREFIX,
  parseDesktopEntry,
  localAppId,
} from "./local-app-parse.ts";
export {
  discoverLinuxApps,
  discoverMacApps,
  discoverWindowsApps,
} from "./local-apps-platform.ts";

/** Where a discovered entry came from. */
export type LocalAppSource = "start-menu" | "app-bundle" | "desktop-entry";

/**
 * One launchable application.
 *
 * `launchTarget` is the absolute path the main process opens. It must never
 * leave the main process: the IPC layer strips it (and maps `id` to a
 * renderer-facing entry) before anything reaches the renderer, so a
 * compromised renderer cannot make the host open an arbitrary path.
 */
export interface DiscoveredApp {
  id: string;
  name: string;
  executableName?: string;
  source: LocalAppSource;
  launchTarget: string;
  iconPath?: string;
  /**
   * Platform icon as a data URL, present only when one was produced and it
   * fitted the size budget. Icons are cached between scans, so a rescan does
   * not pay for the same lookup again.
   */
  iconDataUrl?: string;
}

/** Resolved contents of a Windows shortcut (`.lnk`). */
export interface ShortcutInfo {
  target: string;
  args?: string;
  icon?: string;
  iconIndex?: number;
}

/** Minimal image handle; `NativeImage` from Electron satisfies it. */
export interface FileIcon {
  toDataURL(): string;
}

/**
 * Injected host capabilities. Nothing in this file touches the real system
 * directly, which keeps every platform reader unit-testable.
 */
export interface LocalAppDeps {
  /** `process.platform` value ("win32", "darwin", "linux", ...). */
  platform: string;
  /** Windows Start Menu program directories, recursive. */
  startMenuDirs: string[];
  /** macOS bundle roots (`/Applications`, ...) or Linux `.desktop` roots. */
  appDirectories: string[];
  /** Immediate children of a directory, as absolute paths (files + dirs). */
  listFiles(directory: string): Promise<string[]>;
  readText(file: string): Promise<string>;
  pathExists(target: string): Promise<boolean>;
  /** Recursively collected `*.lnk` paths below a Start Menu directory. */
  listShortcutTargets(directory: string): Promise<string[]>;
  readShortcutLink(shortcutPath: string): ShortcutInfo | null;
  /** `CFBundleExecutable` of a bundle, or `null` when unavailable. */
  readBundleExecutable(bundlePath: string): string | null;
  getFileIcon(target: string): Promise<FileIcon | null>;
  /** Electron `shell.openPath`; a non-empty return value is an error string. */
  openPath(target: string): Promise<string>;
}

export interface LocalAppCatalogOptions {
  /** Cache lifetime before the next `list()` rescans. Default 5 minutes. */
  ttlMs?: number;
  /** Hard cap on returned entries. Default 600. */
  maxEntries?: number;
  /** Hard cap on icon lookups per scan. Default 200. */
  maxIcons?: number;
  /** Data URLs longer than this are dropped. Default 32 KiB. */
  maxIconBytes?: number;
  /** Injectable clock, used by the TTL tests. */
  now?: () => number;
}

export interface LocalAppScan {
  apps: DiscoveredApp[];
  /** Non-fatal I/O problems collected while scanning. */
  diagnostics: string[];
  scannedAt: number;
}

export interface LocalAppCatalog {
  /** Memoized scan; joins an in-flight scan, rescans after the TTL. */
  list(): Promise<DiscoveredApp[]>;
  /** Force a fresh scan. */
  refresh(): Promise<DiscoveredApp[]>;
  /** Launch a previously discovered id; never accepts a caller-supplied path. */
  launch(appId: string): Promise<void>;
  isScanning(): boolean;
  /** Diagnostics of the most recent scan. */
  diagnostics(): string[];
}

export const LOCAL_APP_TTL_MS = 5 * 60_000;
export const LOCAL_APP_MAX_ENTRIES = 600;
export const LOCAL_APP_MAX_ICONS = 200;
export const LOCAL_APP_MAX_ICON_BYTES = 32_768;

/**
 * Icons harvested across scans: `icon:<id>:<path>` -> data URL.
 *
 * Keyed by both the stable id and the path the icon came from, so an
 * application that is reinstalled elsewhere is not served a stale image.
 */
export type LocalAppIconCache = Map<string, string>;

export function localAppIconCacheKey(app: DiscoveredApp): string | null {
  const target = app.iconPath ?? app.launchTarget;
  return target ? `icon:${app.id}:${target}` : null;
}

/**
 * Keep only the icons the current scan can still use, then trim to the cap.
 *
 * Insertion order is the oldest entry first, so an overflowing cache drops the
 * least recently fetched icons rather than growing without bound.
 */
function pruneIconCache(
  cache: LocalAppIconCache,
  apps: readonly DiscoveredApp[],
  limit: number,
): void {
  const live = new Set<string>();
  for (const app of apps) {
    const key = localAppIconCacheKey(app);
    if (key) live.add(key);
  }
  for (const key of [...cache.keys()]) {
    if (!live.has(key)) cache.delete(key);
  }
  while (cache.size > Math.max(0, limit)) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export interface ScanLimits {
  maxEntries: number;
  maxIcons: number;
  maxIconBytes: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareByName(left: DiscoveredApp, right: DiscoveredApp): number {
  const byName = left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
  });
  return byName !== 0 ? byName : left.id.localeCompare(right.id);
}

/** Keep one entry per id, preferring the shortest (then alphabetical) name. */
function dedupeById(apps: DiscoveredApp[]): DiscoveredApp[] {
  const byId = new Map<string, DiscoveredApp>();
  for (const app of apps) {
    const existing = byId.get(app.id);
    if (!existing) {
      byId.set(app.id, app);
      continue;
    }
    const shorter = app.name.length !== existing.name.length
      ? app.name.length < existing.name.length
      : app.name < existing.name;
    if (shorter) byId.set(app.id, app);
  }
  return [...byId.values()];
}

async function attachIcons(
  apps: DiscoveredApp[],
  deps: LocalAppDeps,
  diagnostics: string[],
  maxIconBytes: number,
  cache: LocalAppIconCache | undefined,
): Promise<void> {
  for (const app of apps) {
    const target = app.iconPath ?? app.launchTarget;
    if (!target) continue;
    const key = localAppIconCacheKey(app);
    const cached = key ? cache?.get(key) : undefined;
    if (cached) {
      // A rescan reuses the icon it already paid for; the platform lookup is
      // the expensive part of a scan and nothing about it changed.
      app.iconDataUrl = cached;
      continue;
    }
    try {
      const icon = await deps.getFileIcon(target);
      if (!icon) continue;
      const dataUrl = icon.toDataURL();
      if (typeof dataUrl !== "string") continue;
      if (dataUrl.length === 0 || dataUrl.length > maxIconBytes) continue;
      app.iconDataUrl = dataUrl;
      if (key) cache?.set(key, dataUrl);
    } catch (error) {
      // Icons are cosmetic: a failing lookup must never fail the scan.
      diagnostics.push(`icon lookup failed for ${app.name}: ${errorMessage(error)}`);
    }
  }
}

async function discoverPlatformApps(
  deps: LocalAppDeps,
  diagnostics: string[],
): Promise<DiscoveredApp[]> {
  if (deps.platform === "win32") return discoverWindowsApps(deps, diagnostics);
  if (deps.platform === "darwin") return discoverMacApps(deps, diagnostics);
  if (deps.platform === "linux") return discoverLinuxApps(deps, diagnostics);
  diagnostics.push(`unsupported platform for local app discovery: ${deps.platform}`);
  return [];
}

/**
 * Run one complete scan. Never throws: I/O problems are reported through
 * `diagnostics` and the successfully discovered entries are still returned.
 */
export async function scanLocalApps(
  deps: LocalAppDeps,
  limits: Partial<ScanLimits> = {},
  iconCache?: LocalAppIconCache,
): Promise<LocalAppScan> {
  const resolved: ScanLimits = {
    maxEntries: limits.maxEntries ?? LOCAL_APP_MAX_ENTRIES,
    maxIcons: limits.maxIcons ?? LOCAL_APP_MAX_ICONS,
    maxIconBytes: limits.maxIconBytes ?? LOCAL_APP_MAX_ICON_BYTES,
  };
  const diagnostics: string[] = [];
  let discovered: DiscoveredApp[] = [];
  try {
    discovered = await discoverPlatformApps(deps, diagnostics);
  } catch (error) {
    // Defensive: platform readers already isolate their own failures.
    diagnostics.push(`local app scan failed: ${errorMessage(error)}`);
    discovered = [];
  }
  const apps = dedupeById(discovered)
    .sort(compareByName)
    .slice(0, resolved.maxEntries);
  await attachIcons(
    apps.slice(0, resolved.maxIcons),
    deps,
    diagnostics,
    resolved.maxIconBytes,
    iconCache,
  );
  if (iconCache) pruneIconCache(iconCache, apps, resolved.maxIcons);
  return { apps, diagnostics, scannedAt: Date.now() };
}

/**
 * Build the memoizing application catalog used by the main process.
 *
 * `list()` returns the cached scan when it is younger than the TTL and joins
 * an in-flight scan instead of starting a second one. `launch()` resolves the
 * id against the last scan result only: the caller can never supply a path.
 */
export function createLocalAppCatalog(
  deps: LocalAppDeps,
  options: LocalAppCatalogOptions = {},
): LocalAppCatalog {
  const ttlMs = options.ttlMs ?? LOCAL_APP_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const limits: ScanLimits = {
    maxEntries: options.maxEntries ?? LOCAL_APP_MAX_ENTRIES,
    maxIcons: options.maxIcons ?? LOCAL_APP_MAX_ICONS,
    maxIconBytes: options.maxIconBytes ?? LOCAL_APP_MAX_ICON_BYTES,
  };

  let cache: LocalAppScan | null = null;
  let inFlight: Promise<LocalAppScan> | null = null;
  /** Icons survive across scans; `scanLocalApps` prunes what no longer exists. */
  const iconCache: LocalAppIconCache = new Map();

  function startScan(): Promise<LocalAppScan> {
    if (inFlight) return inFlight;
    const scan = scanLocalApps(deps, limits, iconCache)
      .catch((error: unknown): LocalAppScan => ({
        apps: [],
        diagnostics: [`local app scan failed: ${errorMessage(error)}`],
        scannedAt: now(),
      }))
      .then((result) => {
        const stamped: LocalAppScan = { ...result, scannedAt: now() };
        cache = stamped;
        return stamped;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = scan;
    return scan;
  }

  async function ensureScan(force: boolean): Promise<LocalAppScan> {
    if (!force && cache && now() - cache.scannedAt < ttlMs) return cache;
    if (inFlight) return inFlight;
    return startScan();
  }

  async function list(): Promise<DiscoveredApp[]> {
    const scan = await ensureScan(false);
    return [...scan.apps];
  }

  async function refresh(): Promise<DiscoveredApp[]> {
    // A scan already running would otherwise be handed back as "fresh"; wait
    // for it and then start a genuinely new one.
    if (inFlight) await inFlight.catch(() => undefined);
    const scan = await startScan();
    return [...scan.apps];
  }

  async function launch(appId: string): Promise<void> {
    if (typeof appId !== "string" || !appId.startsWith("app:")) {
      throw new Error(`Unknown application id: ${String(appId)}`);
    }
    // Resolve against the last scan result only. A missing cache means the
    // launcher asked before the first scan, so run one.
    const scan = cache ?? (await ensureScan(false));
    const app = scan.apps.find((candidate) => candidate.id === appId);
    if (!app) throw new Error(`Unknown application id: ${appId}`);
    const present = await deps.pathExists(app.launchTarget);
    if (!present) {
      if (cache) {
        cache = {
          ...cache,
          apps: cache.apps.filter((candidate) => candidate.id !== appId),
        };
      }
      void refresh().catch(() => undefined);
      throw new Error(`Application "${app.name}" is no longer installed`);
    }
    const failure = await deps.openPath(app.launchTarget);
    if (typeof failure === "string" && failure.length > 0) {
      throw new Error(`Failed to launch "${app.name}": ${failure}`);
    }
  }

  return {
    list,
    refresh,
    launch,
    isScanning: () => inFlight !== null,
    diagnostics: () => [...(cache?.diagnostics ?? [])],
  };
}

/** Windows Start Menu directories, as injected by the caller. */
export function windowsStartMenuDirs(
  env: Record<string, string | undefined>,
): string[] {
  const roots = [env.APPDATA, env.ProgramData, env.PUBLIC];
  const dirs: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    const dir = joinPath(joinPath(root, "Microsoft"), "Windows/Start Menu/Programs");
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

export function macAppDirectories(homeDir: string): string[] {
  return [
    "/Applications",
    "/System/Applications",
    "/System/Applications/Utilities",
    joinPath(homeDir, "Applications"),
  ];
}

export function linuxApplicationDirectories(homeDir: string): string[] {
  return [
    "/usr/share/applications",
    "/usr/local/share/applications",
    joinPath(joinPath(homeDir, ".local"), "share/applications"),
  ];
}

/**
 * Production wiring: real `node:fs` plus Electron `shell` / `app`.
 *
 * Only production code may call this. Electron is loaded dynamically so the
 * module stays importable from `node --test` (where `electron` resolves to a
 * plain path string, not the runtime API).
 */
export async function createDefaultLocalAppDeps(): Promise<LocalAppDeps> {
  const [fs, fsSync, electron] = await Promise.all([
    import("node:fs/promises"),
    import("node:fs"),
    import("electron"),
  ]);
  const { app, shell } = electron;
  const homeDir = app.getPath("home");
  const platform = process.platform;

  return {
    platform,
    startMenuDirs: platform === "win32" ? windowsStartMenuDirs(process.env) : [],
    appDirectories: platform === "darwin"
      ? macAppDirectories(homeDir)
      : platform === "linux"
        ? linuxApplicationDirectories(homeDir)
        : [],
    async listFiles(directory) {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      return entries.map((entry) => joinPath(directory, entry.name));
    },
    async readText(file) {
      return fs.readFile(file, "utf8");
    },
    async pathExists(target) {
      try {
        await fs.access(target);
        return true;
      } catch {
        return false;
      }
    },
    async listShortcutTargets(directory) {
      const shortcuts: string[] = [];
      const walk = async (current: string, depth: number): Promise<void> => {
        if (depth > 8) return;
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
          // An unreadable subdirectory must not abort the whole Start Menu.
          return;
        }
        for (const entry of entries) {
          const child = joinPath(current, entry.name);
          if (entry.isDirectory()) await walk(child, depth + 1);
          else if (entry.name.toLowerCase().endsWith(".lnk")) shortcuts.push(child);
        }
      };
      await walk(directory, 0);
      return shortcuts;
    },
    readShortcutLink(shortcutPath) {
      try {
        const details = shell.readShortcutLink(shortcutPath);
        return {
          target: details.target,
          args: details.args,
          icon: details.icon,
          iconIndex: details.iconIndex,
        };
      } catch {
        return null;
      }
    },
    readBundleExecutable(bundlePath) {
      try {
        const info = fsSync.readFileSync(
          joinPath(joinPath(bundlePath, "Contents"), "Info.plist"),
          "utf8",
        );
        const match = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(info);
        const executable = match?.[1]?.trim();
        return executable && executable.length > 0 ? executable : null;
      } catch {
        return null;
      }
    },
    async getFileIcon(target) {
      try {
        // `large` is the 32px native icon: at the panel's tile size the small
        // variant reads as a blurry square. Oversized results are dropped by
        // the byte budget instead of being downscaled here.
        const icon = await app.getFileIcon(target, { size: "large" });
        return icon ?? null;
      } catch {
        return null;
      }
    },
    async openPath(target) {
      return shell.openPath(target);
    },
  };
}
