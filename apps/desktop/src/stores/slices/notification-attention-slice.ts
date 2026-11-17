import type { AppNotification } from "@pi-desktop/shared";
import { api } from "../../lib/api";
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
  "refreshNotificationAttention" | "loadMoreCompletionNotifications" |
  "receiveCompletionNotification" | "acknowledgeVisibleCompletions" | "dismissNotificationRequests"> {
  let generation = 0;
  let liveRevision = 0;
  const viewedIds = new Set<string>();
  const acknowledging = new Set<string>();

  const refreshCompletions = async (append = false): Promise<void> => {
    const requestGeneration = ++generation;
    const revision = liveRevision;
    const offset = append ? get().pendingCompletions.length : 0;
    const result = await api.listNotifications({ limit: 200, completionOffset: offset });
    if (requestGeneration !== generation || !result.pendingCompletions) return;
    // A live insertion shifts offset pages and may already be in the Host total.
    // Re-read after that event instead of guessing whether to add it to the count.
    if (revision !== liveRevision) return refreshCompletions(append);
    const page = result.pendingCompletions.filter((item) => !viewedIds.has(item.id));
    set((state) => {
      const retained = append ? state.pendingCompletions.filter((item) => !viewedIds.has(item.id)) : [];
      const rows = new Map([...retained, ...page].map((item) => [item.id, item]));
      const viewedCount = (result.pendingCompletions?.length ?? 0) - page.length;
      return {
        pendingCompletions: [...rows.values()],
        pendingCompletionCount: Math.max(rows.size,
          (result.pendingCompletionCount ?? page.length) - viewedCount),
      };
    });
  };

  const restoreAsks = async () => {
    const sessions = [...get().sessions];
    let cursor = 0;
    // Do not activate a conversation or replay chimes while recovering its asks.
    await Promise.all(Array.from({ length: Math.min(4, sessions.length) }, async () => {
      while (cursor < sessions.length) {
        const session = sessions[cursor++];
        await get().restorePendingInteractive(session.id);
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
      await Promise.all([refreshCompletions(), restoreAsks()]);
    },
    loadMoreCompletionNotifications: () => refreshCompletions(true),
    receiveCompletionNotification: (notification: AppNotification) => {
      if (notification.kind !== "task.completed" || viewedIds.has(notification.id) ||
        get().pendingCompletions.some((item) => item.id === notification.id)) return;
      ++liveRevision;
      set((state) => ({
        pendingCompletions: [notification, ...state.pendingCompletions],
        pendingCompletionCount: state.pendingCompletionCount + 1,
      }));
    },
    acknowledgeVisibleCompletions: async () => {
      const sessionId = visibleNotificationSession(get());
      if (!sessionId) return;
      let items = get().pendingCompletions.filter((item) =>
        item.sessionId === sessionId && !acknowledging.has(item.id));
      // The owning result may be older than the first rendered page. Search
      // bounded pages without making the user load unrelated chats first.
      if (!items.length && get().pendingCompletionCount > get().pendingCompletions.length) {
        let offset = 0;
        let total = get().pendingCompletionCount;
        while (offset < total && !items.length) {
          const result = await api.listNotifications({ limit: 200, completionOffset: offset });
          if (visibleNotificationSession(get()) !== sessionId) return;
          const rows = result.pendingCompletions ?? [];
          if (!rows.length) break;
          total = result.pendingCompletionCount ?? rows.length;
          offset += rows.length;
          items = rows.filter((item) => item.sessionId === sessionId &&
            !viewedIds.has(item.id) && !acknowledging.has(item.id));
        }
      }
      if (!items.length) return;
      try {
        for (const item of items) {
          // A user may have left this chat while the previous confirmation awaited IPC.
          if (visibleNotificationSession(get()) !== sessionId) break;
          acknowledging.add(item.id);
          try {
            await get().markNotificationRead(item.id);
            viewedIds.add(item.id);
            ++generation;
            set((state) => ({
              pendingCompletions: state.pendingCompletions.filter((row) => row.id !== item.id),
              pendingCompletionCount: Math.max(0, state.pendingCompletionCount - 1),
            }));
          } finally {
            acknowledging.delete(item.id);
          }
        }
      } finally {
        // Also updates ordinary taskbar/sidebar read state and fills the next page.
        await get().refreshNotifications();
      }
      await refreshCompletions();
    },
  };
}
