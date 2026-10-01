import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the filesystem directory for the current ES module URL. */
export function getModuleDirectory(moduleUrl: string): string {
  return dirname(fileURLToPath(moduleUrl));
}
