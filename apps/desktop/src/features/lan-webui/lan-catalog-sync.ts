import type { LanCatalogChangedEvent, LanOrganizationPatch } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { saveSidebarPreferences } from "../../lib/sidebar-preferences";
import { preferencesFromState } from "../../stores/helpers/store-helpers";
import { useAppStore } from "../../stores/app-store";

/**
 * Apply one organization edit made from a paired browser through the same
 * store actions the sidebar uses. Never selects or navigates.
 */
export function applyLanOrganizationPatch(entry: LanOrganizationPatch): void {
  const store = useAppStore.getState();
  if (entry.kind === "project") {
    const { name, pinned, archived } = entry.patch;
    if (name !== undefined) store.renameProject(entry.key, name);
    if (pinned !== undefined) store.toggleProjectPinned(entry.key, pinned);
    if (archived === true) store.archiveProject(entry.key);
    if (archived === false) store.restoreProject(entry.key);
    return;
  }
  const { pinned, archived, manualTitle } = entry.patch;
  if (pinned !== undefined && (store.sessionMeta[entry.key]?.pinned === true) !== pinned) {
    store.toggleSessionPinned(entry.key);
  }
  if (archived === true) store.archiveSession(entry.key);
  if (archived === false) store.restoreSession(entry.key);
  if (manualTitle !== undefined) {
    useAppStore.setState((state) => ({
      sessionMeta: {
        ...state.sessionMeta,
        [entry.key]: { ...(state.sessionMeta[entry.key] ?? {}), manualTitle },
      },
    }));
    saveSidebarPreferences(preferencesFromState(useAppStore.getState()));
  }
}

/** Subscribe the Desktop shell to browser organization edits. */
export function subscribeLanCatalogSync(): () => void {
  return api.onLanWebUiCatalogChanged((event: LanCatalogChangedEvent) => {
    for (const entry of event.patches ?? []) {
      try {
        applyLanOrganizationPatch(entry);
      } catch {
        // A malformed edit must not break the shell; Main keeps it pending.
      }
    }
    // The sidebar writes above are ordered before this acknowledgement.
    void api.lanWebUiAdmin({ kind: "ack", seq: event.seq }).catch(() => undefined);
    void useAppStore.getState().refreshSessions().catch(() => undefined);
  });
}
