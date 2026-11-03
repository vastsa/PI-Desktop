import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { createSessionGoalService, type GoalControl, type GoalSnapshot } from "./session-goal-service";

const empty: GoalSnapshot = { goal: null, loading: false, pending: null, error: null };
const inactive = {
  getSnapshot: () => empty,
  subscribe: (_listener: () => void) => () => {},
  start: () => () => {},
  control: (async () => false) as GoalControl,
  reload: async () => {},
};

export function useSessionGoal(sessionId: string | null) {
  const service = useMemo(() => sessionId ? createSessionGoalService(sessionId, api) : inactive, [sessionId]);
  useEffect(() => service.start(), [service]);
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const control = useMemo<GoalControl>(() => async (...args) => {
    const removed = args[0] === "delete" && sessionId ? useAppStore.getState().prepareGoalRemoval(sessionId) : undefined;
    const accepted = await service.control(...args);
    if (accepted) removed?.();
    return accepted;
  }, [service, sessionId]);
  return { ...snapshot, control, reload: service.reload };
}
