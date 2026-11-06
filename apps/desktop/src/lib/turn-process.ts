import type { AgentActivity, UiMessage } from "@pi-desktop/shared";
import type {
  AssistantActivityItem,
  AssistantTurnEntry,
  AssistantTurnPart,
  TranscriptEntry,
} from "./assistant-turns";
import { isStandaloneRunActivity } from "./assistant-turns";
import type { TranscriptDisplayMode } from "./transcript-display-mode";
import { isDelegationStartTool } from "./tool-display";

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

/**
 * A run call rendered as its own row beside the nested activity groups inside
 * the turn's process disclosure.
 */
export type TurnProcessRunSegment = {
  kind: "run";
  key: string;
  item: Extract<AssistantActivityItem, { kind: "tool" }>;
};

/** One chronological process chunk; ON mode splits it at run calls. */
export type TurnProcessBodySegment = {
  kind: "process";
  key: string;
  parts: AssistantTurnPart[];
};

export type TurnProcessSegment = TurnProcessRunSegment | TurnProcessBodySegment;

/** A `Task` fan-out group is its own topology, never ordinary work. */
function isDelegationGroupPart(
  part: Extract<AssistantTurnPart, { kind: "activity" }>,
): boolean {
  return part.items.some(
    (item) => item.kind === "tool" && isDelegationStartTool(item.message.toolName),
  );
}

/**
 * Coalesce the activity chunks one folded process shows.
 *
 * Turn entries isolate every run row in its own activity part, so rendering the
 * parts as built would still put a command beside the group it ran among. Folding
 * means one group around the whole contiguous ordinary stretch: build a new part
 * with the source items in order, keeping their identity, and let progress text
 * and a `Task` fan-out stay hard boundaries. The new part ends where its last
 * source part ended; the cached parts are never mutated.
 */
function coalesceProcessActivityParts(
  parts: readonly AssistantTurnPart[],
): AssistantTurnPart[] {
  const coalesced: AssistantTurnPart[] = [];
  let pending:
    | {
        delegation: boolean;
        source: Extract<AssistantTurnPart, { kind: "activity" }>;
        items: AssistantActivityItem[];
        merged: boolean;
        endedAt?: string;
      }
    | undefined;
  const flush = () => {
    if (!pending) return;
    // A group with nothing to join keeps its cached part identity, so an
    // unchanged singleton group does not remount on every preference read.
    coalesced.push(
      pending.merged
        ? {
            kind: "activity",
            items: pending.items,
            ...(pending.endedAt === undefined ? {} : { endedAt: pending.endedAt }),
          }
        : pending.source,
    );
    pending = undefined;
  };
  for (const part of parts) {
    if (part.kind === "message") {
      flush();
      coalesced.push(part);
      continue;
    }
    const delegation = isDelegationGroupPart(part);
    if (pending && pending.delegation === delegation) {
      pending.items.push(...part.items);
      pending.merged = true;
      pending.endedAt = part.endedAt;
      continue;
    }
    flush();
    pending = {
      delegation,
      source: part,
      items: [...part.items],
      merged: false,
      endedAt: part.endedAt,
    };
  }
  flush();
  return coalesced;
}

/**
 * Split one turn's process into the order it renders.
 *
 * `fully-folded` keeps the released v0.20.0 layout: contiguous activity parts
 * are coalesced into one rendered group, including Bash/run rows, and progress
 * text remains the only boundary. `flat` returns the original parts so the
 * renderer can suppress activity-group wrappers while keeping every row in
 * order. `command-first` pulls every Bash/run row out as its own segment and
 * leaves the remaining activity in chronological process chunks.
 *
 * Every mode renders one top-level disclosure. Segment parts keep their source
 * identity so reveal state and active-tail checks still work.
 */
