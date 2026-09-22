/**
 * Tool-result tiering for the outgoing view.
 *
 * Tool results are most of the context mass. Under pressure an old tool result
 * is the cheapest thing to shorten: its text is not lost — a file-backed result
 * can be read again, and a spilled shell result is still on disk — so shortening
 * it removes low-density weight without creating a gap the reader cannot close.
 * Paying for a lossy summary pass to recover the same room is the expensive
 * alternative.
 *
 * This complements the per-result budgets in
 * `docs/spec/03-runtime/16-tool-result-limits.md` rather than replacing them.
 * Those bound **one** result when it is produced (Read 128 KB, shell 96 KB, plus
 * spill files); this pass bounds the **aggregate** an outgoing request carries,
 * which several individually-legal results can still exceed. A 128 KB Read
 * window narrowed to a head plus a pointer is exactly the mass that matters
 * here.
 *
 * The pass is deliberately narrow:
 *
 * - **Only tool results.** User messages, assistant prose and the compaction
 *   summary are never touched: they are synthesis or intent, and there is no
 *   way to fetch them again.
 * - **Only the outgoing view.** Callers pass the message list a provider request
 *   is about to send; stored messages are never modified, and the projection is
 *   rebuilt for every request, so a later request with room renders the full
 *   text again.
 * - **Deterministic.** Fixed size and count thresholds. No model call, no
 *   scoring, no per-session state. Every decision reads only the batch handed in.
 * - **A recovery path or nothing.** A result is narrowed only when this module
 *   can name a real way to get the rest back, and the pointer names it exactly:
 *   a file-backed `Read` result points at the next line of that file, and a
 *   shell result whose output was spilled points at the spill file. Anything
 *   else — a `Grep`, a `Glob`, a shell result that was not spilled — is left
 *   whole, because a pointer the reader cannot act on is worse than a long
 *   result. That is also why `Grep`/`Glob` are not narrowed: re-running them is
 *   not guaranteed to return the same lines, so the pointer would not be exact.
 * - **A no-op by default.** The caller decides when to run it (see
 *   `TOOL_RESULT_TIER_PRESSURE`); when nothing qualifies, or when the saving is
 *   below the floor, the same array comes back.
 *
 * Four precision knobs narrow the pass further. Each defaults to the documented
 * value:
 *
 * - `keepMarkers` — a result whose text contains any marker is never shortened,
 *   so a user-pasted error or a result the model flagged to keep stays whole.
 *   Matched with a **case-insensitive plain substring**, never a regex: result
 *   text is user content and its metacharacters must not be interpreted.
 * - `excludeTools` — results of these tools are never shortened. Subagent
 *   reports and retrieval hits are the most expensive information in the window;
 *   shortening them throws away what was just fetched. Matched by **exact,
 *   case-sensitive tool name**.
 * - `workingSetPaths` — a result whose tool call named one of these files stays
 *   whole: a file the session is still working in is still in play. The
 *   `toolCallId → path` map is built from the `toolCall` blocks of the **same
 *   batch**, never from stored messages. Paths compare after normalizing
 *   trailing slashes, path separators and the Windows drive-letter case — no
 *   `realpath`, no filesystem access.
 * - `clearAtLeastChars` — the pass is a no-op unless its summed saving reaches
 *   this floor. Rewriting the outgoing view for a few hundred characters is a
 *   bad trade: it breaks the provider's prompt cache for everything after the
 *   rewrite.
 *
/**
 * Fraction of the hard context limit at which the caller should start tiering.
 * Below the compaction threshold on purpose: the point is to drop back under it
 * with cheap, recoverable evidence instead of paying for a lossy summary pass.
 */
export const TOOL_RESULT_TIER_PRESSURE = 0.6;

/** Results at or below this size are not worth a pointer. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Results at or below this size are not worth a pointer. */
export const TOOL_RESULT_TIER_MIN_CHARS = 4_000;

/** How much of a narrowed result stays inline. */
export const TOOL_RESULT_TIER_HEAD_CHARS = 1_200;

/** The newest results are almost certainly still in play; leave them whole. */
export const TOOL_RESULT_TIER_KEEP_RECENT = 6;

/** A result whose text contains any of these markers is never narrowed. */
export const TOOL_RESULT_TIER_KEEP_MARKERS = ["[keep]"];

/** Results of these tools are never narrowed: they are the expensive parts. */
export const TOOL_RESULT_TIER_EXCLUDE_TOOLS = [
  "Task",
  "TaskWait",
  "TaskList",
  "TaskStop",
  "ToolSearch",
];

