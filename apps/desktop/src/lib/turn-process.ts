import type { UiMessage } from "@pi-desktop/shared";
import type {
  AssistantActivityItem,
  AssistantTurnEntry,
  AssistantTurnPart,
} from "./assistant-turns";
import { isStandaloneRunActivity } from "./assistant-turns";

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

/** A `Bash`/run call rendered as its own row outside any process disclosure. */
export type TurnProcessRunSegment = {
  kind: "run";
  key: string;
  item: Extract<AssistantActivityItem, { kind: "tool" }>;
};

/** One chronological chunk of non-run process content between run calls. */
export type TurnProcessBodySegment = {
  kind: "process";
  key: string;
  parts: AssistantTurnPart[];
};

export type TurnProcessSegment = TurnProcessRunSegment | TurnProcessBodySegment;

/**
 * Split one turn's process into the order it renders (ADR
 * turn-process-and-thinking-display).
 *
 * `Bash` and run aliases are pulled out of the process flow entirely: each is
 * its own `run` segment rendered as a standalone row with no process or group
 * ancestor, and adjacent calls stay separate. The remaining tools, thinking,
 * hosted searches and progress text keep their original order and are grouped
 * into `process` chunks between the run calls. Segment parts are the same part
 * objects as the input, so downstream reveal and active-tail identity still
 * hold.
 */
export function segmentTurnProcess(
  parts: readonly AssistantTurnPart[],
): TurnProcessSegment[] {
  const segments: TurnProcessSegment[] = [];
  let pending: AssistantTurnPart[] = [];
  const flushProcess = () => {
    if (pending.length === 0) return;
    const first = pending[0];
    const key =
      first.kind === "activity" ? first.items[0].message.id : first.message.id;
    segments.push({ kind: "process", key, parts: pending });
    pending = [];
  };
  for (const part of parts) {
    if (part.kind === "activity" && part.items.length === 1) {
      const item = part.items[0];
      if (isStandaloneRunActivity(item)) {
        flushProcess();
        segments.push({ kind: "run", key: item.message.id, item });
        continue;
      }
    }
    pending.push(part);
  }
  flushProcess();
  return segments;
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

/**
 * Steps a process body renders under the thinking preference.
 *
 * `hideThinking` is `!showThinking`: completed reasoning rows and excerpts are
 * hidden, while the live reasoning indicator still counts as a visible step so
 * a thinking-only process keeps its indicator. The helper counts exactly the
 * parts it is given; Bash and run aliases are segmented out before rendering
 * and never reach a process chunk, so they are never counted here.
 */
export function visibleProcessSteps(
  parts: readonly AssistantTurnPart[],
  hideThinking: boolean,
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
        !hideThinking ||
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
