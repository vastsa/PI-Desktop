import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export type FolderImportResult<T> = {
  imported: T[];
  failed: Array<{ path: string; error: string }>;
  /** Internal picker preference; omit from the IPC result. */
  lastImportedPath?: string;
};

/** Import selected folders independently, preserving each failure for the UI. */
export async function importSkillFolders<T>(
  paths: string[],
  options: Record<string, unknown>,
  hostImport: (params: Record<string, unknown>) => Promise<{ skill: T }>,
): Promise<FolderImportResult<T>> {
  const result: FolderImportResult<T> = { imported: [], failed: [] };
  for (const path of paths) {
    try {
      const response = await hostImport({ ...options, path, shape: "dir" });
      result.imported.push(response.skill);
      result.lastImportedPath = path;
    } catch (error) {
      result.failed.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

const PREFERENCE_FILE = "skill-import-directory.json";

/** A missing or moved parent falls back to the native picker's default. */
export function readLastSkillImportDirectory(dataDir: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDir, PREFERENCE_FILE), "utf8"));
    if (!value || typeof value !== "object" || !("directory" in value)) return undefined;
    const directory = value.directory;
    return typeof directory === "string" && isAbsolute(directory) && !directory.includes("\0")
      && statSync(directory).isDirectory()
      ? directory
      : undefined;
  } catch {
    return undefined;
  }
}

/** Reopen beside the last successful Skill folder, where siblings are selectable. */
export function writeLastSkillImportDirectory(dataDir: string, importedFolder: string): void {
  if (!isAbsolute(importedFolder) || importedFolder.includes("\0")) {
    throw new Error("imported skill folder must be an absolute path");
  }
  const directory = dirname(importedFolder);
  mkdirSync(dataDir, { recursive: true });
  const destination = join(dataDir, PREFERENCE_FILE);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ directory }), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}
