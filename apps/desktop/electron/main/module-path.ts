import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the output directory for an ES module, including electron-vite chunks. */
export function getModuleDirectory(moduleUrl: string): string {
  const directory = dirname(fileURLToPath(moduleUrl));
  const parent = dirname(directory);

  // Main-process modules may be emitted under out/main/chunks, while their
  // sibling assets and child entry points remain directly under out/main.
  return basename(directory) === "chunks" && basename(parent) === "main"
    ? parent
    : directory;
}
