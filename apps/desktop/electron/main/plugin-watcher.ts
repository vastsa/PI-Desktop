import { lstatSync, readdirSync, watch as fsWatch } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Debounce window for a source edit. Editors write several files in a burst
 * (save-all, formatter, bundler), and a plugin reload kills a process — one
 * reload per burst, not one per file.
 */
export const RELOAD_DEBOUNCE_MS = 300;

/**
 * Recursive watches are not free (one FSEvents stream or inotify tree each),
 * and nobody develops sixteen plugins at once. Past the cap we log and stop.
 */
export const MAX_WATCHED_PLUGINS = 16;

/** Directories a plugin's own build output and tooling live in. */
export const IGNORED_WATCH_DIRS = ["node_modules", ".git", "dist", "target"];

/** Bound the metadata inventory; never descend into dependencies or symlinks. */
const MAX_WATCHED_ENTRIES = 10_000;

type WatchedPlugin = {
  dir: string;
  stamps: Map<string, string>;
  handle?: WatchHandle;
};

function sourceStamp(file: string): string | undefined {
  try {
    const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!stat) return undefined;
    // Windows emits fs.watch events for reads when NTFS updates last access.
    // Access/change timestamps are not source edits. Identity also catches an
    // editor's atomic replacement with a preserved modification time and size.
    return `${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function sourceStamps(dir: string): Map<string, string> {
  const stamps = new Map<string, string>();
  const pending = [""];
  let entries = 0;
  while (pending.length) {
    const relative = pending.pop()!;
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (isIgnoredWatchPath(name)) continue;
      if (++entries > MAX_WATCHED_ENTRIES) {
        throw new Error(`source watch limit reached (${MAX_WATCHED_ENTRIES}); use manual reload`);
      }
      const stamp = sourceStamp(join(dir, name));
      if (stamp === undefined) continue;
      stamps.set(name, stamp);
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(name);
    }
  }
  return stamps;
}

export type WatchHandle = { close: () => void };

export type WatchFactory = (
  dir: string,
  onEvent: (relative: string) => void,
) => WatchHandle;

export type DevPluginWatcherDeps = {
  /** Re-runs the plugin from disk. Never rejects: it reports through audit. */
  reload: (pluginId: string) => Promise<void>;
  /** Diagnostics: watcher could not start, or the cap was reached. */
  onProblem?: (pluginId: string, message: string) => void;
  /** Injected in tests; defaults to a recursive `fs.watch`. */
  watch?: WatchFactory;
  debounceMs?: number;
  max?: number;
};

/**
 * Build output and VCS noise must not trigger a reload: a plugin that writes
 * into its own `dist/` while loading would otherwise reload forever.
 */
export function isIgnoredWatchPath(relative: string): boolean {
  if (!relative || isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return true;
  const segments = relative.split(/[\\/]/);
  if (segments.includes("..")) return true;
  if (segments.some((segment) => IGNORED_WATCH_DIRS.includes(segment))) return true;
  const file = segments[segments.length - 1] ?? "";
  // Editor scratch files: JetBrains `___jb_tmp___`, vim `4913`, macOS metadata.
  return file === ".DS_Store" || file.endsWith("~") || file.includes("___jb_");
}

/** Recursive where the platform allows it, flat where it does not. */
const defaultWatch: WatchFactory = (dir, onEvent) => {
  const listener = (_event: string, filename: string | Buffer | null) => {
    onEvent(typeof filename === "string" ? filename : (filename?.toString() ?? ""));
  };
  try {
    return fsWatch(dir, { recursive: true }, listener);
  } catch {
    // Older Linux kernels reject recursive watches; the plugin root still
    // covers manifest.json and the entry point, which is most of the loop.
    return fsWatch(dir, listener);
  }
};

/**
 * Watches development plugin directories and asks for a reload when their
 * sources change, so editing a plugin never means re-picking its folder.
 */
export class DevPluginWatcher {
  private watches = new Map<string, WatchedPlugin>();
  private timers = new Map<string, NodeJS.Timeout>();
  private readonly watch: WatchFactory;
  private readonly debounceMs: number;
  private readonly max: number;
  private readonly deps: DevPluginWatcherDeps;

  // Plain field assignment, not a parameter property: the desktop tests import
  // this module through Node's strip-only TypeScript support, which rejects
  // `constructor(private deps: …)`.
  constructor(deps: DevPluginWatcherDeps) {
    this.deps = deps;
    this.watch = deps.watch ?? defaultWatch;
    this.debounceMs = deps.debounceMs ?? RELOAD_DEBOUNCE_MS;
    this.max = deps.max ?? MAX_WATCHED_PLUGINS;
  }

  get size(): number {
    return this.watches.size;
  }

  isWatching(pluginId: string): boolean {
    return this.watches.has(pluginId);
  }

  /** Idempotent: re-watching a plugin replaces its previous watch. */
  add(pluginId: string, dir: string): void {
    this.remove(pluginId);
    if (this.watches.size >= this.max) {
      this.deps.onProblem?.(
        pluginId,
        `watcher limit reached (${this.max}); edits will need a manual reload`,
      );
      return;
    }
    try {
      const watched: WatchedPlugin = { dir, stamps: sourceStamps(dir) };
      watched.handle = this.watch(dir, (relative) => {
        if (this.watches.get(pluginId) !== watched) return;
        this.onEvent(pluginId, relative);
      });
      this.watches.set(pluginId, watched);
    } catch (error) {
      this.deps.onProblem?.(pluginId, `watch failed: ${(error as Error).message}`);
    }
  }

  remove(pluginId: string): void {
    const timer = this.timers.get(pluginId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(pluginId);
    }
    const handle = this.watches.get(pluginId);
    if (!handle) return;
    this.watches.delete(pluginId);
    try {
      handle.handle?.close();
    } catch {
      // Already closed by the platform.
    }
  }

  disposeAll(): void {
    for (const pluginId of [...this.watches.keys()]) this.remove(pluginId);
  }

  private onEvent(pluginId: string, relative: string): void {
    relative = relative.replaceAll("\\", "/");
    if (isIgnoredWatchPath(relative)) return;
    const watched = this.watches.get(pluginId);
    if (!watched) return;
    try {
      const stamp = sourceStamp(join(watched.dir, relative));
      if (watched.stamps.get(relative) === stamp) return;
      if (stamp === undefined) watched.stamps.delete(relative);
      else watched.stamps.set(relative, stamp);
    } catch (error) {
      this.deps.onProblem?.(pluginId, `watch stat failed: ${(error as Error).message}`);
      return;
    }
    const existing = this.timers.get(pluginId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(pluginId);
      if (this.watches.get(pluginId) !== watched) return;
      // Include sources inside a newly added/moved directory before onLoad
      // reads them. Those reads must not start a second reload.
      try {
        watched.stamps = sourceStamps(watched.dir);
      } catch (error) {
        this.deps.onProblem?.(pluginId, `watch inventory failed: ${(error as Error).message}`);
      }
      void this.deps.reload(pluginId);
    }, this.debounceMs);
    // A pending reload must not hold the app open at quit.
    timer.unref?.();
    this.timers.set(pluginId, timer);
  }
}
