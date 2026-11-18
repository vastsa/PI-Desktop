import type { AppState } from "../app-state";
import type { StoreAccess } from "./types";

/** A hidden window or an unfinished navigation is not a read. */
export function visibleNotificationSession(state: Pick<AppState,
  "page" | "activeSessionId" | "selectingSessionId">): string | undefined {
  return state.page === "chat" && !state.selectingSessionId &&
    typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()
    ? state.activeSessionId : undefined;
}

export function createNotificationAttentionSlice({ get, set }: StoreAccess): Pick<AppState,
  "refreshNotificationAttention" | "acknowledgeVisibleCompletions" | "dismissNotificationRequests"> {
  const acknowledging = new Set<string>();

  const restoreAsks = async () => {
    const sessions = [...get().sessions];
    let cursor = 0;
    // Recovery must not activate conversations or replay their chimes.
    await Promise.all(Array.from({ length: Math.min(4, sessions.length) }, async () => {
      while (cursor < sessions.length) {
        await get().restorePendingInteractive(sessions[cursor++].id);
      }
    }));
  };

  return {
    dismissNotificationRequests: (ids) => {
      const state = get();
      const active = new Set([...Object.values(state.pendingAsks).flat(),
        ...Object.values(state.pendingPermissions).flat()].map((item) => item.requestId));
      const next: Record<string, true> = {};
      for (const id of [...Object.keys(state.dismissedNotificationRequests), ...ids]) {
        if (active.has(id)) next[id] = true;
      }
      set({ dismissedNotificationRequests: next });
    },
    refreshNotificationAttention: async () => {
      await Promise.all([get().refreshNotifications(), restoreAsks()]);
    },
    acknowledgeVisibleCompletions: async () => {
      const sessionId = visibleNotificationSession(get());
      if (!sessionId) return;
      const items = get().notifications.filter((item) =>
        item.kind === "task.completed" && !item.readAt &&
        item.sessionId === sessionId && !acknowledging.has(item.id));
      for (const item of items) {
        if (visibleNotificationSession(get()) !== sessionId) break;
        acknowledging.add(item.id);
        try {
          // Reuse the history owner's exact-ID acknowledgement and stale-read guard.
          await get().markNotificationRead(item.id);
        } finally {
          acknowledging.delete(item.id);
        }
      }
    },
  };
}
