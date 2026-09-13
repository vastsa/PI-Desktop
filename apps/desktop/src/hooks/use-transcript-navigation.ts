import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { TranscriptNavigationController } from "../lib/transcript-navigation";
import { useAppStore } from "../stores/app-store";
import { useSessionSearchState } from "./use-session-search";

export function useTranscriptNavigation(sessionId: string, visible: boolean, isRunning: boolean) {
  const controller = useMemo(() => new TranscriptNavigationController(api.getSession), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const target = useSessionSearchState((search) => search.target);
  const consumed = useRef(0);
  const wasRunning = useRef(isRunning);
  useEffect(() => {
    if (!visible || target?.sessionId !== sessionId || target.requestId === consumed.current) return;
    consumed.current = target.requestId;
    void controller.navigate(target);
    useSessionSearchState.getState().consumeTarget(target.requestId);
  }, [controller, sessionId, target, visible]);
  useEffect(() => {
    if (isRunning && !wasRunning.current) controller.clear();
    wasRunning.current = isRunning;
  }, [controller, isRunning]);
  useEffect(() => () => controller.clear(), [controller]);
  useEffect(() => useAppStore.subscribe((next, previous) => {
    // Explicit edits, revisions, and deletions publish an authoritative
    // transcript. Do not leave a historical snapshot covering their result.
    if (next.activeSessionId !== sessionId || previous.activeSessionId !== sessionId ||
      next.messages === previous.messages ||
      next.isRunning || previous.isRunning) return;
    const remaining = new Set(next.messages.map((message) => message.id));
    if (previous.messages.some((message) => !remaining.has(message.id))) controller.clear();
  }), [controller, sessionId]);
  useEffect(() => {
    if (state.error && visible) useAppStore.getState().showToast(state.error, { variant: "error" });
  }, [state.error, visible]);
  return { ...state, loadBefore: () => controller.page("before"), loadAfter: () => controller.page("after"), clear: controller.clear };
}
