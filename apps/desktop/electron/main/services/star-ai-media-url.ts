import { isAbsolute, relative, resolve, sep } from "node:path";
import { GENERATED_MEDIA_SCHEME } from "@pi-desktop/shared";

/**
 * Build a `pi-media://scratch/...` URL for a file residing inside the resolved
 * scratch root. Pass the realpath-resolved scratch root when `filePath` is
 * already realpath-resolved so symlinked temp/data dirs (e.g. `/var` -> `/private/var`
 * on macOS) match reliably.
 */
export function generatedMediaUrlFromScratchRoot(scratchRoot: string, filePath: string): string | null {
  const rel = relative(resolve(scratchRoot), resolve(filePath));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const encoded = rel
    .split(sep)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${GENERATED_MEDIA_SCHEME}://scratch/${encoded}`;
}
