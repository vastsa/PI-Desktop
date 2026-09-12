import { lstat, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

/** Mirrors host-core `copy_dir_filtered`: these never enter a package. */
export const IGNORED_DIR_NAMES = new Set([".git", "node_modules"]);
/** host-core `MAX_PACKAGE_FILES` (crates/host-core/src/plugins.rs). */
export const MAX_PACKAGE_FILES = 2000;
/** host-core `MAX_PACKAGE_BYTES` (crates/host-core/src/plugins.rs). */
export const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

/**
 * Credential files that must never ship, whatever an author left in the
 * working tree. Matched against the basename at any depth.
 */
export const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env$/,
  /^\.env\./,
  /^\.npmrc$/,
  /\.pem$/,
  /\.key$/,
];

export type WalkedFile = {
  /** Path relative to the walk root, always using forward slashes. */
  path: string;
  absolutePath: string;
  size: number;
};

export type WalkResult = {
  files: WalkedFile[];
  totalBytes: number;
  /** Relative paths of symlinks found; host-core rejects packages containing any. */
  symlinks: string[];
  /** True when traversal stopped at MAX_PACKAGE_FILES. */
  truncated: boolean;
};

/** Our own `dist/` output: packaging previous packages would nest them. */
export function isPackageOutputPath(relPath: string): boolean {
  return relPath === "dist" || relPath.startsWith("dist/");
}

/** Whether a relative path names a credential file the package must skip. */
export function isSecretFilePath(relPath: string): boolean {
  const name = basename(relPath.split(/[\\/]/).join("/"));
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

export type PackageSelection = {
  /** Files that enter the package, in walk order. */
  files: WalkedFile[];
  totalBytes: number;
  /** Credential files left out; callers surface these as a warning. */
  skippedSecrets: WalkedFile[];
};

/**
 * The one predicate `check` and `pack` share for "what goes into the
 * package". Size limits are measured on this set so a clean `check` and a
 * successful `pack` agree.
 */
export function selectPackageFiles(files: readonly WalkedFile[]): PackageSelection {
  const selected: WalkedFile[] = [];
  const skippedSecrets: WalkedFile[] = [];
  let totalBytes = 0;
  for (const file of files) {
    if (isPackageOutputPath(file.path)) continue;
    if (isSecretFilePath(file.path)) {
      skippedSecrets.push(file);
      continue;
    }
    selected.push(file);
    totalBytes += file.size;
  }
  return { files: selected, totalBytes, skippedSecrets };
}

/**
 * Deterministic, locale-independent ordering. `localeCompare` depends on the
 * ICU data of the machine running it, which would change the entry order and
 * therefore the package sha256 from one machine to the next.
 */
export function compareByCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Collect the files host-core would copy out of a plugin directory.
 *
 * Symlinks are reported rather than followed: `copy_dir_filtered` bails on
 * them, so a package that contains one can never install.
 */
export async function walkPluginDir(root: string): Promise<WalkResult> {
  const files: WalkedFile[] = [];
  const symlinks: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  const visit = async (dir: string): Promise<void> => {
    if (truncated) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => compareByCodeUnit(a.name, b.name))) {
      if (truncated) return;
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      const absolutePath = join(dir, entry.name);
      const rel = relative(root, absolutePath).split(/[\\/]/).join("/");
      if (entry.isSymbolicLink()) {
        symlinks.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_PACKAGE_FILES) {
        truncated = true;
        return;
      }
      const stats = await lstat(absolutePath);
      totalBytes += stats.size;
      files.push({ path: rel, absolutePath, size: stats.size });
    }
  };

  await visit(root);
  return { files, totalBytes, symlinks, truncated };
}
