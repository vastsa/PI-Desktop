/**
 * Deterministic compaction recovery.
 *
 * Why this exists
 * ---------------
 * When the summary request fails, the runtime falls back to a carried-forward
 * summary plus a recovery notice: real history is dropped and the next window is
 * told nothing about what the work was. The failure this module was written for
 * is the evidence: 750k tokens of work replaced by a notice plus a
 * machine-generated ledger of file names, with no statement of the goal, of what
 * went wrong, or of what was left to do.
 *
 * The layer this adds is model-free, so it cannot fail on a provider and it
 * costs no request: the range is described *mechanically* — the last request
 * that was being worked on, verbatim; how much work the range holds and how much
 * of it failed; which failures were never resolved; and the open items the last
 * assistant message stated. It slots between a failed model summary and the
 * retained-tail notice.
 *
 * What this file is not
 * ---------------------
 * It does not talk to a model, read the filesystem, or know about checkpoints.
 * Everything here is a pure function of the messages it is given, which is what
 * lets the whole degradation ladder be tested without a provider stub. The
 * narrative a model would have written is the runtime's business; this is the
 * part that must be true even when no model answers.
 *
 * Duplication with the session ledger is deliberate but bounded: files,
 * commands and range totals are the ledger's job, so a trajectory summary never
 * restates them. What it adds is exactly what the ledger lacks — the goal, the
 * unresolved failures, and the next step.
 */

/** The verbatim goal is the one thing a next window cannot reconstruct. */
export const TRAJECTORY_MAX_GOAL_CHARS = 1_500;

/** Unresolved failures worth naming; past this they stop being actionable. */
export const TRAJECTORY_MAX_OPEN_ITEMS = 8;
export const TRAJECTORY_OPEN_ITEM_CHARS = 200;

/** Open items the last assistant message stated. */
export const TRAJECTORY_MAX_NEXT_STEPS = 6;

/** Carried-forward summary budget, before the range's own description. */
export const TRAJECTORY_MAX_PREVIOUS_CHARS = 4_000;

/**
 * The message fields this module reads. Structural rather than pi's message
 * union so a test can pass a literal, and so a future message role this module
 * does not understand simply contributes nothing instead of failing a cast.
 */
export type TrajectoryMessage = {
  role: string;
  content?: unknown;
  isError?: boolean;
  toolName?: string;
  toolCallId?: string;
};

export type TrajectoryStats = {
  messages: number;
  toolCalls: number;
  failedToolCalls: number;
};