export function segmentTurnProcess(
  parts: readonly AssistantTurnPart[],
  mode: TranscriptDisplayMode,
): TurnProcessSegment[] {
  const first = parts[0];
  if (!first) return [];
  const key =
    first.kind === "activity" ? first.items[0].message.id : first.message.id;
  if (mode === "fully-folded") {
    return [{ kind: "process", key, parts: coalesceProcessActivityParts(parts) }];
  }
  if (mode === "flat") {
    // One outer process; the flat renderer suppresses every activity-group
    // wrapper, so keep the original part order and message boundaries.
    return [{ kind: "process", key, parts: [...parts] }];
  }
  const segments: TurnProcessSegment[] = [];
  let pending: AssistantTurnPart[] = [];
  const flushProcess = () => {
    if (pending.length === 0) return;
    const first2 = pending[0];
    const key2 =
      first2.kind === "activity" ? first2.items[0].message.id : first2.message.id;
    segments.push({ kind: "process", key: key2, parts: pending });
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
 * What the turn's process header says about the turn as a whole.
 *
 * One line, and it only answers "how did this turn end up" - never what it is
 * working on, because a shell command can be arbitrarily long and would push
 * the counts off the row.
 *
 * Precedence is deliberate: failure, stop, running, unsettled, completed. A
 * recorded failure outranks everything: the turn produced no answer, and a
 * header reading "Processed" over a failed run hid that. A user stop outranks a
 * live run and completion alike - the work was interrupted, not finished - and
 * it is read from the turn's own aborted rows because the turn result only
 * distinguishes completed from failed. Both assistant message rows and activity
 * item rows count; a Stop while a tool or reasoning row is in flight settles
 * there rather than in a trailing text. Delegate child rows are deliberately
 * not scanned: a failed child is not a failed or stopped turn. An idle turn
 * whose rows never reached a terminal status is not completed either - a crash
 * or a lost host leaves its last row streaming forever, and reading that as
 * done is exactly the lie the completed fallback used to tell - so it reports
 * an unknown outcome. Rows recorded before statuses existed carry no signal
 * either way and stay completed.
 */
export type TurnProcessPhase =
  | { kind: "failed" }
  | { kind: "stopped" }
  /** Live work; `phase` names the runtime stage when one is known. */
  | { kind: "running"; phase?: AgentActivity["phase"] }
  /** Nothing is driving the turn, yet its rows never settled. */
  | { kind: "unsettled" }
  | { kind: "completed" };

export function turnProcessPhase({
  parts,
  isActive,
  failed,
  activity,
}: {
  parts: readonly AssistantTurnPart[];
  isActive: boolean;
  /** The turn recorded a failure of its own. */
  failed: boolean;
  /** Runtime phase while the turn is live, when the runtime reports one. */
  activity?: AgentActivity;
}): TurnProcessPhase {
  if (failed) return { kind: "failed" };
  // The turn result cannot say "stopped": the runtime records only completed or
  // failed, and a user stop settles as an aborted row. Reading the aborted row
  // is therefore the most precise signal available, whether it is the turn's
  // text or an activity item (a tool, thinking, or hosted search) that was in
  // flight. A denied tool is not a stop - the run continued without that call -
  // so it stays a recorded issue.
  const stopped = parts.some((part) =>
    part.kind === "message"
      ? part.message.status === "aborted"
      : part.items.some((item) => item.message.status === "aborted"),
  );
  if (stopped) return { kind: "stopped" };
  if (isActive) return { kind: "running", phase: activity?.phase };
  if (turnHasStreamingRows(parts)) return { kind: "unsettled" };
  return { kind: "completed" };
}

/** A row of the turn is still streaming, so the turn has unsettled live work. */
export function turnHasStreamingRows(
  parts: readonly AssistantTurnPart[],
): boolean {
  return parts.some((part) =>
    part.kind === "message"
      ? part.message.status === "streaming"
      : part.items.some((item) => item.message.status === "streaming"),
  );
}

/**
 * The turn a running transcript is driving, when that turn is not the tail
 * entry. Tail position alone cannot identify it: a steering message or a
 * system row may render after the live turn (#1949), while the history list
 * renders every entry as inactive. Walk back like
 * `collectLiveDelegationEntries`, with one deliberate difference: system rows
 * stay inside the run, because a system update can land during a tool call
 * and render after the turn's rows. The last assistant-turn of the current
 * run is live only while it still has streaming rows; an earlier turn left
 * streaming by a crash is outside this run's boundary and keeps
 * `turnProcessPhase`'s unsettled reading (#1923). A tail assistant-turn
 * reports its own active state, so it yields no history id. `modelSystem`
 * rows never reach this walk: `isVisibleMessage` filters them from the
 * projected entries entirely.
 */
export function liveHistoryTurnId(
  entries: readonly TranscriptEntry[],
  tailEntry?: TranscriptEntry | null,
): string | undefined {
  if (tailEntry?.kind === "assistant-turn") return undefined;
  for (let index = entries.length; index >= 0; index -= 1) {
    const entry = index === entries.length ? (tailEntry ?? undefined) : entries[index];
    if (!entry) continue;
    if (entry.kind === "assistant-turn") {
      return turnHasStreamingRows(entry.parts) ? entry.id : undefined;
    }
    if (entry.kind === "message") {
      const { message } = entry;
      // System rows arrive mid-run and stay inside it, like steering messages.
      if (message.role === "system") continue;
      if (message.role === "user" && message.steering) continue;
      break;
    }
  }
  return undefined;
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
