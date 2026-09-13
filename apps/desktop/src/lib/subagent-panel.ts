import type { UiMessage } from "@pi-desktop/shared";
import { toolResultPayload } from "./tool-presentation";

/** The renderer-local subagent detail currently shown in the work-panel dock. */
export type SubagentPanelSelection = {
  sessionId: string;
  /** Stable delegation id from the Task result, used to re-find live rows. */
  delegationId: string;
  /** Connect an explicit search to the shared transcript reading view. */
  searchRequestId?: number;
};

export function delegationIdForMessage(message: UiMessage): string {
  const payload = toolResultPayload(message);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const delegationId = (payload as { delegationId?: unknown }).delegationId;
    if (typeof delegationId === "string" && delegationId) return delegationId;
  }
  return message.toolCallId || message.id;
}
