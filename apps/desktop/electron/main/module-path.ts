import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the built Main output directory that owns `moduleUrl`.
 *
 * Rollup emits Main as `out/main/index.js` plus shared chunks under
 * `out/main/chunks/`, so collapse the `chunks` segment instead of leaking
 * the chunk nesting into runtime paths (renderer entry, preloads,
 * plugin host). Without this the app loads a missing index.html (black screen).
 */
export function getModuleDirectory(moduleUrl: string): string {
  let directory = dirname(fileURLToPath(moduleUrl));
  while (basename(directory) === "chunks") directory = dirname(directory);
  return directory;
}
