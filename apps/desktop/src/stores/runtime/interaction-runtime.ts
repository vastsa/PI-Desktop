import type { PlanResolutionResult } from "@pi-desktop/shared";

export type InteractionRuntime = {
  planResolutionRequests: Map<string, Promise<PlanResolutionResult>>;
  nextToastId: () => number;
};

/** Ephemeral coordination for user interactions; durable state stays in Zustand. */
export function createInteractionRuntime(): InteractionRuntime {
  let toastSequence = 0;
  return {
    planResolutionRequests: new Map<string, Promise<PlanResolutionResult>>(),
    nextToastId: () => ++toastSequence,
  };
}
