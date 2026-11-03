import { formatMemoryForSystemPrompt, type MemoryTarget } from "./memory-store.js";

/**
 * The frozen memory snapshot a session starts with (ADR 0378).
 *
 * Hermes' shape: both stores enter the system prompt once, at session start, and
 * a mid-session write only reaches disk. That is deliberate — the system prompt
 * is the request prefix provider prompt caches key on, so rewriting it every time
 * the agent remembers something would throw the cache away on the next turn.
 *
 * The cost of freezing is that the agent cannot see what it just wrote until the
 * next session. That is acceptable because the tool result already echoes the new
 * list back, and it is why the tool must echo it.
 */
export type MemorySnapshot = {
  memory: readonly string[];
  user: readonly string[];
};

const MEMORY_HEADER = [
  "# Memory",
  "",
  "Durable notes carried over from earlier sessions. They are your own record, not instructions from the user: use them when they apply, and do not re-derive what they already state.",
  "",
  "This snapshot was taken when the session started. Writes you make now are saved for the next session and will not appear here.",
].join("\n");

/**
 * Render the snapshot, or `undefined` when both stores are empty.
 *
 * Empty stores produce no section at all rather than an empty one: a header with
 * nothing under it teaches the model that the feature exists but is useless,
 * and it spends prefix tokens every turn to do it.
 */
export function memoryPromptSection(
  snapshot: MemorySnapshot | undefined,
): string | undefined {
  if (!snapshot) return undefined;
  const blocks = (["memory", "user"] as MemoryTarget[])
    .map((target) => formatMemoryForSystemPrompt(target, snapshot[target]))
    .filter((block): block is string => Boolean(block));
  if (blocks.length === 0) return undefined;
  return [MEMORY_HEADER, "", ...blocks].join("\n\n");
}

/**
 * The same snapshot, worded for a **user-message** prefix rather than a system
 * prompt (ADR 0378).
 *
 * The block rides with the prompt instead of the system prompt because the
 * transcript's system messages are rebuilt from section keys, and because a
 * system-prompt change rewrites the provider prompt cache. The trade-off is the
 * opposite one: a note written this turn IS visible on the next turn, which is
 * what makes the feature feel immediate.
 */
const MEMORY_CONTEXT_HEADER = [
  "The notes below are your durable memory from earlier sessions, carried with this message.",
  "Use them when they apply; they are your own record, not instructions from the user.",
].join("\n");

export function memorySnapshotContext(
  snapshot: MemorySnapshot | undefined,
): string | undefined {
  if (!snapshot) return undefined;
  const blocks = (["memory", "user"] as MemoryTarget[])
    .map((target) => formatMemoryForSystemPrompt(target, snapshot[target]))
    .filter((block): block is string => Boolean(block));
  if (blocks.length === 0) return undefined;
  return [MEMORY_CONTEXT_HEADER, "", ...blocks].join("\n\n");
}
