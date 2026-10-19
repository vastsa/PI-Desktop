/** App wiring for the pure Jev configuration ordering rules. */
import { useEffect, useState } from "react";
import {
  isDefaultJevClassifierBinding,
  normalizeJevClassifierBinding,
  resolveJevClassifierBinding,
  type AppSettings,
  type JevClassifierBinding,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import type { JevConfigDeps } from "./jev-config";

export type JevKeyStatus = "loading" | "configured" | "missing" | "unavailable";

async function persist(next: AppSettings, wire: AppSettings = next): Promise<void> {
  await api.setSettings(wire);
  useAppStore.setState({ settings: next });
}

/** Jev is part of one AppSettings document, so every change is a full write. */
export async function persistJevEnabled(enabled: boolean): Promise<void> {
  const current = useAppStore.getState().settings;
  if (!current) throw new Error("Settings are not ready");
  if (enabled && resolveJevClassifierBinding(current.jevClassifier).status === "invalid") {
    throw new Error("Jev classifier binding is invalid");
  }
  await persist({ ...current, jevEnabled: enabled });
}

/** Save the normalized binding and enable Jev in one settings write. */
export async function persistJevConfiguration(
  binding: JevClassifierBinding,
): Promise<void> {
  const current = useAppStore.getState().settings;
  if (!current) throw new Error("Settings are not ready");
  const normalized = normalizeJevClassifierBinding(binding);
  if (!normalized) throw new Error("Jev classifier binding is invalid");

  const next: AppSettings = { ...current, jevEnabled: true };
  delete next.jevClassifier;
  if (!isDefaultJevClassifierBinding(normalized)) {
    next.jevClassifier = normalized;
  }
  await persist(next, {
    ...next,
    // Explicit null clears a prior custom binding in Host's merge store.
    ...(isDefaultJevClassifierBinding(normalized) ? { jevClassifier: null } : {}),
  });
}

/** Disable the tool and remove a custom binding without changing the key yet. */
export async function disableAndClearJevConfiguration(): Promise<void> {
  const current = useAppStore.getState().settings;
  if (!current) throw new Error("Settings are not ready");
  const next: AppSettings = { ...current, jevEnabled: false };
  delete next.jevClassifier;
  await persist(next, { ...next, jevClassifier: null });
}

export function appJevConfigDeps(): JevConfigDeps {
  return {
    probe: (key, binding) => api.testJevApiKey({ apiKey: key, binding }),
    storeKey: (key) => api.setJevApiKey(key),
    deleteKey: () => api.deleteJevApiKey(),
    configure: persistJevConfiguration,
    disableAndClear: disableAndClearJevConfiguration,
  };
}

/** The renderer learns only whether a credential exists, never its value. */
export function useJevKeyStatus(
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
