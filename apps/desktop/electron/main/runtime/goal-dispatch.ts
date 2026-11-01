import type { AgentPromptRequest, GoalTurnContext } from "@pi-desktop/shared";

// Object identity survives internal invokeIpc, never Electron structured clone.
// A renderer/plugin cannot forge continuation authority with JSON fields.
const claims = new WeakMap<AgentPromptRequest, GoalTurnContext>();
export function goalDispatchRequest(request: AgentPromptRequest, claim?: GoalTurnContext): AgentPromptRequest {
  if (claim) claims.set(request, claim);
  return request;
}
export function goalDispatchContext(request: AgentPromptRequest): GoalTurnContext | undefined {
  return claims.get(request);
}

// The replacement has already been persisted. Abort only the retired runtime,
// never pause the new Goal. JSON/structured clone cannot carry this authority.
const replacementAborts = new WeakSet<object>();
export function goalReplacementAbortRequest<T extends object>(request: T, reason?: "goal-replaced"): T {
  if (reason === "goal-replaced") replacementAborts.add(request);
  return request;
}
export function isGoalReplacementAbort(request: object): boolean {
  return replacementAborts.has(request);
}
