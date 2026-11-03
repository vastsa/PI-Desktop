/**
 * Entry-list memory semantics, ported from Hermes (`tools/memory_tool_store.py`).
 *
 * A memory store is a flat list of entries joined by {@link ENTRY_DELIMITER}.
 * Two targets exist: `memory` (the agent's own notes) and `user` (who the user
 * is). Both are rendered into the system prompt, so the whole design optimises
 * for a document a model can read cheaply and edit surgically.
 *
 * Everything here is pure: entries in, entries out. No IO, no clock, no config.
 * The caller owns persistence, locking and drift detection.
 *
 * Why four operations instead of one "write":
 * - `add` appends. It is idempotent so a model that retries does not duplicate.
 * - `replace` swaps a WHOLE entry. `old_text` only locates it — the matched span
 *   is never spliced, which is what makes it unambiguous.
 * - `patch` edits ONE span inside an entry and keeps the rest verbatim. Without
 *   it a model that wants to fix one word has to re-emit the whole entry, and
 *   re-emission is where content silently disappears.
 * - `remove` deletes a whole entry, because deleting a span would drop the
 *   sibling facts stored beside it.
 */

/** Separates entries. A model copying an entry never reproduces this by accident. */
export const ENTRY_DELIMITER = "\n§\n";

/** Whole-store character budgets. Small on purpose: the store enters every prompt. */
export const MEMORY_CHAR_LIMIT = 2200;
export const USER_CHAR_LIMIT = 1375;

export type MemoryTarget = "memory" | "user";

/** Block header per target, used when rendering the store into a prompt. */
export const MEMORY_BLOCK_HEADERS: Record<MemoryTarget, string> = {
  memory: "MEMORY (your personal notes)",
  user: "USER PROFILE (who the user is)",
};

export type MemoryFailureClass =
  | "none"
  | "missing_content"
  | "missing_old_text"
  | "no_match"
  | "ambiguous"
  | "over_budget"
  | "invalid_args";

export type MemorySuccess = {
  success: true;
  /** What to tell the model. Short and factual; it is shown verbatim. */
  message: string;
  entries: string[];
  /** Entry the operation displaced, so the model can undo or re-add it. */
  previousEntry?: string;
  /** Entry a patch produced, for the model's own confirmation. */
  patchedEntry?: string;
};

export type MemoryFailure = {
  success: false;
  error: string;
  failureClass: MemoryFailureClass;
  /**
   * The entries that share the most words with a failed `old_text`. A model that
   * paraphrased or half-remembered an entry recovers from this; without it the
   * only recovery is guessing.
   */
  closestEntries?: string[];
  /** Entries in the store after the attempt, so an over-budget model can prune. */
  currentEntries?: string[];
};

export type MemoryResult = MemorySuccess | MemoryFailure;

export type MemoryOperation =
  | { action: "add"; content: string }
  | { action: "replace"; old_text: string; content: string }
  | { action: "patch"; old_text: string; content: string }
  | { action: "remove"; old_text: string };

function charLimitFor(target: MemoryTarget): number {
  return target === "user" ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
}

/** Parse a stored document into entries. Blank entries never survive. */
export function parseMemoryEntries(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Render entries back to the stored form. */
export function serializeMemoryEntries(entries: readonly string[]): string {
  return entries.join(ENTRY_DELIMITER);
}

/** Total characters the store occupies, measured the way the limit is measured. */
export function memoryCharCount(entries: readonly string[]): number {
  return serializeMemoryEntries(entries).length;
}

/**
 * Quote/dash/whitespace-folded form used for tolerant `old_text` matching.
 *
 * A model re-emits an entry with straight quotes for curly ones, `-` for an em
 * dash, lines re-wrapped at different widths, or a newline over-escaped to a
 * literal backslash-n. A byte-exact substring test then reports "no entry
 * matched" for a target that is unambiguous to a human reader.
 */
export function normalizeForMemoryMatch(text: string): string {
  return String(text)
    .replace(/\\n/g, " ")
    .replace(/["`\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f]/g, "'")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

/** Indices of entries containing `oldText`: byte-exact first, else folded. */
function substringMatches(entries: readonly string[], oldText: string): number[] {
  const exact: number[] = [];
  entries.forEach((entry, index) => {
    if (entry.includes(oldText)) exact.push(index);
  });
  if (exact.length > 0) return exact;
  const needle = normalizeForMemoryMatch(oldText);
  // Punctuation or whitespace alone would fold to nothing and match everything.
  if (!/[\p{L}\p{N}]/u.test(needle)) return [];
  const matches: number[] = [];
  entries.forEach((entry, index) => {
    if (normalizeForMemoryMatch(entry).includes(needle)) matches.push(index);
  });
  return matches;
}

/**
 * `{ index, ambiguous }` for the entry `oldText` selects.
 *
 * A whole-entry EXACT match takes absolute priority over substring matches, so a
 * short entry stays addressable even when its full text is contained inside a
 * longer sibling (`remove('test')` must not become ambiguous because another
 * entry says "tests pass"). Two DISTINCT matches are ambiguous: editing the
 * wrong one is silent data loss, so the model is asked to be more specific.
 */
export function findUniqueMemoryMatch(
  entries: readonly string[],
  oldText: string,
): { index: number | null; ambiguous: boolean } {
  const exact: number[] = [];
  entries.forEach((entry, index) => {
    if (entry === oldText) exact.push(index);
  });
  const matches = exact.length > 0 ? exact : substringMatches(entries, oldText);
  const distinct = new Set(matches.map((index) => entries[index]));
  if (distinct.size > 1) return { index: null, ambiguous: true };
  return { index: matches.length > 0 ? matches[0] : null, ambiguous: false };
}

function words(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).map((word) => word),
  );
}

/**
 * Zero-match error that names the fix rather than only the failure: the entries
 * sharing the most words with `oldText`, since a paraphrased `old_text` still
 * shares most of them.
 */
function noMatchFailure(
  entries: readonly string[],
  oldText: string,
  verb: string,
): MemoryFailure {
  const wanted = words(oldText);
  const scored: { score: number; index: number }[] = [];
  if (wanted.size > 0) {
    entries.forEach((entry, index) => {
      const found = words(entry);
      let shared = 0;
      for (const word of wanted) if (found.has(word)) shared += 1;
      scored.push({ score: shared / wanted.size, index });
    });
  }
  scored.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score));
  const closest = scored
    .filter((item) => item.score >= 0.3)
    .slice(0, 3)
    .map((item) => entries[item.index]);
  const hint = oldText.includes("§")
    ? " old_text must come from ONE entry ('§' separates entries); use one op per entry."
    : "";
  return {
    success: false,
    error:
      `No entry matched '${oldText}'.${hint} Retry the ${verb} with old_text copied verbatim ` +
      `from the intended entry` +
      (closest.length > 0 ? " (closest_entries below)." : "."),
    failureClass: "no_match",
    ...(closest.length > 0 ? { closestEntries: closest } : {}),
  };
}

