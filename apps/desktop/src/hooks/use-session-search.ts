import { useEffect, useMemo, useSyncExternalStore } from "react";
import { create } from "zustand";
import { api } from "../lib/api";
import { SessionSearchController } from "../lib/session-search";
import { isAutomationSession } from "../lib/session-origin";

/** Transient search state survives closing the palette, never goes to disk. */
export const useSessionSearchState = create<{
  query: string;
  setQuery: (query: string) => void;
}>((set) => ({
  query: "",
  setQuery: (query) => set({ query }),
}));

export function useSessionSearch(open: boolean, query: string) {
  const controller = useMemo(() => new SessionSearchController(api.searchSessions), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const normalized = query.trim();
  useEffect(() => {
    if (!open) return;
    controller.reset(normalized);
    const timer = window.setTimeout(() => void controller.load(), 150);
    return () => {
      window.clearTimeout(timer);
      controller.cancel();
    };
  }, [controller, normalized, open]);
  return {
    ...state,
    // Scheduled run transcripts are reached from the Scheduled page, so search
    // never offers them as a conversation to switch to (issue #1291).
    hits:
      state.query === normalized
        ? state.hits.filter((hit) => !isAutomationSession(hit.session))
        : [],
    nextOffset: state.query === normalized ? state.nextOffset : null,
    error: state.query === normalized ? state.error : undefined,
    loading: Boolean(normalized) && (state.query !== normalized || state.loading),
    loadMore: controller.loadMore,
    retry: controller.retry,
  };
}
