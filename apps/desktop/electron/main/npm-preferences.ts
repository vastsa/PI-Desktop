import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Machine-local executable preference, not part of plugin contents or synced settings. */
export function readNpmPath(dataDir: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDir, "npm-path.json"), "utf8"));
    if (!value || typeof value !== "object" || !("npmPath" in value)) return undefined;
    const path = value.npmPath;
    return typeof path === "string" && isAbsolute(path) && !path.includes("\0")
      ? path
      : undefined;
  } catch {
    // Missing or malformed preferences fall back to the ordinary PATH lookup.
    return undefined;
  }
}

/** Fail visibly to the caller; never replace a working preference with a partial write. */
export function writeNpmPath(dataDir: string, npmPath: string): void {
  if (!isAbsolute(npmPath) || npmPath.includes("\0")) {
    throw new Error("npm executable path must be absolute");
  }
  mkdirSync(dataDir, { recursive: true });
  const destination = join(dataDir, "npm-path.json");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ npmPath }), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}
