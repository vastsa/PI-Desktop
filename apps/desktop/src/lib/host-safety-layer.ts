import { useLayoutEffect, useSyncExternalStore } from "react";
import type { PlanProposal } from "@pi-desktop/shared";
import { headAsk, type AskQueues } from "./pending-asks";
import { headPermission, type PermissionQueues } from "./pending-permissions";

// The host's own decision surfaces: the places where the user answers the
// agent or an extension. Plugin layers (`pi.ui.openLayer`) may never cover
// one, so they step aside while any is waiting. Surfaces the store knows of
// are read from it (`sessionAwaitsDecision`); the others announce themselves
// while mounted (`useHostSafetySurface`), counted by owner so one closing
// cannot clear another.
const owners = new Set<symbol>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
export const subscribeHostSafetySurfaces = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const isHostSafetySurfaceMounted = () => owners.size > 0;

/** Holds a host decision surface up until the returned release is called. */
export function claimHostSafetySurface(): () => void {
  const owner = Symbol();
  owners.add(owner);
  notify();
  return () => {
    if (owners.delete(owner)) notify();
  };
}

/** Marks the calling component as a host decision surface while mounted. */
export function useHostSafetySurface() {
  useLayoutEffect(claimHostSafetySurface, []);
}

export function useHostSafetySurfaceMounted() {
  return useSyncExternalStore(subscribeHostSafetySurfaces, isHostSafetySurfaceMounted, () => false);
}

export type DecisionState = {
  activeSessionId?: string;
  pendingPermissions: PermissionQueues;
  pendingAsks: AskQueues;
  planCheckpoints: Record<string, PlanProposal>;
};

/**
 * Whether the visible session waits on the user: a permission request, a
 * question, or a plan awaiting approval.
 */
export function sessionAwaitsDecision(state: DecisionState): boolean {
  const sessionId = state.activeSessionId;
  if (!sessionId) return false;
  return Boolean(
    headPermission(state.pendingPermissions, sessionId) ||
      headAsk(state.pendingAsks, sessionId) ||
      state.planCheckpoints[sessionId]?.status === "pending",
  );
}