/**
 * The pass is a no-op unless it saves at least this many characters — a small
 * rewrite is not worth breaking the provider's prompt cache.
 */
export const TOOL_RESULT_TIER_CLEAR_AT_LEAST_CHARS = 8_000;

export type ToolResultTierOptions = {
  minChars?: number;
  headChars?: number;
  keepRecent?: number;
  /** Markers that immunize a result from narrowing (case-insensitive). */
  keepMarkers?: string[];
  /** Tool names whose results are never narrowed. */
  excludeTools?: string[];
  /** File paths whose tool results stay whole. Empty or absent means none. */
  workingSetPaths?: string[];
  /** Minimum summed saving for the pass to apply at all. */
  clearAtLeastChars?: number;
};

export type ToolResultTierResult = {
  messages: AgentMessage[];
  /** How many results were shortened (0 means the same array came back). */
  narrowed: number;
  /** Characters this pass removed, pointer text included; 0 when it no-opped. */
  savedChars: number;
};

type TextBlock = { type?: unknown; text?: unknown };

type ToolResultRecord = {
  role: string;
  content: unknown;
  addedToolNames?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
};

/** Characters of text across a message's text blocks. */
function textChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content as TextBlock[]) {
    if (block && typeof block === "object" && typeof block.text === "string") {
      total += block.text.length;
    }
  }
  return total;
}

/** The single text payload of a result, when it has exactly one. */
function singleText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = (content as TextBlock[])
    .filter((block) => block && typeof block.text === "string")
    .map((block) => block.text as string);
  return texts.length === 1 ? texts[0] : undefined;
}

/**
 * The last file line number a `Read` window shows.
 *
 * The payload is `[path#tag]` followed by `N: line` rows whose `N` is the
 * file's own line number, so the last one is where a continuation starts. Rows
 * are scanned from the end because a file line may itself begin with digits and
 * a colon; only the rendered prefix counts.
 */
export function lastReadLine(head: string): number | undefined {
  const lines = head.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^\s*(\d+):/.exec(lines[index] ?? "");
    if (match) return Number(match[1]);
  }
  return undefined;
}

/** The spill file a shell result's truncation marker named, when it did. */
export function spillPath(content: string): string | undefined {
  // The sentence is host-core's (`tools/mod.rs`): "Full output saved to <path>
  // — Grep it, or Read it with offset/limit." The dash and the trailing clause
  // are matched loosely so a rewrite of the wording is not a silent failure.
  const match = /Full output saved to ([^\n]+?)\s+(?:—|–|--)\s+Grep it/.exec(
    content,
  );
  const path = match?.[1]?.trim();
  return path && path.length > 0 ? path : undefined;
}

/** A pointer to text that can still be fetched, or `undefined` when it cannot. */
export type RecoveryPointer = {
  /** The exact call that reads the rest. */
  pointer: string;
  /** Set when the pointer is a line offset into `path` (a `Read` result). */
  path?: string;
  offset?: number;
};

/**
 * The recovery path for one result, or `undefined` to leave it whole.
 *
 * `path` is the file its tool call named, when the call named one.
 */
export function toolResultRecovery(input: {
  toolName: string | undefined;
  content: string;
  head: string;
  totalChars: number;
  path: string | undefined;
}): RecoveryPointer | undefined {
  const shown = input.head.length;
  if (input.toolName === "Read" && input.path) {
    const line = lastReadLine(input.head);
    if (line === undefined) return undefined;
    return {
      path: input.path,
      offset: line + 1,
      pointer:
        `[tool result narrowed: kept the first ${shown} of ${input.totalChars} characters, through line ${line}. ` +
        `Continue with Read path="${input.path}" offset=${line + 1}.]`,
    };
  }
  const spill = spillPath(input.content);
  if (spill) {
    return {
      pointer:
        `[tool result narrowed: kept the first ${shown} of ${input.totalChars} characters. ` +
        `The full captured output is at ${spill} — Read it with offset/limit, or Grep it.]`,
    };
  }
  return undefined;
}

/**
 * Narrow a result whose text is one string or one text block: keep its head and
 * append the pointer once, at its end. A result whose text spans more than one
 * block is not eligible: a continuation offset cannot be an honest pointer when
 * the kept head is only part of the payload.
 */
