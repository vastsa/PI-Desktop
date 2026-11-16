import type { ModeRun } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { modesApi } from "./modes-api";
import { applyModeRun, loadModeCatalog, loadModeRun, setModeCatalog } from "./modes-store";

/**
 * Wiring between the mode IPC events and the modes store.
 *
 * A run that ends (finished or stopped) moves the session to the mode's
 * `returnTo` in host-core, so the session list is read again to show it.
 */
export function applyRunUpdate(sessionId: string, run: ModeRun | null): void {
  const { closed } = applyModeRun(sessionId, run);
  if (closed) void useAppStore.getState().refreshSessions().catch(() => undefined);
}

export function refreshModeCatalog(): Promise<void> {
  return loadModeCatalog(modesApi.catalog);
}

/** Read one session's run; remote sessions have no staged runs (v1). */
export function refreshModeRun(sessionId: string): Promise<void> {
  if (sessionId.startsWith("remote:")) return Promise.resolve();
  return loadModeRun(sessionId, modesApi.getRun);
}

/** Load the catalog once and follow both mode events until disposed. */
export function startModesSync(): () => void {
  const offCatalog = modesApi.onCatalogChanged(setModeCatalog);
  const offRuns = modesApi.onRunChanged((event) => applyRunUpdate(event.sessionId, event.run));
  void refreshModeCatalog().catch((error: unknown) => {
    console.warn("[modes] catalog load failed", error);
  });
  return () => {
    offCatalog();
    offRuns();
  };
}