function overBudgetFailure(
  entries: readonly string[],
  total: number,
  limit: number,
): MemoryFailure {
  return {
    success: false,
    error:
      `Would put memory at ${total}/${limit} chars: free at least ${total - limit} chars. ` +
      "Shorten the new text, or 'remove' other stale or less important entries to make " +
      "room (see current_entries below), then retry — all in this turn.",
    failureClass: "over_budget",
    currentEntries: [...entries],
  };
}

function ambiguousFailure(entries: readonly string[], oldText: string): MemoryFailure {
  const matches = substringMatches(entries, oldText).map((index) =>
    entries[index].length > 80 ? `${entries[index].slice(0, 80)}...` : entries[index],
  );
  return {
    success: false,
    error: `Multiple entries matched '${oldText}'. Be more specific.`,
    failureClass: "ambiguous",
    ...(matches.length > 0 ? { closestEntries: matches } : {}),
  };
}

function resolveIndex(
  entries: readonly string[],
  oldText: string,
  verb: string,
): { index: number } | MemoryFailure {
  const match = findUniqueMemoryMatch(entries, oldText);
  if (match.ambiguous) return ambiguousFailure(entries, oldText);
  if (match.index === null) return noMatchFailure(entries, oldText, verb);
  return { index: match.index };
}

/**
 * Replace the single `oldText` span inside `entry`, keeping the rest verbatim.
 *
 * A span occurring more than once is refused: `patch` edits one span, and
 * picking which occurrence to edit is a guess the model cannot see.
 */
function patchEntry(
  entry: string,
  oldText: string,
  newText: string,
): { patched: string } | MemoryFailure {
  const first = entry.indexOf(oldText);
  if (first < 0) {
    return {
      success: false,
      error: `'${oldText}' is not in the matched entry. Retry the patch with old_text copied verbatim from it.`,
      failureClass: "no_match",
    };
  }
  if (entry.indexOf(oldText, first + oldText.length) >= 0) {
    const count = entry.split(oldText).length - 1;
    return {
      success: false,
      error:
        `'${oldText}' appears ${count} times in the matched entry, and patch edits one span. ` +
        "Include more surrounding text so old_text occurs once.",
      failureClass: "ambiguous",
    };
  }
  return {
    patched: entry.slice(0, first) + newText + entry.slice(first + oldText.length),
  };
}

/**
 * Apply one operation to `entries`, returning the new list or a failure.
 *
 * Pure: the caller decides whether to persist the result. `target` only selects
 * the character budget, so a caller can preview against the real limit.
 */
