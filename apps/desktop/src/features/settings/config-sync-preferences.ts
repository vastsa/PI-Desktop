import type {
  ConfigSyncCategory,
  ConfigSyncCategorySelection,
  ConfigSyncHistoryEntry,
  ConfigSyncRemoteMode,
  ConfigSyncState,
} from "@pi-desktop/shared";

/**
 * The draft is deliberately limited to non-sensitive connection fields.
 * The WebDAV app password and derived vault key stay in Host-owned secret
 * storage; the passwords are never copied into renderer persistence, even as a
 * convenience cache.
 */
export type ConfigSyncDraft = {
  endpoint?: string;
  username?: string;
  directory?: string;
  deviceLabel?: string;
  remoteMode?: ConfigSyncRemoteMode;
  categories?: Partial<ConfigSyncCategorySelection>;
  /** False means the user left an unsaved draft; true mirrors Host state. */
  saved?: boolean;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const CONFIG_SYNC_DRAFT_STORAGE_KEY = "pi.desktop.configSyncDraft";
export const CONFIG_SYNC_HISTORY_CACHE_TTL_MS = 30_000;

const CATEGORY_KEYS: ConfigSyncCategory[] = [
  "application",
  "providers",
  "credentials",
  "mcp",
  "skills",
  "subagents",
  "instructions",
  "projects",
  "plugins",
  "automation",
  "memory",
];

function storage(): StorageLike | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  return value;
}

function remoteMode(value: unknown): ConfigSyncRemoteMode | undefined {
  return value === "strict" || value === "appendOnly" ? value : undefined;
}

export function readConfigSyncDraft(store: StorageLike | null = storage()): ConfigSyncDraft {
  if (!store) return {};
  try {
    const raw = store.getItem(CONFIG_SYNC_DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed)) return {};

    const draft: ConfigSyncDraft = {};
    for (const key of ["endpoint", "username", "directory", "deviceLabel"] as const) {
      const value = text(parsed[key]);
      if (value !== undefined) draft[key] = value;
    }
    const mode = remoteMode(parsed.remoteMode);
    if (mode) draft.remoteMode = mode;
    if (typeof parsed.saved === "boolean") draft.saved = parsed.saved;

    if (object(parsed.categories)) {
      const categories: Partial<ConfigSyncCategorySelection> = {};
      for (const key of CATEGORY_KEYS) {
        if (typeof parsed.categories[key] === "boolean") {
          categories[key] = parsed.categories[key] as boolean;
        }
      }
      if (Object.keys(categories).length > 0) draft.categories = categories;
    }
    return draft;
  } catch {
    return {};
  }
}

/** Persist only the explicitly supported, non-sensitive draft fields. */
export function writeConfigSyncDraft(
  draft: ConfigSyncDraft,
  store: StorageLike | null = storage(),
): void {
  if (!store) return;
  try {
    const value: Record<string, unknown> = {};
    for (const key of ["endpoint", "username", "directory", "deviceLabel"] as const) {
      const next = text(draft[key]);
      if (next !== undefined) value[key] = next;
    }
    const mode = remoteMode(draft.remoteMode);
    if (mode) value.remoteMode = mode;
    if (typeof draft.saved === "boolean") value.saved = draft.saved;
    if (draft.categories && object(draft.categories)) {
      const categories: Partial<ConfigSyncCategorySelection> = {};
      for (const key of CATEGORY_KEYS) {
        if (typeof draft.categories[key] === "boolean") {
          categories[key] = draft.categories[key] as boolean;
        }
      }
      if (Object.keys(categories).length > 0) value.categories = categories;
    }
    store.setItem(CONFIG_SYNC_DRAFT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // A blocked or full localStorage must not prevent cloud sync from working.
  }
}

export function clearConfigSyncDraft(store: StorageLike | null = storage()): void {
  if (!store) return;
  try {
    store.removeItem(CONFIG_SYNC_DRAFT_STORAGE_KEY);
  } catch {
    // Best effort cleanup; disconnect still remains authoritative in Host.
  }
}

let cachedState: ConfigSyncState | null = null;
let cachedHistory: ConfigSyncHistoryEntry[] | null = null;
let cachedHistoryAt = 0;

export function getCachedConfigSyncState(): ConfigSyncState | null {
  return cachedState;
}

export function cacheConfigSyncState(next: ConfigSyncState): void {
  cachedState = next;
}

export function getCachedConfigSyncHistory(): ConfigSyncHistoryEntry[] {
  return cachedHistory ? [...cachedHistory] : [];
}

export function cacheConfigSyncHistory(
  next: ConfigSyncHistoryEntry[],
  now = Date.now(),
): void {
  cachedHistory = [...next];
  cachedHistoryAt = now;
}

export function hasFreshConfigSyncHistory(now = Date.now()): boolean {
  return (
    cachedHistory !== null &&
    now - cachedHistoryAt >= 0 &&
    now - cachedHistoryAt < CONFIG_SYNC_HISTORY_CACHE_TTL_MS
  );
}
