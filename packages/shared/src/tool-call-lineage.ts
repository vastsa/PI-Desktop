import type { AgentEventEnvelope, UiMessage } from "./types.js";

/** Task ownership and tool nesting are independent relationships. */
export type ToolCallLineage = Pick<
  AgentEventEnvelope,
  "parentToolCallId" | "nestedParentToolCallId" | "agentName"
>;

export function toolCallLineage(source: ToolCallLineage, fallback: ToolCallLineage = {}): ToolCallLineage {
  source = {
    parentToolCallId: source.parentToolCallId || fallback.parentToolCallId,
    nestedParentToolCallId: source.nestedParentToolCallId || fallback.nestedParentToolCallId,
    agentName: source.agentName || fallback.agentName,
  };
  return {
    ...(source.parentToolCallId ? { parentToolCallId: source.parentToolCallId } : {}),
    ...(source.nestedParentToolCallId
      ? { nestedParentToolCallId: source.nestedParentToolCallId }
      : {}),
    ...(source.agentName ? { agentName: source.agentName } : {}),
  };
}

export function tagMessageToolLineage(
  message: UiMessage,
  source: ToolCallLineage,
): UiMessage {
  if (!source.parentToolCallId && !source.nestedParentToolCallId && !source.agentName) {
    return message;
  }
  return { ...message, ...toolCallLineage(source) };
}