export type TrajectorySummary = {
  /**
   * The real summary a chained compaction was carrying, bounded. The runtime
   * places it ahead of its recovery marker, so `stripCompactionFallbackNotice`
   * recovers exactly this text for the next attempt — the sections below
   * describe *this* range and must not be carried as if they were history.
   */
  carried: string | undefined;
  /** The mechanical description of this range; the runtime places it after the marker. */
  sections: string;
  /** `carried` + `sections`, for a reader that has no marker to place. */
  summary: string;
  stats: TrajectoryStats;
  /** Named for the checkpoint's diagnostics; undefined when nothing recorded it. */
  goal: string | undefined;
  openItems: string[];
  nextSteps: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text of every text block, in order. A string content is its own text. */
function messageText(message: TrajectoryMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function firstLine(text: string, maxChars: number): string {
  const line = text
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (!line) return "";
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

function pathArgument(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file_path", "filePath"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Tool-call blocks of one assistant message, with the arguments we can read. */
function toolCallsOf(
  message: TrajectoryMessage,
): Array<{ id: string | undefined; name: string; path: string | undefined }> {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const calls: Array<{
    id: string | undefined;
    name: string;
    path: string | undefined;
  }> = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "toolCall") continue;
    const name = typeof block.name === "string" ? block.name : "";
    if (!name) continue;
    const args = isRecord(block.arguments) ? block.arguments : {};
    calls.push({
      id: typeof block.id === "string" ? block.id : undefined,
      name,
      path: pathArgument(args),
    });
  }
  return calls;
}

/**
 * The last request the range was working on, verbatim.
 *
 * Verbatim matters: Roo Code's prompt asks a summarizer for the same thing
 * because a paraphrase is what lets a next window redo work whose wording it
 * cannot tell apart from a different request.
 */
export function extractGoal(
  messages: readonly TrajectoryMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = messageText(message).trim();
    if (text.length === 0) continue;
    return text.length > TRAJECTORY_MAX_GOAL_CHARS
      ? `${text.slice(0, TRAJECTORY_MAX_GOAL_CHARS)}…`
      : text;
  }
  return undefined;
}

/**
 * Failures in the range that nothing later repaired.
 *
 * "Unresolved" is the useful half: a test run that failed and was fixed by the
 * next edit is not something a next window should act on, and listing it would
 * teach the reader to skim this section. A failure whose replacement edit came
 * later in the same range is therefore dropped; everything else — including a
 * failure this module cannot attribute to a path — is kept, because an
 * unexplained failure is exactly what a next window needs to know about.
 *
 * Two attribution rules keep that from hiding a real failure:
 *
 *   - A call id is **not** unique across a range — OpenAI-compatible local
 *     servers emit `1`, `2`, … per response — so a result is matched to the
 *     nearest *preceding* call with that id, never to a later one.
 *   - A repair counts only when its own result came back without an error. A
 *     `Write` that failed repaired nothing, and a call that never returned is
 *     not evidence either, so neither suppresses an item.
 */
export function extractOpenItems(
  messages: readonly TrajectoryMessage[],
): string[] {
  const calls = new Map<
    string,
    Array<{ index: number; name: string; path: string | undefined }>
  >();
  const resultIds = new Set<string>();
  const failedIds = new Set<string>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "assistant") {
      for (const call of toolCallsOf(message)) {
        if (!call.id) continue;
        const list = calls.get(call.id) ?? [];
        list.push({ index, name: call.name, path: call.path });
        calls.set(call.id, list);
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    if (typeof message.toolCallId !== "string") continue;
    resultIds.add(message.toolCallId);
    if (message.isError === true) failedIds.add(message.toolCallId);
  }

  /** The call a result belongs to: the last one with that id before it. */
  const callBefore = (id: string, index: number) => {
    const list = calls.get(id);
    if (!list) return undefined;
    for (let position = list.length - 1; position >= 0; position--) {
      const call = list[position];
      if (call && call.index < index) return call;
    }
    return undefined;
  };
  const repaired = (id: string | undefined, index: number): boolean => {
    if (!id || !resultIds.has(id) || failedIds.has(id)) return false;
    const call = callBefore(id, index);
    return call?.index !== undefined;
  };

  // Paths an edit actually landed on, so a failure for that path is resolved.
  const lastRepair = new Map<string, number>();
  for (const [id, list] of calls) {
    if (!repaired(id, Number.POSITIVE_INFINITY)) continue;
    const call = list[list.length - 1];
    if (!call?.path) continue;
    if (call.name !== "Write" && call.name !== "Edit" && call.name !== "MultiEdit") {
      continue;
    }
    lastRepair.set(call.path, call.index);
  }

  const items: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || message.role !== "toolResult" || message.isError !== true) {
      continue;
    }
    const call =
      typeof message.toolCallId === "string"
        ? callBefore(message.toolCallId, index)
        : undefined;
    if (call?.path) {
      const repair = lastRepair.get(call.path);
      if (repair !== undefined && repair > index) continue;
    }
    const name =
      call?.name ||
      (typeof message.toolName === "string" ? message.toolName : "tool");
    const detail = firstLine(messageText(message), TRAJECTORY_OPEN_ITEM_CHARS);
    const item = detail ? `${name}: ${detail}` : name;
    if (seen.has(item)) continue;
    seen.add(item);
    items.push(item);
    if (items.length >= TRAJECTORY_MAX_OPEN_ITEMS) break;
  }
  return items;
}


