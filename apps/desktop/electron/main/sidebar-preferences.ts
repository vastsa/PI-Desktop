import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const FILE = "sidebar-preferences.json";
const MAX_BYTES = 2 * 1024 * 1024;

function serialize(value: unknown): string {
  const record = (item: unknown) => !!item && typeof item === "object" && !Array.isArray(item);
  const fields = value as { openProjectPaths?: unknown; sessionMeta?: unknown; projectMeta?: unknown; sessionView?: unknown } | null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Array.isArray(fields?.openProjectPaths) || !record(fields?.sessionMeta)
    || !record(fields?.projectMeta) || !record(fields?.sessionView)) {
    throw new Error("Invalid sidebar preferences");
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error("Sidebar preferences exceed the size limit");
  return json;
}

export function readSidebarBackup(dataDir: string): unknown {
  let raw: string;
  try { raw = readFileSync(join(dataDir, FILE), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  // A damaged backup is not permission to replace it with an empty renderer cache.
  const value: unknown = JSON.parse(raw);
  serialize(value);
  return value;
}

export function writeSidebarBackup(dataDir: string, value: unknown): void {
  const json = serialize(value);
  mkdirSync(dataDir, { recursive: true });
  const temporary = join(dataDir, `.sidebar-${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeFileSync(fd, json); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, join(dataDir, FILE));
    if (process.platform !== "win32") {
      const directory = openSync(dataDir, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    try { unlinkSync(temporary); } catch { /* The completed rename already consumed it. */ }
  }
}
