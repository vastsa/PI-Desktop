import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

export const STORAGE_PREFERENCE_FILE = "storage-location.json";
export type StorageRoots = { data: string; browser: string };
export type StorageJob = { id: string; kind: "migrate" | "cache" | "backup"; target?: string; language: string };
export type StoragePreferences = {
  version: 1;
  roots: StorageRoots;
  backups: StorageRoots[];
  pending?: StorageJob;
  lastError?: string;
  failedMigration?: StorageJob;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function roots(value: unknown): value is StorageRoots {
  return record(value) && typeof value.data === "string" && isAbsolute(value.data)
    && typeof value.browser === "string" && isAbsolute(value.browser);
}
export function readStoragePreferences(file: string, defaults: StorageRoots): StoragePreferences {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) {
    if (record(error) && error.code === "ENOENT") return { version: 1, roots: defaults, backups: [] };
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.version !== 1 || !roots(value.roots)
    || !Array.isArray(value.backups) || !value.backups.every(roots)
    || (value.lastError !== undefined && typeof value.lastError !== "string")) {
    throw new Error("Invalid storage preferences. Restore storage-location.json before starting.");
  }
  for (const job of [value.pending, value.failedMigration]) {
    if (job === undefined) continue;
    if (!record(job) || typeof job.id !== "string" || !/^[a-f0-9-]{36}$/.test(job.id)
      || !["migrate", "cache", "backup"].includes(String(job.kind))
      || typeof job.language !== "string"
      || (job.kind === "migrate" && (typeof job.target !== "string" || !isAbsolute(job.target)))) {
      throw new Error("Invalid pending storage operation.");
    }
  }
  return value as StoragePreferences;
}

/** Flush the new pointer before publishing it. The previous pointer survives a failed write. */
export function writeStoragePreferences(file: string, value: StoragePreferences): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.storage-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try { writeFileSync(descriptor, JSON.stringify(value)); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporary, file);
  if (process.platform !== "win32") {
    const directory = openSync(dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
