/**
 * Trigger detection and completion insertion for the composer autocomplete
 * (D123–D125). Pure string/cursor math so the exact "/"+"@" grammar is unit
 * tested away from React and IME timing.
 *
 * Grammar mirrors the pi CLI editor:
 * - "/" opens all commands in the first token. Later whitespace-delimited
 *   slash tokens offer Skills only; app commands still require the first token.
 * - "@" opens file mode when the token containing the cursor starts with
 *   "@" and the character before it is start-of-input, whitespace, or one
 *   of the pi delimiters (" ' =). A `@"` prefix starts a quoted token that
 *   may contain spaces until its closing quote.
 */


import { normalizeSubagentName } from "./subagent-definition.js";
export type ComposerTriggerMode = "slash" | "file";

export type ComposerTrigger = {
  mode: ComposerTriggerMode;
  /** Filter text (after "/" or "@", quotes stripped). */
  query: string;
  /** Index of the trigger character ("/" or "@") in the draft. */
  tokenStart: number;
  /** End of the replaced region — always the cursor position. */
  tokenEnd: number;
};

export const DEFAULT_LARGE_PASTE_THRESHOLD = 600;
export const MIN_LARGE_PASTE_THRESHOLD = 1;
export const MAX_LARGE_PASTE_THRESHOLD = 1_000_000;

/** Normalize the user-configured text-paste threshold at the renderer edge. */
export function normalizeLargePasteThreshold(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_LARGE_PASTE_THRESHOLD ||
    value > MAX_LARGE_PASTE_THRESHOLD
  ) {
    return DEFAULT_LARGE_PASTE_THRESHOLD;
  }
  return value;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
/** Characters that end the token scan-back, per pi's autocomplete. */
const DELIMITERS = new Set([" ", "\t", "\n", "\r", '"', "'", "="]);

/** U+3001 IDEOGRAPHIC COMMA — the mark a Chinese IME gives for "/" (D405). */
export const IDEOGRAPHIC_COMMA = "、";

/**
 * A Chinese IME types "、" where an ASCII "/" is meant, and switching input
 * methods to reach the slash menu breaks the flow of writing (issue #65). The
 * first character of an otherwise empty draft is rewritten to "/" so the
 * ordinary command menu opens; a mark anywhere later in the draft is text and
 * is left untouched.
 */
export function rewriteIdeographicCommaTrigger(value: string): string {
  return value.startsWith(IDEOGRAPHIC_COMMA)
    ? `/${value.slice(1)}`
    : value;
}

function isBoundary(value: string, index: number): boolean {
  if (index <= 0) return true;
  return DELIMITERS.has(value[index - 1]);
}

/** Detect the active autocomplete trigger for a draft + cursor, if any. */
export function detectTrigger(
  value: string,
  cursor: number,
): ComposerTrigger | null {
  if (cursor < 0 || cursor > value.length) return null;

  // Only the token under the cursor can open the menu. A later slash is a
  // Skill reference, not a second app command.
  let slashStart = cursor;
  while (slashStart > 0 && !WHITESPACE.has(value[slashStart - 1])) slashStart -= 1;
  if (value[slashStart] === "/" && cursor > slashStart) {
    let tokenEnd = cursor;
    if (slashStart > 0) {
      while (tokenEnd < value.length && !WHITESPACE.has(value[tokenEnd])) tokenEnd += 1;
    }
    return {
      mode: "slash",
      query: value.slice(slashStart + 1, cursor),
      tokenStart: slashStart,
      tokenEnd,
    };
  }

  // File mode, quoted form first: @"query with spaces
  // Scan back for a `@"` whose "@" sits at a boundary with no closing
  // quote between the opening one and the cursor.
  for (let i = cursor - 1; i >= 0; i -= 1) {
    const ch = value[i];
    if (ch === '"') {
      // A bare closing quote before the cursor ends any quoted token.
      if (i > 0 && value[i - 1] === "@" && isBoundary(value, i - 1)) {
        const query = value.slice(i + 1, cursor);
        if (!query.includes('"') && !query.includes("\n")) {
          return {
            mode: "file",
            query,
            tokenStart: i - 1,
            tokenEnd: cursor,
          };
        }
      }
      break;
    }
    if (ch === "\n") break;
  }

  // File mode, plain token: scan back to the nearest delimiter.
  let start = cursor;
  while (start > 0 && !DELIMITERS.has(value[start - 1])) start -= 1;
  const token = value.slice(start, cursor);
  if (token.startsWith("@") && isBoundary(value, start)) {
    return {
      mode: "file",
      query: token.slice(1),
      tokenStart: start,
      tokenEnd: cursor,
    };
  }

  return null;
}

