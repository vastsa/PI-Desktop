import { subagentTaskPayload, type UiMessage } from "@pi-desktop/shared";

/**
 * The stable delegation id a transcript row is keyed by: the Task result's
 * `delegationId` when the runtime recorded one, else the call's own identity.
 * Shared by the delegation topology and the subagent transcript tab.
 */
export function delegationIdForMessage(message: UiMessage): string {
  const delegationId = subagentTaskPayload(message)?.delegationId;
  if (typeof delegationId === "string" && delegationId.trim()) return delegationId.trim();
  return message.toolCallId || message.id;
}