function narrowContent(
  content: unknown,
  headChars: number,
  pointer: string,
): { content: unknown; changed: boolean } {
  if (typeof content === "string") {
    if (content.length <= headChars) return { content, changed: false };
    return {
      content: `${content.slice(0, headChars)}${pointer}`,
      changed: true,
    };
  }
  if (!Array.isArray(content)) return { content, changed: false };
  const blocks = content as Array<Record<string, unknown>>;
  const textIndexes = blocks
    .map((block, index) => (block && typeof block.text === "string" ? index : -1))
    .filter((index) => index >= 0);
  if (textIndexes.length !== 1) return { content, changed: false };
  const textIndex = textIndexes[0];
  let changed = false;
  const next = blocks.map((block, index) => {
    if (typeof block.text !== "string" || index !== textIndex) return block;
    if (block.text.length <= headChars) return block;
    changed = true;
    return { ...block, text: `${block.text.slice(0, headChars)}${pointer}` };
  });
  return changed ? { content: next, changed: true } : { content, changed: false };
}

/** Argument spellings a tool call may name a file by, in precedence order. */
const FILE_PATH_ARG_KEYS = ["file_path", "path", "filePath"] as const;

/**
 * Normalize a path for set comparison: forward slashes, no trailing slash,
 * upper-case Windows drive letter. Deliberately no `realpath` — no filesystem
 * access, and the same input always compares the same way.
 */
function normalizePath(path: string): string {
  let normalized = path.trim().replace(/\\/g, "/");
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.replace(
    /^([A-Za-z]):\//,
    (_match, drive: string) => `${drive.toUpperCase()}:/`,
  );
}

/** The first file path a tool call's argument object names, if any. */
function pathFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of FILE_PATH_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * `toolCallId` → path, read from the `toolCall` blocks of this same batch.
 * Nothing here is persisted; the map exists for this pass only.
 */
function toolCallPaths(messages: AgentMessage[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const message of messages) {
    const record = message as unknown as { role?: unknown; content?: unknown };
    if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
    for (const block of record.content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== "object" || block.type !== "toolCall") {
        continue;
      }
      const id =
        typeof block.id === "string"
          ? block.id
          : typeof block.toolCallId === "string"
            ? block.toolCallId
            : undefined;
      if (!id) continue;
      // `args` is the spelling callers pass; `arguments` is what stored
      // assistant messages use. Both name the same object.
      const path = pathFromArgs(block.args ?? block.arguments);
      if (path !== undefined) paths.set(id, normalizePath(path));
    }
  }
  return paths;
}

/**
 * How many of the newest file-touching tool calls define the working set.
 *
 * Eight, not the newest twenty: the pass already keeps the newest
 * `KEEP_RECENT` results whole, so a wide working set mostly re-protects the same
 * rows while making the pressure pass a no-op on small windows.
 */
export const TOOL_RESULT_TIER_WORKING_SET_TOOL_CALLS = 8;

/**
 * The working set the caller passes as `workingSetPaths`: the paths named by the
 * newest `lastToolCalls` file-touching tool calls, newest call's path last.
 *
 * This pass keeps the newest N *results* whole, but that is a count, not a
 * notion of "what the task is about right now". A result for a file the session
 * has just re-opened is still in play even when its row is old.
 */
