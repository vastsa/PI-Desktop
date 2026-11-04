/**
 * Launcher preferences and usage history.
 *
 * These live in the renderer's `localStorage` rather than host-core: they are
 * presentation state for one floating panel (which tiles the user pinned, what
 * they opened last), and both the launcher window and the main window share one
 * origin, so the plain web storage already survives a restart and already
 * notifies the other window through `storage`.
 *
 * Every read is defensive: storage can hold another version's payload, a
 * truncated write, or a hand-edited value, and none of those may break the
 * panel. Unreadable records are dropped, unknown fields written by an older or
 * newer build are ignored without a write-back, and the store only ever returns
 * ids it can still resolve against the live catalog (`pruneLauncherState`).
 */

const STATE_KEY = "pi.desktop.launcher.state";
/** Pre-existing plugin-only history; read once so upgrades keep the order. */
const LEGACY_HISTORY_KEY = "pi.desktop.pluginLaunchHistory";

/** Recency list cap. The panel shows 16 at a time but reports the total. */
export const LAUNCHER_RECENT_LIMIT = 60;
/**
 * Pin cap, so a runaway script cannot grow the state file without bound. The
 * panel shows the pins as one row of eight tiles, so pinning past this is
 * refused instead of quietly pushing an older pin out of sight.
 */
export const LAUNCHER_PIN_LIMIT = 8;
/** Items that may carry a launcher-only preference (hidden plugins). */
const LAUNCHER_ENTRY_LIMIT = 200;

export type LauncherStoreSnapshot = {
  /** Item ids, most recently used first. */
  recents: string[];
  /** Item ids in the order the user pinned them. */
  pins: string[];
  /** Plugin ids the user hid from the launcher only. */
  disabledPlugins: string[];
  /** `<pluginId>::<triggerId>` entries the user switched off. */
  disabledTriggers: string[];
};

export type LauncherStorage = Pick<Storage, "getItem" | "setItem">;

export const EMPTY_LAUNCHER_STATE: LauncherStoreSnapshot = {
  recents: [],
  pins: [],
  disabledPlugins: [],
  disabledTriggers: [],
};

function defaultStorage(): LauncherStorage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? (globalThis.localStorage as LauncherStorage)
      : null;
  } catch {
    // A blocked or partitioned storage must not break the launcher.
    return null;
  }
}

function readRaw(storage: LauncherStorage | null, key: string): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

/** Trigger ids are namespaced by plugin so one plugin cannot mute another. */
export function launcherTriggerKey(pluginId: string, triggerId: string): string {
  return `${pluginId}::${triggerId}`;
}

/** Legacy plugin-only history, translated to the launcher's item ids. */
function legacyRecents(storage: LauncherStorage | null): string[] {
  const parsed = readRaw(storage, LEGACY_HISTORY_KEY);
  if (!Array.isArray(parsed)) return [];
  const ordered = parsed
    .filter(
      (record): record is { id: string; usedAt: number } =>
        isRecord(record) &&
        typeof record.id === "string" &&
        typeof record.usedAt === "number",
    )
    .sort((left, right) => right.usedAt - left.usedAt);
  return stringList(
    ordered.map((record) => `plugin:${record.id}`),
    LAUNCHER_RECENT_LIMIT,
  );
}

export function readLauncherState(
  storage: LauncherStorage | null = defaultStorage(),
): LauncherStoreSnapshot {
  const stored = readRaw(storage, STATE_KEY);
  if (!isRecord(stored)) {
    // First run after an upgrade: keep the plugin history the old panel wrote.
    return { ...EMPTY_LAUNCHER_STATE, recents: legacyRecents(storage) };
  }
  const recents = stringList(stored.recents, LAUNCHER_RECENT_LIMIT);
  return {
    recents: recents.length ? recents : legacyRecents(storage),
    pins: stringList(stored.pins, LAUNCHER_PIN_LIMIT),
    disabledPlugins: stringList(stored.disabledPlugins, LAUNCHER_ENTRY_LIMIT),
    disabledTriggers: stringList(stored.disabledTriggers, LAUNCHER_ENTRY_LIMIT * 4),
  };
}

