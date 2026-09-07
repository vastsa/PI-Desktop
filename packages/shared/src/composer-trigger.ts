/**
 * Trigger detection and completion insertion for the composer autocomplete
 * (D123–D125). Pure string/cursor math so the exact "/"+"@" grammar is unit
 * tested away from React and IME timing.
 *
 * Grammar mirrors the pi CLI editor:
 * - "/" opens command mode only as the very first character of the draft,
 *   while the cursor is still inside that first whitespace-free token.
 * - "@" opens file mode when the token containing the cursor starts with
 *   "@" and the character before it is start-of-input, whitespace, or one
 *   of the pi delimiters (" ' =). A `@"` prefix starts a quoted token that
 *   may contain spaces until its closing quote.
 */

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

  // Slash mode: draft starts with "/", cursor inside the first token.
  if (value.startsWith("/") && cursor >= 1) {
    const head = value.slice(1, cursor);
    let hasWhitespace = false;
    for (const ch of head) {
      if (WHITESPACE.has(ch)) {
        hasWhitespace = true;
        break;
      }
    }
    if (!hasWhitespace) {
      return { mode: "slash", query: head, tokenStart: 0, tokenEnd: cursor };
    }
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