/**
 * Open items the last assistant message stated.
 *
 * Only markers that cannot appear by accident are read — an unchecked checkbox
 * and a literal `TODO`. A looser rule (any line under a "next steps" heading)
 * would turn prose into a task list the model never committed to, and the
 * sections above already carry the goal verbatim.
 */
export function extractNextSteps(
  messages: readonly TrajectoryMessage[],
): string[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = messageText(message);
    if (text.trim().length === 0) continue;
    const steps: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const checkbox = rawLine.match(/^\s*[-*]\s*\[\s*\]\s*(.+)$/);
      const todo = rawLine.match(/^\s*(?:[-*]\s*)?TODO\b[:\s]*(.*)$/i);
      const value = (checkbox?.[1] ?? todo?.[1] ?? "").trim();
      if (!value) continue;
      steps.push(
        value.length > TRAJECTORY_OPEN_ITEM_CHARS
          ? `${value.slice(0, TRAJECTORY_OPEN_ITEM_CHARS)}…`
          : value,
      );
      if (steps.length >= TRAJECTORY_MAX_NEXT_STEPS) break;
    }
    return steps;
  }
  return [];
}

const TRAJECTORY_GOAL_EMPTY = "(no user request was recorded in this range)";
const TRAJECTORY_BLOCKED_EMPTY = "(none recorded)";
const TRAJECTORY_NEXT_EMPTY = "(no open next step was recorded)";

/**
 * The mechanical replacement for a model summary.
 *
 * The section headings are the ones the A check enforces, on purpose: a
 * trajectory checkpoint is then structurally a summary, so the next
 * summarization request can carry it forward and every reader — human or model —
 * sees the same shape regardless of which layer produced it.
 *
 * `previousSummary` is placed ahead of the caller's marker, exactly like the
 * retained-tail fallback does, so `stripCompactionFallbackNotice` can recover
 * the real carried-forward history on a chained compaction and this module's
 * description of the *previous* range is dropped rather than cemented.
 */
export function buildTrajectorySummary(input: {
  messages: readonly TrajectoryMessage[];
  previousSummary?: string;
  /** Bound for the carried-forward text; the sections bound themselves. */
  maxPreviousChars?: number;
}): TrajectorySummary {
  const messages = input.messages;
  const stats: TrajectoryStats = {
    messages: messages.length,
    toolCalls: 0,
    failedToolCalls: 0,
  };
  for (const message of messages) {
    if (message.role === "assistant") {
      stats.toolCalls += toolCallsOf(message).length;
    } else if (message.role === "toolResult" && message.isError === true) {
      stats.failedToolCalls += 1;
    }
  }

  const goal = extractGoal(messages);
  const openItems = extractOpenItems(messages);
  const nextSteps = extractNextSteps(messages);
  const previousBudget = input.maxPreviousChars ?? TRAJECTORY_MAX_PREVIOUS_CHARS;
  const previous =
    typeof input.previousSummary === "string" && input.previousSummary.trim().length > 0
      ? input.previousSummary.trim().length > previousBudget
        ? `${input.previousSummary.trim().slice(0, previousBudget)}…`
        : input.previousSummary.trim()
      : undefined;

  const sections = [
    "## Goal",
    goal ?? TRAJECTORY_GOAL_EMPTY,
    "",
    "## Progress",
    `${stats.messages} messages and ${stats.toolCalls} tool calls were summarized without a model pass; ${stats.failedToolCalls} tool call(s) in the range failed. Files, commands and totals for this range are listed in the session ledger below.`,
    "",
    "## Blocked",
    openItems.length > 0
      ? openItems.map((item) => `- ${item}`).join("\n")
      : TRAJECTORY_BLOCKED_EMPTY,
    "",
    "## Next Steps",
    nextSteps.length > 0
      ? nextSteps.map((item) => `- ${item}`).join("\n")
      : TRAJECTORY_NEXT_EMPTY,
  ].join("\n");

  return {
    carried: previous,
    sections,
    summary: previous ? `${previous}\n\n${sections}` : sections,
    stats,
    goal,
    openItems,
    nextSteps,
  };
}
