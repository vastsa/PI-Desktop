import type { AnnouncementRecord } from "./app-overlay-model";

/*
 * Renderer-local memory for the startup guide and the release announcement.
 * Both are presentation state of this window — whether a hint was already
 * seen — so they live in localStorage, like the sidebar width, and never in
 * host-owned settings. A blocked or corrupt store degrades to "not seen".
 */

export const STARTUP_GUIDE_STORAGE_KEY = "pi.desktop.startupGuide";
export const ANNOUNCEMENT_STORAGE_KEY = "pi.desktop.announcement";

function storage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

function read(key: string): unknown {
  try {
    const value = storage()?.getItem(key);
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // A full or blocked store only means the hint may show again.
  }
}

export function loadStartupGuideCompletedVersion(): number {
  const value = read(STARTUP_GUIDE_STORAGE_KEY);
  if (!value || typeof value !== "object") return 0;
  const version = (value as { completedVersion?: unknown }).completedVersion;
  return typeof version === "number" && Number.isFinite(version) ? version : 0;
}

export function saveStartupGuideCompletedVersion(version: number): void {
  write(STARTUP_GUIDE_STORAGE_KEY, { completedVersion: version });
}

export function loadAnnouncementRecord(): AnnouncementRecord {
  const value = read(ANNOUNCEMENT_STORAGE_KEY);
  const ids = value && typeof value === "object"
    ? (value as { shownIds?: unknown }).shownIds
    : undefined;
  return {
    shownIds: Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export function saveAnnouncementRecord(record: AnnouncementRecord): void {
  write(ANNOUNCEMENT_STORAGE_KEY, record);
}
