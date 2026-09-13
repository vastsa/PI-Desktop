import { useEffect, useMemo, useSyncExternalStore } from "react";
import { create } from "zustand";
import type { SessionSearchContextRequest } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { SessionSearchController } from "../lib/session-search";

/** Transient search state survives closing the palette, never goes to disk. */
export const useSessionSearchState = create<{
  query: string;
  focus?: SessionSearchContextRequest;
  setQuery: (query: string) => void;
  setFocus: (focus?: SessionSearchContextRequest) => void;
}>((set) => ({
  query: "",
  setQuery: (query) => set({ query }),
  setFocus: (focus) => set({ focus }),
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
    hits: state.query === normalized ? state.hits : [],
    nextOffset: state.query === normalized ? state.nextOffset : null,
    error: state.query === normalized ? state.error : undefined,
    loading: Boolean(normalized) && (state.query !== normalized || state.loading),
    loadMore: controller.loadMore,
    retry: controller.retry,
  };
}
