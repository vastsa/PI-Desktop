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
