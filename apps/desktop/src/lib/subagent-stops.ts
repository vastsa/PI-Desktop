import { create } from "zustand";
import { api } from "./api";
import { useAppStore } from "../stores/app-store";

/** One in-flight stop per session across every delegation surface. */
export const useStops = create<{
  busy: Record<string, { ids?: readonly string[] } | undefined>;
  pending: Record<string, string[]>;
}>(() => ({ busy: {}, pending: {} }));

export async function requestSubagentStop(sessionId: string, selection?: readonly string[]) {
  const state = useStops.getState();
  if (state.busy[sessionId]) return;
  const ids = selection?.filter(id => !state.pending[sessionId]?.includes(id));
  // An empty selection must never be promoted to a session-wide stop.
  if (ids && !ids.length) return;
  useStops.setState(state => ({ busy: { ...state.busy, [sessionId]: { ids } } }));
  try {
    const result = await api.stopSubagents({ sessionId, ...(ids ? { delegationIds: ids } : {}) });
    if (result.pending.length) {
      useStops.setState(state => ({ pending: {
        ...state.pending,
        [sessionId]: [...new Set([...(state.pending[sessionId] ?? []), ...result.pending])],
      } }));
    }
  } catch (error) {
    useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
  } finally {
    useStops.setState(state => {
      const busy = { ...state.busy };
      delete busy[sessionId];
      return { busy };
    });
  }
}
