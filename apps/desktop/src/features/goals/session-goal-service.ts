import { goalCanResume, goalIsTerminal, type GoalBudget, type GoalChangedEvent, type GoalControlRequest, type GoalResult, type SessionGoal } from "@pi-desktop/shared";

export interface GoalApi {
  getGoal(sessionId: string): Promise<GoalResult>;
  controlGoal(request: GoalControlRequest): Promise<GoalResult>;
  onGoalChanged(listener: (event: GoalChangedEvent) => void): () => void;
}
export type GoalControl = (action: GoalControlRequest["action"], budget?: GoalBudget, objective?: string) => Promise<boolean>;
export type GoalSnapshot = {
  goal: SessionGoal | null;
  loading: boolean;
  pending: GoalControlRequest["action"] | null;
  error: string | null;
};

/** One session subscription owns reads, CAS controls and logical-removal tombstones. */
export function createSessionGoalService(sessionId: string, api: GoalApi) {
  let snapshot: GoalSnapshot = { goal: null, loading: true, pending: null, error: null };
  const listeners = new Set<() => void>();
  const retiredIds = new Set<string>();
  let readVersion = 0;
  let generation = 0;
  let eventVersion = 0;
  let controlVersion = 0;
  let started = false;
  let unsubscribe: (() => void) | undefined;
  const publish = (patch: Partial<GoalSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const accept = (result: GoalResult) => {
    const goal = result.goal;
    if (!goal) {
      // Bare empty reads cannot erase a goal received from a newer host event.
      if (!result.goalId || typeof result.revision !== "number" || !Number.isSafeInteger(result.revision)) return;
      if (snapshot.goal?.id === result.goalId && snapshot.goal.revision > result.revision) return;
      retiredIds.add(result.goalId);
      if (snapshot.goal?.id === result.goalId) {
        controlVersion++;
        publish({ goal: null, pending: null, error: null, loading: false });
      }
      return;
    }
    if (goal.sessionId !== sessionId || retiredIds.has(goal.id)) return;
    if (snapshot.goal?.id === goal.id && snapshot.goal.revision >= goal.revision) return;
    if (snapshot.goal && snapshot.goal.id !== goal.id) {
      retiredIds.add(snapshot.goal.id);
      controlVersion++;
      publish({ pending: null, error: null });
    }
    publish({ goal });
  };
  const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
  const reload = async () => {
    if (!started) return;
    const owner = generation;
    const version = eventVersion;
    const read = ++readVersion;
    publish({ loading: true, error: null });
    try {
      const result = await api.getGoal(sessionId);
      if (owner !== generation || read !== readVersion) return;
      if (version === eventVersion) {
        if (result.goal === null && !result.goalId) {
          // A current read can reconcile a removal notification missed while
          // unsubscribed. Retire the old identity before delayed events arrive.
          if (snapshot.goal) retiredIds.add(snapshot.goal.id);
          controlVersion++;
          publish({ goal: null, pending: null });
        } else accept(result);
      }
      publish({ loading: false });
    } catch (error) {
      if (owner === generation && read === readVersion) {
        publish({ loading: false, ...(version === eventVersion ? { error: failure(error) } : {}) });
      }
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      const owner = ++generation;
      started = true;
      controlVersion++;
      publish({ pending: null });
      unsubscribe?.();
      unsubscribe = api.onGoalChanged((event) => {
        if (owner !== generation || event.sessionId !== sessionId) return;
        const previous = snapshot.goal;
        accept(event);
        if (snapshot.goal !== previous) eventVersion++;
        if (previous || snapshot.goal) publish({ loading: false });
      });
      void reload();
      return () => {
        if (owner !== generation) return;
        started = false; generation++; controlVersion++;
        unsubscribe?.(); unsubscribe = undefined;
      };
    },
    reload,
    async control(action: GoalControlRequest["action"], budget?: GoalBudget, objective?: string): Promise<boolean> {
      const goal = snapshot.goal;
      if (!started || !goal || snapshot.pending || (goalIsTerminal(goal) && action !== "delete")) return false;
      const objectiveText = objective?.trim();
      if (action === "edit" && !objectiveText) return false;
      if (action === "pause" && goal.status !== "active") return false;
      if (action === "resume" && !goalCanResume(goal)) return false;
      const owner = generation;
      const operation = ++controlVersion;
      publish({ pending: action, error: null });
      try {
        const result = await api.controlGoal({ sessionId, goalId: goal.id, expectedRevision: goal.revision, action,
          ...((action === "resume" || action === "budget") && budget !== undefined ? { budget } : {}), ...(action === "edit" && objectiveText ? { objective: objectiveText } : {}) });
        if (owner !== generation || operation !== controlVersion) return false;
        if ((result.goal?.id ?? result.goalId) !== goal.id) return false;
        accept(result);
        return action === "delete" ? retiredIds.has(goal.id) : snapshot.goal?.id === goal.id && snapshot.goal.revision > goal.revision;
      } catch (error) {
        if (owner === generation && operation === controlVersion && snapshot.goal?.id === goal.id && snapshot.goal.revision === goal.revision) publish({ error: failure(error) });
        return false;
      } finally {
        if (owner === generation && operation === controlVersion) publish({ pending: null });
      }
    },
  };
}