export function workingSetPathsFrom(
  messages: AgentMessage[],
  options: { lastToolCalls?: number } = {},
): string[] {
  const limit = Math.max(
    0,
    Math.floor(options.lastToolCalls ?? TOOL_RESULT_TIER_WORKING_SET_TOOL_CALLS),
  );
  if (limit === 0) return [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  // Walk backwards: the newest calls decide the set, and a path already taken
  // keeps its newest position (an older row must not move it).
  for (
    let index = messages.length - 1;
    index >= 0 && seen.size < limit;
    index -= 1
  ) {
    const record = messages[index] as unknown as {
      role?: unknown;
      content?: unknown;
    };
    if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
    const content = record.content as Array<Record<string, unknown>>;
    for (
      let block = content.length - 1;
      block >= 0 && seen.size < limit;
      block -= 1
    ) {
      const candidate = content[block];
      if (
        !candidate ||
        typeof candidate !== "object" ||
        candidate.type !== "toolCall"
      ) {
        continue;
      }
      const path = pathFromArgs(candidate.args ?? candidate.arguments);
      if (path === undefined) continue;
      const normalized = normalizePath(path);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      ordered.push(normalized);
    }
  }
  return ordered.reverse();
}

/**
 * Whether any text in the content contains one of the (already lower-cased)
 * markers, as a plain substring. No regex: result text is user content.
 */
function containsMarker(content: unknown, markers: string[]): boolean {
  if (markers.length === 0) return false;
  const texts: string[] = [];
  const single = singleText(content);
  if (single !== undefined) {
    texts.push(single);
  } else if (Array.isArray(content)) {
    for (const block of content as TextBlock[]) {
      if (block && typeof block === "object" && typeof block.text === "string") {
        texts.push(block.text);
      }
    }
  }
  return texts.some((text) => {
    const haystack = text.toLowerCase();
    return markers.some((marker) => haystack.includes(marker));
  });
}

/**
 * Shorten old tool results in an outgoing view, naming the recovery path for
 * each one. A result whose recovery path this module cannot name is skipped,
 * because a pointer the reader cannot act on is worse than a long result.
 *
 * Returns the same array when nothing changed.
 */
export function narrowToolResults(
  messages: AgentMessage[],
  options: ToolResultTierOptions = {},
): ToolResultTierResult {
  const minChars = options.minChars ?? TOOL_RESULT_TIER_MIN_CHARS;
  const headChars = options.headChars ?? TOOL_RESULT_TIER_HEAD_CHARS;
  const keepRecent = options.keepRecent ?? TOOL_RESULT_TIER_KEEP_RECENT;
  const keepMarkers = (options.keepMarkers ?? TOOL_RESULT_TIER_KEEP_MARKERS)
    .filter((marker) => marker.length > 0)
    .map((marker) => marker.toLowerCase());
  const excludeTools = new Set(
    options.excludeTools ?? TOOL_RESULT_TIER_EXCLUDE_TOOLS,
  );
  const clearAtLeastChars =
    options.clearAtLeastChars ?? TOOL_RESULT_TIER_CLEAR_AT_LEAST_CHARS;
  // The working set and the paths it is matched against both come from this
  // batch alone; an unknown result is outside the set, never guessed at.
  const workingSet =
    options.workingSetPaths && options.workingSetPaths.length > 0
      ? new Set(options.workingSetPaths.map(normalizePath))
      : undefined;
  const toolPaths = toolCallPaths(messages);

  // Which tool results are "recent" is decided over the whole list first, so
  // the set does not depend on how many were narrowed.
  const toolIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if ((messages[index] as { role?: unknown }).role === "toolResult") {
      toolIndexes.push(index);
    }
  }
  if (toolIndexes.length === 0) return { messages, narrowed: 0, savedChars: 0 };
  const protectedIndexes = new Set(toolIndexes.slice(-keepRecent));

  let narrowed = 0;
  let savedChars = 0;
  const next = messages.map((message, index) => {
    if (!toolIndexes.includes(index) || protectedIndexes.has(index)) {
      return message;
    }
    const record = message as unknown as ToolResultRecord;
    // Tool-search activation evidence lives on the result; shortening it would
    // change what a later request may restore.
    if (Array.isArray(record.addedToolNames) && record.addedToolNames.length > 0) {
      return message;
    }
    // Subagent reports and retrieval hits are the least replaceable evidence.
    if (typeof record.toolName === "string" && excludeTools.has(record.toolName)) {
      return message;
    }
    // A file the session is still working in is still in play.
    const callPath =
      typeof record.toolCallId === "string"
        ? toolPaths.get(record.toolCallId)
        : undefined;
    if (workingSet && callPath !== undefined && workingSet.has(callPath)) {
      return message;
    }
    const totalChars = textChars(record.content);
    if (totalChars <= minChars) return message;
    // A user-pasted error or an explicitly preserved result stays byte whole.
    if (containsMarker(record.content, keepMarkers)) return message;
    const text = singleText(record.content);
    if (text === undefined) return message;
    const recovery = toolResultRecovery({
      toolName: typeof record.toolName === "string" ? record.toolName : undefined,
      content: text,
      head: text.slice(0, headChars),
      totalChars,
      path: callPath,
    });
    if (!recovery) return message;
    const narrowedContent = narrowContent(
      record.content,
      headChars,
      recovery.pointer,
    );
    if (!narrowedContent.changed) return message;
    narrowed += 1;
    savedChars += totalChars - textChars(narrowedContent.content);
    return { ...record, content: narrowedContent.content } as unknown as AgentMessage;
  });

  if (narrowed === 0) return { messages, narrowed: 0, savedChars: 0 };
  // A rewrite costs the provider's prompt cache for every message after it;
  // below the floor the trade is not worth taking, so the view stays as it was.
  if (savedChars < clearAtLeastChars) {
    return { messages, narrowed: 0, savedChars: 0 };
  }
  return { messages: next, narrowed, savedChars };
}
