import type { ToolTokenUsage, UiMessage } from "@pi-desktop/shared";

/** Refresh the original Task row without repeating the tool or its token usage. */
export function settledDelegationMessage(
  message: UiMessage,
  summary: Record<string, unknown>,
): UiMessage {
  const result = {
    content: [
      { type: "text", text: `Delegation ${summary.delegationId}: ${summary.status}.` },
    ],
    details: summary,
  };
  return { ...message, content: JSON.stringify(result), toolResult: result };
}

/** Retain the original, already completed Task call when its delegate starts. */
export function taskMessageSnapshot({
  toolCallId,
  toolName,
  args,
  startedAt,
  endedAt,
  result,
  toolUsage,
}: {
  toolCallId: string;
  toolName: string;
  args: unknown;
  startedAt: number;
  endedAt: number;
  result: unknown;
  toolUsage?: ToolTokenUsage;
}): UiMessage {
  return {
    id: toolCallId,
    role: "tool",
    content: JSON.stringify(result),
    createdAt: new Date(startedAt).toISOString(),
    toolCallId,
    toolName,
    toolArgs: args,
    toolStatus: "success",
    toolResult: result,
    toolCompletedAt: new Date(endedAt).toISOString(),
    toolDurationMs: Math.max(0, endedAt - startedAt),
    ...(toolUsage ? { toolUsage } : {}),
    status: "complete",
    isError: false,
  };
}