export type SkillMention = { start: number; end: number; id: string };

/** Resolve complete slash tokens against the active Skill catalog at send time. */
export function findSkillMentions(
  content: string,
  skillIds: ReadonlyMap<string, string>,
): SkillMention[] {
  const mentions: SkillMention[] = [];
  for (const match of content.matchAll(/(^|\s)\/([^\s]+)/g)) {
    const id = skillIds.get(match[2]);
    if (!id) continue;
    const start = match.index + match[1].length;
    mentions.push({ start, end: start + match[2].length + 1, id });
  }
  return mentions;
}

export type AgentMention = { start: number; end: number; name: string };

/**
 * Trailing punctuation that closes a sentence rather than naming a delegate.
 * `@explorer,` asks for the explorer; `@explorer` inside `user@explorer` does
 * not, because that token is not at a boundary.
 */
const MENTION_TRAILING = /[.,;:!?'")\]}]+$/;

/**
 * Resolve `@agent` tokens against the delegation catalog at send time.
 *
 * The mention mirrors a file reference on the wire (both serialize to an
 * `@token`), so a token is only an agent when both hold:
 *
 * - the normalized token names a subagent `Task` would actually offer, and
 * - `resolvablePaths` holds no file of that name.
 *
 * The file case therefore wins whenever the workspace really has an
 * `explorer` file. Only bare tokens qualify: a token carrying `/` or a quote
 * is a path, and subagent names are `[a-z0-9-]` by contract
 * (`normalizeSubagentName`), so nothing legitimate is lost.
 */
export function findAgentMentions(
  content: string,
  agentNames: ReadonlySet<string>,
  resolvablePaths?: ReadonlySet<string>,
): AgentMention[] {
  const mentions: AgentMention[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/(^|\s)@([^\s"']+)/g)) {
    const raw = match[2];
    if (raw.includes("/") || raw.includes("\\")) continue;
    const start = match.index + match[1].length;
    const bare = raw.replace(MENTION_TRAILING, "");
    if (!bare) continue;
    const name = normalizeSubagentName(bare);
    if (!name || !agentNames.has(name)) continue;
    if (resolvablePaths?.has(bare) || resolvablePaths?.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    // `start` points at the "@" and the range must span the whole mention
    // including it, so stripping the token cannot leave a dangling suffix.
    mentions.push({ start, end: start + bare.length + 1, name });
  }
  return mentions;
}

/**
 * The model instruction a user-authored `@agent` mention rewrites into.
 *
 * This is a strong prompt, not an enforced dispatch, exactly like the
 * `/skill` rewrite: every downstream delegation behavior (cards, topology,
 * permission queue, `TaskWait`) already keys off "this is a `Task` call", so
 * routing through the model keeps one implementation of delegation instead of
 * a second path that would also have to synthesize a parent tool row.
 */
export function buildAgentDispatchInstruction(names: string[]): string {
  const quoted = names.map((name) => JSON.stringify(name));
  const one = names.length === 1;
  return [
    one
      ? "Call the `Task` tool with the agent below before answering this request. Pass the request that follows as its `task` brief, adding anything the delegate cannot infer on its own, then converge on its report with `TaskWait` before you reply."
      : "Call the `Task` tool once per agent listed below before answering this request. Pass the request that follows as each delegate's `task` brief, adding anything they cannot infer on their own, then converge on their reports with `TaskWait` before you reply.",
    `Agent${one ? "" : "s"}: ${quoted.join(", ")}`,
  ].join("\n");
}

/** Insertion text for an accepted agent entry: `@name ` ready for the brief. */
export function formatAgentInsert(name: string): string {
  return `@${name} `;
}

/** Insertion text for an accepted slash command: `/name ` ready for args. */
export function formatCommandInsert(name: string): string {
  return `/${name} `;
}

/**
 * Insertion text for an accepted file entry. Files end with a space so the
 * prompt continues naturally; directories end with "/" (quote left open for
 * spaced paths) so completion continues into the directory (D124).
 */
export function formatFileInsert(path: string, kind: "dir" | "file"): string {
  const needsQuote = /\s/.test(path);
  if (kind === "dir") {
    return needsQuote ? `@"${path}/` : `@${path}/`;
  }
  return needsQuote ? `@"${path}" ` : `@${path} `;
}

/** Return a compact leaf label without changing the canonical reference path. */
export function fileReferenceLabel(path: string, preferredName?: string): string {
  const candidate = preferredName?.trim() || path;
  const normalized = candidate.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || candidate;
}

/**
 * Serialize renderer-owned file references only at send time. The textarea can
 * stay compact while the persisted/model-facing prompt keeps exact @ paths.
 */
export function serializeComposerFileReferences(
  draft: string,
  references: ReadonlyArray<{ path: string; token?: string }>,
): string {
  const content = serializeInlineComposerFileReferences(draft, references);
  const paths = references
    .filter((reference) => !reference.token)
    .map((reference) => formatFileInsert(reference.path, "file"))
    .join("")
    .trim();
  if (!content) return paths;
  if (!paths) return content;
  return `${content}\n${paths}`;
}

/**
 * Resolve only inline generated tokens (legacy @name strings or single
 * sentinel characters backing atomic chips). Each resolved token keeps one
 * separating space so adjacent chips never fuse their @paths together.
 */
export function serializeInlineComposerFileReferences(
  draft: string,
  references: ReadonlyArray<{ path: string; token?: string }>,
): string {
  let content = draft;
  for (const reference of references) {
    const token = reference.token?.trim();
    if (!token || !content.includes(token)) continue;
    const insert = formatFileInsert(reference.path, "file").trim();
    let index = content.indexOf(token);
    while (index !== -1) {
      const nextChar = content[index + token.length];
      const separator = nextChar && !/\s/.test(nextChar) ? " " : "";
      content =
        content.slice(0, index) +
        insert +
        separator +
        content.slice(index + token.length);
      index = content.indexOf(token, index + insert.length + separator.length);
    }
  }
  return content.trim();
}

/** Remove renderer-only inline reference tokens before text-only enhancement. */
export function stripInlineComposerFileReferenceTokens(
  draft: string,
  references: ReadonlyArray<{ token?: string }>,
): string {
  const tokens = references
    .map((reference) => reference.token?.trim())
    .filter((token): token is string => Boolean(token))
    .sort((a, b) => b.length - a.length);
  let content = draft;
  for (const token of tokens) content = content.replaceAll(token, "");
  return content;
}

/**
 * Restore inline reference chips around an enhanced text-only draft. The
 * model must never be trusted to preserve private renderer sentinels; tokens
 * keep their order and approximate relative text position instead.
 */
export function restoreInlineComposerFileReferenceTokens(
  sourceDraft: string,
  enhancedDraft: string,
  references: ReadonlyArray<{ token?: string }>,
): string {
  const tokens = references
    .map((reference) => reference.token?.trim())
    .filter((token): token is string => Boolean(token))
    .sort((a, b) => b.length - a.length);
  if (!tokens.length) return enhancedDraft;

  const occurrences: Array<{ sourceIndex: number; token: string; textOffset: number }> = [];
  for (const token of tokens) {
    let sourceIndex = sourceDraft.indexOf(token);
    while (sourceIndex !== -1) {
      occurrences.push({
        sourceIndex,
        token,
        textOffset: Array.from(
          stripInlineComposerFileReferenceTokens(sourceDraft.slice(0, sourceIndex), references),
        ).length,
      });
      sourceIndex = sourceDraft.indexOf(token, sourceIndex + token.length);
    }
  }
  if (!occurrences.length) return enhancedDraft;
  occurrences.sort((a, b) => a.sourceIndex - b.sourceIndex);

  const cleanEnhanced = stripInlineComposerFileReferenceTokens(enhancedDraft, references);
  const enhancedChars = Array.from(cleanEnhanced);
  const sourceTextLength = Array.from(
    stripInlineComposerFileReferenceTokens(sourceDraft, references),
  ).length;
  const insertions = new Map<number, string[]>();
  let previousTarget = 0;
  for (const occurrence of occurrences) {
    const target = sourceTextLength
      ? Math.round((occurrence.textOffset / sourceTextLength) * enhancedChars.length)
      : 0;
    const insertionIndex = Math.max(previousTarget, Math.min(enhancedChars.length, target));
    const group = insertions.get(insertionIndex) ?? [];
    group.push(occurrence.token);
    insertions.set(insertionIndex, group);
    previousTarget = insertionIndex;
  }

  const result: string[] = [];
  for (let index = 0; index <= enhancedChars.length; index += 1) {
    const group = insertions.get(index);
    if (group) result.push(...group);
    if (index < enhancedChars.length) result.push(enhancedChars[index]!);
  }
  return result.join("");
}

/** Replace the trigger token with `insert`, returning the new draft+cursor. */
export function applyCompletion(
  value: string,
  trigger: ComposerTrigger,
  insert: string,
): { value: string; cursor: number } {
  const before = value.slice(0, trigger.tokenStart);
  const after = value.slice(trigger.tokenEnd);
  return { value: before + insert + after, cursor: before.length + insert.length };
}
