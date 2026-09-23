import type { AppSettings, UiMessage } from "@pi-desktop/shared";
import type { AssistantTurnEntry, AssistantTurnPart } from "./assistant-turns";
import { activityItemHasIssue } from "./activity-summary";

type ThinkingDisplayMode = NonNullable<AppSettings["thinkingDisplayMode"]>;

export function resolveThinkingDisplayMode(value: unknown): ThinkingDisplayMode {
  return value === "compact" ? "compact" : "detailed";
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
    if (part.kind === "message" || part.kind === "steering") {
      return part.message.id === messageId;
    }
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

/** Every turn uses one process disclosure; the mode only filters its steps. */
export function shouldGroupTurnProcess(_mode: ThinkingDisplayMode): boolean {
  return true;
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

/** Active work stays visible; every completed process defaults to collapsed. */
export function shouldAutoOpenTurnProcess(
  _mode: ThinkingDisplayMode,
  isActive: boolean,
  _hasToolFailure: boolean,
): boolean {
  return isActive;
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
      continue;
    }
    process.push(part);
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
    if (part.kind === "steering") {
      count += 1;
      continue;
    }
    for (const item of part.items) {
      if (
        item.kind !== "thinking" ||
        mode === "detailed" ||
        isThinkingActive(item.message, active)
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/** Use the initiating user time when loaded, otherwise the first process row. */
export function turnProcessTiming(
  parts: readonly AssistantTurnPart[],
  turnStartedAt?: string,
) {
  const messages = parts.flatMap((part) => {
    if (part.kind === "message" || part.kind === "steering") {
      return [part.message];
    }
    return part.items.map((item) => item.message);
  });
  const messageStarts = messages
    .map((message) => Date.parse(message.createdAt))
    .filter(Number.isFinite);
  const userStart = Date.parse(turnStartedAt ?? "");
  const startedAt = Number.isFinite(userStart)
    ? userStart
    : messageStarts.length > 0
      ? Math.min(...messageStarts)
      : undefined;
  if (startedAt === undefined) return { startedAt: undefined, endedAt: undefined };
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

export type TurnProcessTiming = ReturnType<typeof turnProcessTiming>;
