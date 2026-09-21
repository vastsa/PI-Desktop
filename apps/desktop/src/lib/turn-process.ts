import type { AppSettings, UiMessage } from "@pi-desktop/shared";
import type { AssistantTurnEntry, AssistantTurnPart } from "./assistant-turns";
import { activityItemHasIssue } from "./activity-summary";

type ThinkingDisplayMode = NonNullable<AppSettings["thinkingDisplayMode"]>;

export function resolveThinkingDisplayMode(value: unknown): ThinkingDisplayMode {
  return value === "compact" ? "compact" : value === "auto" ? "auto" : "detailed";
}

export function isThinkingActive(message: UiMessage, active: boolean): boolean {
  return active && message.status === "streaming" && !message.content.trim();
}

export function isTurnThinking(
  parts: readonly AssistantTurnPart[],
  active: boolean,
): boolean {
  const latestPart = parts.at(-1);
  const latestActivity =
    latestPart?.kind === "activity" ? latestPart.items.at(-1) : undefined;
  return (
    latestActivity?.kind === "thinking" &&
    isThinkingActive(latestActivity.message, active)
  );
}

export function processContainsMessage(
  parts: readonly AssistantTurnPart[],
  messageId: string,
): boolean {
  return parts.some((part) => {
    if (part.kind === "message") return part.message.id === messageId;
    return part.items.some((item) => {
      if (item.message.id === messageId) return true;
      return (
        item.kind === "tool" &&
        Boolean(item.delegate?.items.some((row) => row.message.id === messageId))
      );
    });
  });
}

export function hasFailedProcessTool(parts: readonly AssistantTurnPart[]): boolean {
  return parts.some(
    (part) =>
      part.kind === "activity" &&
      part.items.some(activityItemHasIssue),
  );
}

/** Both presentation modes expose the same process hierarchy. */
export function shouldGroupTurnProcess(mode: ThinkingDisplayMode): boolean {
  return mode === "detailed" || mode === "compact" || mode === "auto";
}

/** The last activity chunk of a turn owns detailed-mode's default-open tool. */
export function isLastActivityPart(
  parts: readonly AssistantTurnPart[],
  part: AssistantTurnPart,
): boolean {
  if (part.kind !== "activity") return false;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index].kind === "activity") return parts[index] === part;
  }
  return false;
}

/**
 * Detailed keeps narration visible; compact reveals active failures only;
 * auto (ChatGPT style) stays open while thinking and collapses once answers start.
 */
export function shouldAutoOpenTurnProcess(
  mode: ThinkingDisplayMode,
  isActive: boolean,
  hasToolFailure: boolean,
  hasAnswer?: boolean,
): boolean {
  if (mode === "auto") {
    return (isActive && !hasAnswer) || (isActive && hasToolFailure);
  }
  return mode === "detailed" || (isActive && hasToolFailure);
}

/**
 * Only a trailing assistant text can be the answer: text followed by tools is
 * progress. The stream carries no final-answer marker, so a live trailing text
 * remains visible until a later activity establishes that it was intermediate.
 * Errors remain outside the disclosure even when more activity follows them.
 */
export function projectTurnProcess(entry: AssistantTurnEntry) {
  const last = entry.parts.at(-1);
  const answer =
    last?.kind === "message" && last.message.content.trim() ? last : undefined;
  const process: AssistantTurnPart[] = [];
  const responses: Extract<AssistantTurnPart, { kind: "message" }>[] = [];
  for (const part of entry.parts) {
    if (part.kind === "message" && (part === answer || part.message.error)) {
      responses.push(part);
    } else {
      process.push(part);
    }
  }
  return { process, responses };
}

export function visibleProcessSteps(
  parts: readonly AssistantTurnPart[],
  mode: ThinkingDisplayMode,
  active: boolean,
): number {
  let count = 0;
  for (const part of parts) {
    if (part.kind === "message") {
      if (part.message.content.trim()) count += 1;
      continue;
    }
    for (const item of part.items) {
      if (
        item.kind !== "thinking" ||
        mode === "detailed" ||
        mode === "auto" ||
        isThinkingActive(item.message, active)
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/** Use recorded message/tool timing for history; elapsed live time is UI-only. */
export function turnProcessTiming(parts: readonly AssistantTurnPart[]) {
  const messages = parts.flatMap((part) =>
    part.kind === "message" ? [part.message] : part.items.map((item) => item.message),
  );
  const starts = messages
    .map((message) => Date.parse(message.createdAt))
    .filter(Number.isFinite);
  if (starts.length === 0) return { startedAt: undefined, endedAt: undefined };
  const startedAt = Math.min(...starts);
  const endedAt = Math.max(
    startedAt,
    ...messages.map((message) => {
      const createdAt = Date.parse(message.createdAt);
      if (!Number.isFinite(createdAt)) return startedAt;
      const duration =
        message.role === "tool" ? message.toolDurationMs : message.responseDurationMs;
      const recordedEnd = Date.parse(message.toolCompletedAt ?? "");
      return Number.isFinite(recordedEnd)
        ? recordedEnd
        : createdAt +
            (typeof duration === "number" && Number.isFinite(duration)
              ? Math.max(0, duration)
              : 0);
    }),
  );
  return { startedAt, endedAt };
}
