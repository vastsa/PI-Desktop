import type { AnnouncementRecord } from "./app-overlay-model";

/*
 * Previously seen release announcements live in the renderer's localStorage.
 * A blocked or corrupt store degrades to "not seen".
 */

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
