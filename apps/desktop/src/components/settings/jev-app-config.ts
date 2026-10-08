/**
 * The app-wired half of Jev configuration: the real API calls, the settings
 * write, and the key-status read both Jev surfaces show.
 *
 * Split from `jev-config.ts` so the ordering rules there stay testable without
 * a renderer, an IPC bridge or a store.
 */
import { useEffect, useState } from "react";
import type { AppSettings } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import type { JevConfigDeps } from "./jev-config";

export type JevKeyStatus = "loading" | "configured" | "missing" | "unavailable";

/** Jev is one field of the same AppSettings document, so it takes a full write. */
export async function persistJevEnabled(enabled: boolean): Promise<void> {
  const current = useAppStore.getState().settings;
  if (!current) throw new Error("Settings are not ready");
  const next: AppSettings = { ...current, jevEnabled: enabled };
  await api.setSettings(next);
  useAppStore.setState({ settings: next });
}

export function appJevConfigDeps(): JevConfigDeps {
  return {
    probe: (key) => api.testJevApiKey(key),
    storeKey: (key) => api.setJevApiKey(key),
    deleteKey: () => api.deleteJevApiKey(),
    setEnabled: persistJevEnabled,
  };
}

/**
 * Whether a TypeSafe key is stored. The renderer only ever learns whether one
 * exists, and a Host that cannot answer reads as `unavailable` — never as
 * "no key", which would describe a configured install as unconfigured.
 */
export function useJevKeyStatus(
  /** Bump to re-read: the service dialog reports a key it just stored this way. */
  revision = 0,
): readonly [JevKeyStatus, (next: JevKeyStatus) => void] {
  const [status, setStatus] = useState<JevKeyStatus>("loading");
  useEffect(() => {
    let current = true;
    void api.hasJevApiKey().then(
      (hasKey) => {
        if (current) setStatus(hasKey ? "configured" : "missing");
      },
      () => {
        if (current) setStatus("unavailable");
      },
    );
    return () => {
      current = false;
    };
  }, [revision]);
  return [status, setStatus] as const;
}
