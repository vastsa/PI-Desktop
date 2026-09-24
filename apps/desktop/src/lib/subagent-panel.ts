import type { UiMessage } from "@pi-desktop/shared";
import { toolResultPayload } from "./tool-presentation";

/**
 * The stable delegation id a transcript row is keyed by: the Task result's
 * `delegationId` when the runtime recorded one, else the call's own identity.
 * Shared by the delegation topology and the subagent transcript tab.
 */
export function delegationIdForMessage(message: UiMessage): string {
  const payload = toolResultPayload(message);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const delegationId = (payload as { delegationId?: unknown }).delegationId;
    if (typeof delegationId === "string" && delegationId) return delegationId;
  }
  return message.toolCallId || message.id;
}
