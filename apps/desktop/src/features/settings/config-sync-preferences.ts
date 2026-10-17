import type {
  ConfigSyncCategory,
  ConfigSyncCategorySelection,
  ConfigSyncHistoryEntry,
  ConfigSyncMode,
  ConfigSyncState,
} from "@pi-desktop/shared";

/**
 * The draft is deliberately limited to non-sensitive connection fields.
 * S3 secrets and derived vault keys stay in Host-owned secret storage;
 * passwords are never copied into renderer persistence, even as a
 * convenience cache.
 */
export type ConfigSyncDraft = {
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  accessKeyId?: string;
  pathStyle?: boolean;
  automaticSync?: boolean;
  deviceLabel?: string;
  mode?: ConfigSyncMode;
  categories?: Partial<ConfigSyncCategorySelection>;
  /** False means the user left an unsaved draft; true mirrors Host state. */
  saved?: boolean;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const CONFIG_SYNC_DRAFT_STORAGE_KEY = "pi.desktop.configSyncS3Draft.v1";
export const CONFIG_SYNC_HISTORY_CACHE_TTL_MS = 30_000;

const TEXT_FIELDS = ["endpoint", "region", "bucket", "prefix", "accessKeyId", "deviceLabel"] as const;
const BOOLEAN_FIELDS = ["pathStyle", "automaticSync", "saved"] as const;

const CATEGORY_KEYS: ConfigSyncCategory[] = [
  "application",
  "providers",
  "credentials",
  "mcp",
  "skills",
  "subagents",
  "instructions",
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

function syncMode(value: unknown): ConfigSyncMode | undefined {
  return value === "sync" || value === "backup" ? value : undefined;
}

export function readConfigSyncDraft(store: StorageLike | null = storage()): ConfigSyncDraft {
  if (!store) return {};
  try {
    const raw = store.getItem(CONFIG_SYNC_DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed)) return {};

    const draft: ConfigSyncDraft = {};
    for (const key of TEXT_FIELDS) {
      const value = text(parsed[key]);
      if (value !== undefined) draft[key] = value;
    }
    const mode = syncMode(parsed.mode);
    if (mode) draft.mode = mode;
    for (const key of BOOLEAN_FIELDS) {
      if (typeof parsed[key] === "boolean") draft[key] = parsed[key];
    }

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
    for (const key of TEXT_FIELDS) {
      const next = text(draft[key]);
      if (next !== undefined) value[key] = next;
    }
    const mode = syncMode(draft.mode);
    if (mode) value.mode = mode;
    for (const key of BOOLEAN_FIELDS) {
      if (typeof draft[key] === "boolean") value[key] = draft[key];
    }
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

/** Returns true when callers must invalidate their in-flight history request. */
export function cacheConfigSyncState(next: ConfigSyncState): boolean {
  const previous = cachedState;
  const changed = previous === null ||
    ["configured", "endpoint", "region", "bucket", "prefix", "accessKeyId", "pathStyle", "mode"].some(
      (key) => previous[key as keyof ConfigSyncState] !== next[key as keyof ConfigSyncState],
    );
  if (changed) {
    cachedHistory = null;
    cachedHistoryAt = 0;
  }
  cachedState = next;
  return changed;
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
