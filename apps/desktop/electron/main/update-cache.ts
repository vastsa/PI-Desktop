/**
 * The electron-updater download cache: where it lives, and what may be reclaimed.
 *
 * electron-updater resolves the cache as `<base cache path>/<updaterCacheDirName>`.
 * The base path is `%LOCALAPPDATA%` on Windows, `~/Library/Caches` on macOS,
 * and `$XDG_CACHE_HOME` or `~/.cache` on Linux. The directory name is generated
 * into the packaged `app-update.yml` by electron-builder. An installation on
 * another drive therefore keeps a second full copy of every installer on the
 * system drive, and the downloaded installer stays there for the whole life of
 * the version (#1098).
 *
 * `pending/` holds the downloaded installer and must survive relocation too: the
 * app may have been closed before the downloaded update was installed. It can be
 * removed only once the feed reports that the running version is current. At the
 * cache root, the installer copy and `current.blockmap` are differential-download
 * cache even when downloads are relocated, so the next launch adopts those files.
 * The old directory is removed only if it is empty; unrelated files are left
 * alone rather than recursively deleted.
 */
import { copyFile, cp, mkdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** Base cache directory override; an absolute path to the cache's parent. */
export const UPDATE_CACHE_DIR_ENV = "PI_DESKTOP_UPDATE_CACHE_DIR";
/** Download staging directory inside the cache directory. */
export const UPDATE_DOWNLOAD_DIR_NAME = "pending";
/** NSIS baseline copy (`CURRENT_APP_INSTALLER_FILE_NAME`). */
export const UPDATE_INSTALLER_BASELINE_NAME = "installer.exe";
/** Installed-version block map used alongside the differential baseline. */
export const UPDATE_BLOCKMAP_BASELINE_NAME = "current.blockmap";

export type UpdateCachePathInput = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
};

/** Mirror electron-updater's unexported `getAppCacheDir()` implementation. */
export function defaultUpdateCacheBasePath(input: UpdateCachePathInput): string {
  const { platform, env, home } = input;
  if (platform === "win32") {
    return env.LOCALAPPDATA || join(home, "AppData", "Local");
  }
  if (platform === "darwin") return join(home, "Library", "Caches");
  return env.XDG_CACHE_HOME || join(home, ".cache");
}

/**
 * An absolute `PI_DESKTOP_UPDATE_CACHE_DIR`, or null to keep the default.
 * Relative paths are ignored because a packaged app's working directory is
 * arbitrary and can change between launches.
 */
export function resolveUpdateCacheOverride(
  value: string | undefined,
): string | null {
  const requested = value?.trim();
  if (!requested || !isAbsolute(requested)) return null;
  return resolve(requested);
}

/**
 * The cache directory name from electron-builder's packaged feed configuration.
 * Reject path separators and traversal before joining or deleting any directory.
 */
export function readUpdaterCacheDirName(appUpdateConfig: string): string | null {
  const match = /^updaterCacheDirName:[ \t]*['"]?([^'"\r\n]+?)['"]?[ \t]*$/m.exec(
    appUpdateConfig,
  );
  const name = match?.[1]?.trim() ?? "";
  if (!name || name === "." || name.includes("..") || !/^[A-Za-z0-9@._-]+$/.test(name)) {
    return null;
  }
  return name;
}

/** Cache directory for a given base and the packaged updater name. */
export function updateCacheDirFor(
  baseCachePath: string,
  dirName: string,
): string {
  return join(baseCachePath, dirName);
}

/** Compare cache paths with Windows' case-insensitive path semantics. */
export function sameUpdateCacheDir(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const resolved = [resolve(left), resolve(right)];
  return platform === "win32"
    ? resolved[0].toLowerCase() === resolved[1].toLowerCase()
    : resolved[0] === resolved[1];
}

/**
 * Redirect an updater instance without passing an AppAdapter to its constructor.
 * electron-updater 6.8.9 sets `httpExecutor` to null when a custom adapter is
 * passed; shadowing the base cache path on its default adapter preserves the
 * feed transport and packaged configuration lookup.
 */
export function relocateUpdateCacheBasePath(
  app: object,
  baseCachePath: string,
): void {
  Object.defineProperty(app, "baseCachePath", { value: baseCachePath });
}

/** Remove downloaded installer staging, preserving differential baselines. */
export async function discardDownloadedUpdate(cacheDir: string): Promise<void> {
  await rm(join(cacheDir, UPDATE_DOWNLOAD_DIR_NAME), {
    recursive: true,
    force: true,
  });
}

/**
 * Adopt a relocated cache by moving its installed-version differential baselines
 * and any pending installer out of the legacy user cache. Missing baselines are
 * safe: electron-updater falls back to a full download. A pending update is
 * preserved because the app may have been closed before installing it. Unknown
 * files remain untouched, and the legacy directory is removed only when empty.
 */
export async function adoptRelocatedUpdateCache(
  activeCacheDir: string,
  legacyCacheDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (sameUpdateCacheDir(activeCacheDir, legacyCacheDir, platform)) return;
  await mkdir(activeCacheDir, { recursive: true });
  for (const name of [
    UPDATE_INSTALLER_BASELINE_NAME,
    UPDATE_BLOCKMAP_BASELINE_NAME,
  ]) {
    const legacyBaseline = join(legacyCacheDir, name);
    const activeBaseline = join(activeCacheDir, name);
    if ((await isFile(legacyBaseline)) && !(await exists(activeBaseline))) {
      await moveFile(legacyBaseline, activeBaseline);
    }
  }
  const legacyPending = join(legacyCacheDir, UPDATE_DOWNLOAD_DIR_NAME);
  const activePending = join(activeCacheDir, UPDATE_DOWNLOAD_DIR_NAME);
  if ((await isDirectory(legacyPending)) && !(await exists(activePending))) {
    await moveDirectory(legacyPending, activePending);
  }
  try {
    await rmdir(legacyCacheDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") {
      throw error;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Move a directory, falling back to recursive copy across volumes. */
async function moveDirectory(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  await cp(from, to, { recursive: true, errorOnExist: true, force: false });
  await rm(from, { recursive: true, force: true });
}

/** Move a file, falling back to a copy when the directories are on different volumes. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  await copyFile(from, to);
  await rm(from, { force: true });
}
