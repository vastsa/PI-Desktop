import type { ThinkingLevel, UiMessage } from "@pi-desktop/shared";
import { THINKING_LEVELS } from "@pi-desktop/shared";
import type { SubagentRun } from "../../../lib/assistant-turns";
import { toolResultPayload } from "../../../lib/tool-presentation";

export function delegateAgentName(
  message: UiMessage,
  delegate?: SubagentRun,
): string {
  if (delegate?.agentName) return delegate.agentName;
  const args = message.toolArgs;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const requested = (args as { agent?: unknown }).agent;
    if (typeof requested === "string") return requested;
  }
  return "";
}

/** Effective model resolved for this delegation, recorded by the Task result. */
export function delegateModelId(message: UiMessage): string {
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  const modelId = (payload as { modelId?: unknown }).modelId;
  return typeof modelId === "string" ? modelId.trim() : "";
}

/** Effective thinking level resolved for this delegation, from the Task result.
 * `off` and `omit` deliberately have no visible suffix. */
export function delegateThinkingLevel(message: UiMessage): ThinkingLevel | undefined {
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const value = (payload as { thinkingLevel?: unknown }).thinkingLevel;
  if (
    typeof value !== "string" ||
    value === "off" ||
    !THINKING_LEVELS.includes(value as ThinkingLevel)
  ) {
    return undefined;
  }
  return value as ThinkingLevel;
}

/**
 * Copies a run row's command from its head. The expanded body holds only the
 * output, so this is the one place the command can be taken from (D226).
 */
