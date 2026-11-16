import { readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  chooseStartupAnimation,
  STARTUP_ANIMATION_DIR_NAME,
  STARTUP_ANIMATION_MAX_BYTES,
  startupAnimationExtensionOf,
  type StartupAnimationCandidate,
  type StartupAnimationDescriptor,
} from "@pi-desktop/shared";

/**
 * Discover the user's boot animation in `<dataDir>/startup/` (D679 / ADR 0338).
 *
 * The directory is the whole configuration surface: a user drops one video in
 * and the next launch plays it. Nothing is created here — an installation that
 * never uses the feature keeps a data directory without the folder, and the
 * boot surface stays the brand splash.
 *
 * The resolved file path never leaves the main process. The renderer is handed
 * a descriptor and plays the single-file `pi-startup:` URL, so the page never
 * learns where the user's data directory is.
 */

/** A playable animation and the file behind it, which only main may know. */
export type ResolvedStartupAnimation = {
  descriptor: StartupAnimationDescriptor;
  /** Realpath of the chosen file, confined to the startup directory. */
  filePath: string;
};

export type StartupAnimationInput = {
  /** Installation data directory, as `desktopDataDir()` resolved it. */
  dataDir: string;
  /** Stored preferences; absent or unreadable settings use the defaults. */
  settings?: { startupAnimation?: unknown } | null;
};

function readPreferences(settings: StartupAnimationInput["settings"]): {
  enabled: boolean;
  skipWhenReady: boolean;
} {
  const value = settings?.startupAnimation;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { enabled: true, skipWhenReady: false };
  }
  const preferences = value as { enabled?: unknown; skipWhenReady?: unknown };
  return {
    // Absent means on: the feature is dormant without a file, so defaulting to
    // off would make dropping one in look broken.
    enabled: preferences.enabled !== false,
    skipWhenReady: preferences.skipWhenReady === true,
  };
}

/**
 * Entries of the startup directory that are confined to it.
 *
 * Confinement is by realpath rather than by name: a symlink in the directory
 * resolves wherever it points, and following one would let an animation serve
 * an arbitrary file over the host-owned scheme. Entries that escape, that are
 * not regular files, or that cannot be stat'd are dropped silently — a boot
 * surface is the wrong place to report a filesystem detail.
 */
async function confinedCandidates(
  directory: string,
): Promise<{ candidates: StartupAnimationCandidate[]; paths: Map<string, string> }> {
  const root = await realpath(directory);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const names = await readdir(root);
  const candidates: StartupAnimationCandidate[] = [];
  const paths = new Map<string, string>();
  for (const name of names) {
    // Cheap rejection before two syscalls per entry; the chooser re-checks.
    if (name.startsWith(".") || !startupAnimationExtensionOf(name)) continue;
    let resolved: string;
    try {
      resolved = await realpath(join(root, name));
    } catch {
      continue;
    }
    if (!resolved.startsWith(prefix)) continue;
    let size: number;
    try {
      const stats = await stat(resolved);
      if (!stats.isFile()) continue;
      size = stats.size;
    } catch {
      continue;
    }
    candidates.push({ fileName: name, byteLength: size });
    paths.set(name, resolved);
  }
  return { candidates, paths };
}

/**
 * The animation this launch should play, or null to keep the brand splash.
 *
 * Null covers every ordinary case as well as every failure: the setting is
 * off, the directory does not exist, it holds nothing playable, or the
 * filesystem refused the read. The caller treats them identically, which is
 * what keeps a broken animation from being a broken launch.
 */
export async function resolveStartupAnimation(
  input: StartupAnimationInput,
): Promise<ResolvedStartupAnimation | null> {
  const preferences = readPreferences(input.settings);
  if (!preferences.enabled) return null;
  const directory = join(input.dataDir, STARTUP_ANIMATION_DIR_NAME);
  let found: Awaited<ReturnType<typeof confinedCandidates>>;
  try {
    found = await confinedCandidates(directory);
  } catch {
    return null;
  }
  const chosen = chooseStartupAnimation(
    found.candidates,
    STARTUP_ANIMATION_MAX_BYTES,
  );
  if (!chosen) return null;
  const filePath = found.paths.get(chosen.fileName);
  if (!filePath) return null;
  return {
    descriptor: {
      fileName: chosen.fileName,
      extension: chosen.extension,
      byteLength: chosen.byteLength,
      skipWhenReady: preferences.skipWhenReady,
    },
    filePath,
  };
}

/** Absolute path of the directory a user drops the animation into. */
export function startupAnimationDirectory(dataDir: string): string {
  return join(dataDir, STARTUP_ANIMATION_DIR_NAME);
}
