import { useCallback, useEffect, useState } from "react";
import type { AppSettings } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";

/**
 * Read and write app settings for any surface that hosts Settings content —
 * the Settings dialog, the startup guide, or another embedding. A missing
 * snapshot (host restarted under the renderer) is re-read once on mount and
 * can be retried by the caller.
 */
export function useSettingsPersistence() {
  const settings = useAppStore((s) => s.settings);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const [recovering, setRecovering] = useState(!settings);
  const [recoveryFailed, setRecoveryFailed] = useState(false);

  const recoverSettings = useCallback(async () => {
    setRecovering(true);
    setRecoveryFailed(false);
    try {
      const recovered = await api.getSettings();
      useAppStore.setState({ settings: recovered });
    } catch {
      setRecoveryFailed(true);
    } finally {
      setRecovering(false);
    }
  }, []);

  useEffect(() => {
    if (settings) return;
    void recoverSettings();
  }, [settings, recoverSettings]);

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      if (!settings) return;
      const nextSettings = { ...settings, ...patch };
      await api.setSettings(nextSettings);
      useAppStore.setState({ settings: nextSettings });
      await refreshProviders();
    },
    [settings, refreshProviders],
  );

  return {
    settings,
    saveSettings,
    recovering,
    recoveryFailed,
    recoverSettings,
  };
}
