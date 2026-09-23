import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  THEME_ASSET_MAX_BYTES,
  isExternalThemeAssetPath,
  normalizeThemeAssetPath,
} from "@pi-desktop/plugin-sdk";

/** Resolve one package-relative theme asset to a real file under the plugin root. */
export function resolvePackageThemeAssetPath(pluginPath: string, assetPath: string): string | null {
  const normalized = normalizeThemeAssetPath(assetPath);
  if (
    !normalized ||
    isExternalThemeAssetPath(normalized) ||
    normalized.split("/").some((segment) => segment.toLowerCase() === "node_modules")
  ) {
    return null;
  }

  const root = resolve(pluginPath);
  const target = resolve(root, normalized);
  if (isOutsideRoot(root, target)) return null;

  try {
    const canonicalRoot = realpathSync(root);
    const canonicalTarget = realpathSync(target);
    if (isOutsideRoot(canonicalRoot, canonicalTarget) || !statSync(canonicalTarget).isFile()) {
      return null;
    }
    return canonicalTarget;
  } catch {
    return null;
  }
}

/** Resolve an explicitly declared absolute theme asset, preserving legacy support. */
export function resolveAbsoluteThemeAssetPath(assetPath: string): string | null {
  const normalized = normalizeThemeAssetPath(assetPath);
  if (!normalized || !isExternalThemeAssetPath(normalized)) return null;
  try {
    const canonicalPath = realpathSync(normalized);
    return statSync(canonicalPath).isFile() ? canonicalPath : null;
  } catch {
    return null;
  }
}

/** Recheck the summed asset budget for a theme after plugin code has run. */
export function themeAssetGroupWithinBudget(
  pluginPath: string,
  assets: ReadonlyMap<string, string>,
): boolean {
  let total = 0;
  for (const [assetPath, registeredPath] of assets) {
    const current = isExternalThemeAssetPath(assetPath)
      ? resolveAbsoluteThemeAssetPath(assetPath)
      : resolvePackageThemeAssetPath(pluginPath, assetPath);
    if (!current || current !== registeredPath) return false;
    try {
      const size = statSync(current).size;
      if (!Number.isSafeInteger(size) || size < 0) return false;
      total += size;
      if (total > THEME_ASSET_MAX_BYTES) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Read a canonical theme asset through a stable descriptor and a fixed byte
 * bound. Inode verification prevents a plugin from swapping in a symlink after
 * path validation; the extra byte detects growth beyond the per-file limit.
 */
export function readThemeAssetBytes(assetPath: string): Uint8Array | null {
  let descriptor: number | undefined;
  try {
    const canonicalPath = realpathSync(assetPath);
    if (canonicalPath !== assetPath) return null;
    const before = statSync(canonicalPath, { bigint: true });
    const maxBytes = BigInt(THEME_ASSET_MAX_BYTES);
    if (!before.isFile() || before.size > maxBytes) return null;
    if (realpathSync(canonicalPath) !== canonicalPath) return null;

    descriptor = openSync(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > maxBytes
    ) {
      return null;
    }

    const buffer = Buffer.alloc(THEME_ASSET_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(descriptor, buffer, total, buffer.length - total, total);
      if (count === 0) break;
      total += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      total > THEME_ASSET_MAX_BYTES ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size > maxBytes
    ) {
      return null;
    }
    return buffer.subarray(0, total);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isOutsideRoot(root: string, target: string): boolean {
  const relativeTarget = relative(root, target);
  return (
    relativeTarget.length === 0 ||
    isAbsolute(relativeTarget) ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`)
  );
}
