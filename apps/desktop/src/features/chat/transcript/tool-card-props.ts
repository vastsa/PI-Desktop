/**
 * Props projection and push cadence for the `toolCard` slot
 * (`docs/plugin-plan/ui/tool-card/`).
 *
 * The contract fixes the fields (toolName / toolCallId / toolArgs? /
 * toolStatus / toolResult? / toolError? / durationMs? + ids) and
 * the cadence: while the tool runs, the whole projection is pushed on a
 * 500ms merged beat; a status transition and the final result push
 * immediately. Failure is data, never a throw: a failed call carries what the
 * tool returned as `toolError` instead of `toolResult`. JSX-free so logic
 * tests can drive it directly.
 */
import type { PluginToolCardSlotProps } from "@pi-desktop/plugin-sdk";
import type { UiMessage } from "@pi-desktop/shared";

/** Merged-push beat while a call is still running. */
export const TOOL_CARD_RUNNING_INTERVAL_MS = 500;

/**
 * The props vocabulary carries three statuses; `denied` is host vocabulary,
 * so a denied row keeps the host default card and never reaches a plugin.
 */
export function toolCardStatusOf(
  message: UiMessage,
): PluginToolCardSlotProps["toolStatus"] {
  return message.toolStatus === "running" || message.toolStatus === "error"
    ? message.toolStatus
    : "success";
}

/**
 * Full props for one card. `toolName` is the bare name the card registered
 * for; the transcript carries the qualified agent-facing one.
 */
export function toolCardSlotProps(
  message: UiMessage,
  toolName: string,
  sessionId: string,
): PluginToolCardSlotProps {
  const toolStatus = toolCardStatusOf(message);
  const failed = toolStatus === "error";
  return {
    toolName,
    toolCallId: message.toolCallId ?? message.id,
    toolArgs: message.toolArgs,
    toolStatus,
    toolResult: failed ? undefined : message.toolResult,
    toolError: failed ? message.toolResult : undefined,
    durationMs: message.toolDurationMs,
    messageId: message.id,
    sessionId,
  };
}

/**
 * The push decision: a status transition or a finished result is immediate;
 * running-tick updates merge onto the 500ms beat.
 */
export function shouldEmitToolCard(
  lastEmittedAt: number,
  lastStatus: PluginToolCardSlotProps["toolStatus"],
  nextStatus: PluginToolCardSlotProps["toolStatus"],
  now: number,
  interval: number = TOOL_CARD_RUNNING_INTERVAL_MS,
): boolean {
  if (nextStatus !== lastStatus) return true;
  if (nextStatus !== "running") return true;
  return now - lastEmittedAt >= interval;
}
