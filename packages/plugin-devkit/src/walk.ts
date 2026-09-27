import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/** Mirrors host-core `copy_dir_filtered`: these never enter a package. */
export const IGNORED_DIR_NAMES = new Set([".git", "node_modules"]);
/** host-core `MAX_PACKAGE_FILES` (crates/host-core/src/plugins.rs). */
export const MAX_PACKAGE_FILES = 2000;
/** host-core `MAX_PACKAGE_BYTES` (crates/host-core/src/plugins.rs). */
export const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

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
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
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
