import { useEffect, useMemo, useSyncExternalStore } from "react";
import { create } from "zustand";
import { api } from "../lib/api";
import type { TranscriptSearchTarget } from "../lib/transcript-navigation";
import { SessionSearchController } from "../lib/session-search";

/** Transient search state survives closing the palette, never goes to disk. */
let nextTargetRequest = 0;
export const useSessionSearchState = create<{
  query: string;
  target: TranscriptSearchTarget | null;
  navigate: (target: Omit<TranscriptSearchTarget, "requestId">) => void;
  consumeTarget: (requestId: number) => void;
  setQuery: (query: string) => void;
}>((set) => ({
  query: "",
  target: null,
  navigate: (target) => set({ target: { ...target, requestId: ++nextTargetRequest } }),
  consumeTarget: (requestId) => set((state) => state.target?.requestId === requestId ? { target: null } : state),
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
    hits: state.query === normalized ? state.hits : [],
    nextOffset: state.query === normalized ? state.nextOffset : null,
    error: state.query === normalized ? state.error : undefined,
    loading: Boolean(normalized) && (state.query !== normalized || state.loading),
    loadMore: controller.loadMore,
    retry: controller.retry,
  };
}