export function applyMemoryOperation(
  target: MemoryTarget,
  entries: readonly string[],
  operation: MemoryOperation,
): MemoryResult {
  const limit = charLimitFor(target);
  switch (operation.action) {
    case "add": {
      const content = operation.content.trim();
      if (!content) {
        return { success: false, error: "Content cannot be empty.", failureClass: "missing_content" };
      }
      if (entries.includes(content)) {
        // Idempotent on purpose: a retried tool call must not duplicate an entry.
        return {
          success: true,
          message: "Entry already exists (no duplicate added).",
          entries: [...entries],
        };
      }
      const next = [...entries, content];
      const total = memoryCharCount(next);
      if (total > limit) return overBudgetFailure(entries, total, limit);
      return { success: true, message: "Entry added.", entries: next };
    }
    case "replace": {
      const content = operation.content.trim();
      const oldText = operation.old_text.trim();
      if (!oldText) {
        return { success: false, error: "old_text cannot be empty.", failureClass: "missing_old_text" };
      }
      if (!content) {
        return {
          success: false,
          error: "new_content cannot be empty. Use 'remove' to delete entries.",
          failureClass: "missing_content",
        };
      }
      const located = resolveIndex(entries, oldText, "replace");
      if ("success" in located) return located;
      const previousEntry = entries[located.index];
      const next = [...entries];
      next[located.index] = content;
      const total = memoryCharCount(next);
      if (total > limit) return overBudgetFailure(entries, total, limit);
      return { success: true, message: "Entry replaced.", entries: next, previousEntry };
    }
    case "patch": {
      const oldText = operation.old_text.trim();
      const content = operation.content;
      if (!oldText) {
        return { success: false, error: "old_text cannot be empty.", failureClass: "missing_old_text" };
      }
      if (!content.trim()) {
        return {
          success: false,
          error:
            "new_text cannot be empty. To drop text inside an entry, patch a longer span " +
            "that contains it; 'remove' deletes the whole entry.",
          failureClass: "missing_content",
        };
      }
      const located = resolveIndex(entries, oldText, "patch");
      if ("success" in located) return located;
      const previousEntry = entries[located.index];
      // The span keeps its whitespace: it is part of the text being replaced.
      const patched = patchEntry(previousEntry, oldText, content);
      if ("success" in patched) return patched;
      const next = [...entries];
      next[located.index] = patched.patched;
      const total = memoryCharCount(next);
      if (total > limit) return overBudgetFailure(entries, total, limit);
      return {
        success: true,
        message: "Entry patched.",
        entries: next,
        previousEntry,
        patchedEntry: patched.patched,
      };
    }
    case "remove": {
      const oldText = operation.old_text.trim();
      if (!oldText) {
        return { success: false, error: "old_text cannot be empty.", failureClass: "missing_old_text" };
      }
      const located = resolveIndex(entries, oldText, "remove");
      if ("success" in located) return located;
      const previousEntry = entries[located.index];
      const next = entries.filter((_entry, index) => index !== located.index);
      return { success: true, message: "Entry removed.", entries: next, previousEntry };
    }
    default: {
      const unreachable = operation as { action: string };
      return {
        success: false,
        error: `Unknown action '${unreachable.action}'. Use add, replace, patch, or remove.`,
        failureClass: "invalid_args",
      };
    }
  }
}

/**
 * Apply a batch atomically against the FINAL budget.
 *
 * All-or-nothing: any malformed or unmatched operation, or an over-limit result,
 * writes nothing and returns the first failure. Budgeting on the final result is
 * what lets one call free space and spend it — remove two stale entries and add
 * one new one, in a single turn, without the intermediate state ever exceeding
 * the limit.
 */
export function applyMemoryBatch(
  target: MemoryTarget,
  entries: readonly string[],
  operations: readonly MemoryOperation[],
): MemoryResult {
  if (operations.length === 0) {
    return {
      success: false,
      error: "operations cannot be empty.",
      failureClass: "invalid_args",
    };
  }
  const limit = charLimitFor(target);
  let working = [...entries];
  const previousEntries: string[] = [];
  let patchedEntry: string | undefined;
  for (const [index, operation] of operations.entries()) {
    const position = `operation ${index + 1} (${operation.action})`;
    // Each step runs against a limit high enough never to trip the per-step
    // budget: only the batch result is measured, per the contract above.
    const step = applyMemoryOperation(target, working, operation);
    if (!step.success) {
      return {
        success: false,
        error: `${position}: ${step.error}`,
        failureClass: step.failureClass,
        ...(step.closestEntries ? { closestEntries: step.closestEntries } : {}),
      };
    }
    if (step.previousEntry !== undefined) previousEntries.push(step.previousEntry);
    if (step.patchedEntry !== undefined) patchedEntry = step.patchedEntry;
    working = step.entries;
  }
  const total = memoryCharCount(working);
  if (total > limit) return overBudgetFailure(entries, total, limit);
  return {
    success: true,
    message: `Applied ${operations.length} operation${operations.length === 1 ? "" : "s"}.`,
    entries: working,
    ...(previousEntries.length === 1 ? { previousEntry: previousEntries[0] } : {}),
    ...(patchedEntry !== undefined ? { patchedEntry } : {}),
  };
}

/**
 * Render one target as the block a system prompt carries, or `undefined` when it
 * is empty.
 *
 * The header is part of the contract: a reader (and the compaction path that
 * removes a stale block) identifies the section by it.
 */
export function formatMemoryForSystemPrompt(
  target: MemoryTarget,
  entries: readonly string[],
): string | undefined {
  const stored = entries.filter((entry) => entry.trim().length > 0);
  if (stored.length === 0) return undefined;
  return [`## ${MEMORY_BLOCK_HEADERS[target]}`, "", ...stored.map((entry) => `- ${entry}`)].join("\n");
}