export function writeLauncherState(
  snapshot: LauncherStoreSnapshot,
  storage: LauncherStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STATE_KEY, JSON.stringify(snapshot));
  } catch {
    // Best-effort: a full or blocked quota must not break launching.
  }
}

function updateLauncherState(
  mutate: (current: LauncherStoreSnapshot) => LauncherStoreSnapshot,
  storage: LauncherStorage | null = defaultStorage(),
): LauncherStoreSnapshot {
  const next = mutate(readLauncherState(storage));
  writeLauncherState(next, storage);
  return next;
}

/** Record an open, keeping one entry per item at the front of the list. */
export function rememberLauncherUse(
  itemId: string,
  storage: LauncherStorage | null = defaultStorage(),
): LauncherStoreSnapshot {
  if (!itemId) return readLauncherState(storage);
  return updateLauncherState(
    (current) => ({
      ...current,
      recents: [itemId, ...current.recents.filter((id) => id !== itemId)].slice(
        0,
        LAUNCHER_RECENT_LIMIT,
      ),
    }),
    storage,
  );
}

/**
 * Pin or unpin one item.
 *
 * Pinning is refused once `LAUNCHER_PIN_LIMIT` items are pinned: the panel
 * shows the pins as a single row, so an extra pin would either reflow the grid
 * or silently evict a pin the user made earlier. Unpinning always works, and
 * re-pinning an item that is already pinned keeps its position.
 */
export function setLauncherPinned(
  itemId: string,
  pinned: boolean,
  storage: LauncherStorage | null = defaultStorage(),
): LauncherStoreSnapshot {
  return updateLauncherState((current) => {
    const existing = current.pins.includes(itemId);
    if (!pinned) {
      if (!existing) return current;
      return { ...current, pins: current.pins.filter((id) => id !== itemId) };
    }
    if (existing) return current;
    if (current.pins.length >= LAUNCHER_PIN_LIMIT) return current;
    return { ...current, pins: [...current.pins, itemId] };
  }, storage);
}

export function setLauncherPluginDisabled(
  pluginId: string,
  disabled: boolean,
  storage: LauncherStorage | null = defaultStorage(),
): LauncherStoreSnapshot {
  return updateLauncherState((current) => {
    const without = current.disabledPlugins.filter((id) => id !== pluginId);
    return {
      ...current,
      disabledPlugins: disabled
        ? [...without, pluginId].slice(-LAUNCHER_ENTRY_LIMIT)
        : without,
    };
  }, storage);
}

export function setLauncherTriggerDisabled(
  pluginId: string,
  triggerId: string,
  disabled: boolean,
  storage: LauncherStorage | null = defaultStorage(),
): LauncherStoreSnapshot {
  const key = launcherTriggerKey(pluginId, triggerId);
  return updateLauncherState((current) => {
    const without = current.disabledTriggers.filter((entry) => entry !== key);
    return {
      ...current,
      disabledTriggers: disabled ? [...without, key] : without,
    };
  }, storage);
}

/**
 * Drop everything that names an item the catalog no longer offers, so an
 * uninstalled plugin or a removed application disappears from recents and pins
 * instead of leaving a tile that cannot open.
 */
export function pruneLauncherState(
  knownItemIds: Iterable<string>,
  storage: LauncherStorage | null = defaultStorage(),
): LauncherStoreSnapshot {
  const known = new Set(knownItemIds);
  const current = readLauncherState(storage);
  const next: LauncherStoreSnapshot = {
    recents: current.recents.filter((id) => known.has(id)),
    pins: current.pins.filter((id) => known.has(id)),
    // Plugin ids stay: a disabled plugin keeps its preference across a reload
    // that momentarily reports it as not-ready.
    disabledPlugins: current.disabledPlugins,
    disabledTriggers: current.disabledTriggers,
  };
  if (
    next.recents.length !== current.recents.length ||
    next.pins.length !== current.pins.length
  ) {
    writeLauncherState(next, storage);
  }
  return next;
}
