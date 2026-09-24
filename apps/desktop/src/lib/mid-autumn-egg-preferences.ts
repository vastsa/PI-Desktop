const MID_AUTUMN_EGG_SEEN_STORAGE_KEY = "pi.desktop.midAutumnEggSeen";

function storage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

/** True once the launch easter egg has been shown so it never replays by itself. */
export function hasSeenMidAutumnEgg(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    return store.getItem(MID_AUTUMN_EGG_SEEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markMidAutumnEggSeen(): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(MID_AUTUMN_EGG_SEEN_STORAGE_KEY, "1");
  } catch {
    // A blocked or full localStorage must not prevent the app from running.
  }
}
