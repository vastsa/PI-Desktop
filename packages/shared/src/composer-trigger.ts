import { formatSessionLink } from "./session-link.js";

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
 * Resolve complete `@name` tokens against the delegation catalog at send time
 * (ADR 0346). A token counts only at the start or after whitespace, so
 * `user@host` stays text, and only when it ends at whitespace, punctuation or
 * the end of the draft, so `@explorer.ts` stays a file reference.
 */
export function findAgentMentions(
  content: string,
  agentNames: ReadonlySet<string>,
): AgentMention[] {
  const mentions: AgentMention[] = [];
  for (const match of content.matchAll(
    /(^|\s)@([a-z0-9][a-z0-9-]*)(?=$|\s|[,;:!?)\]，。；：！？、）]|\.(?:\s|$))/g,
  )) {
    if (!agentNames.has(match[2])) continue;
    const start = match.index + match[1].length;
    mentions.push({ start, end: start + match[2].length + 1, name: match[2] });
  }
  return mentions;
}

/**
 * The model-facing prompt for a draft that names Skills (`/skill:…`) or
 * subagents (`@agent`). Skill tokens are removed from the body because the
 * instruction already loads them; agent tokens stay, because the body is what
 * each delegate's brief is written from and `@name` says which part is whose.
 */
export function composeMentionPrompt(
  content: string,
  skillMentions: readonly SkillMention[],
  agentMentions: readonly AgentMention[],
): string {
  let body = "";
  let end = 0;
  for (const mention of skillMentions) {
    body += content.slice(end, mention.start);
    end = mention.end;
  }
  body = (body + content.slice(end)).trim();
  const skillIds = [...new Set(skillMentions.map((mention) => mention.id))];
  const agentNames = [...new Set(agentMentions.map((mention) => mention.name))];
  return [
    skillIds.length
      ? `Call the \`Skill\` tool with each of these ids before answering this request, in order: ${skillIds.map((id) => JSON.stringify(id)).join(", ")}. Follow the loaded skill instructions.`
      : "",
    agentNames.length
      ? `The user explicitly delegated this request with @mentions. Call the \`Task\` tool with \`agent\` set to each of these subagents: ${agentNames.map((name) => JSON.stringify(name)).join(", ")}. Write each \`task\` as a complete brief built from the request below; there, @name marks the part addressed to that subagent. Converge with TaskWait and answer from the reports.`
      : "",
    body,
  ]
    .filter(Boolean)
    .join("\n\n");
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

/** What serialization reads of a reference's plugin part (`send` of a mark). */
type ComposerReferencePluginPart = { readonly kind?: string; readonly send?: string };

/**
 * Serialize renderer-owned file references only at send time. The textarea can
 * stay compact while the persisted/model-facing prompt keeps exact @ paths.
 */
export function serializeComposerFileReferences(
  draft: string,
  references: ReadonlyArray<{ path: string; kind?: string; token?: string; plugin?: ComposerReferencePluginPart }>,
): string {
  const content = serializeInlineComposerFileReferences(draft, references);
  const paths = references
    .filter((reference) => !reference.token && reference.kind !== "session" && reference.kind !== "directory" && reference.kind !== "agent")
    .map((reference) => formatFileInsert(reference.path, "file"))
    .join("")
    .trim();
  return [content, paths].filter(Boolean).join("\n");
}

const DIRECTORY_PROMPT_GUIDANCE =
  "The user provided these local directories for the current task.\nInspect their structure and read relevant files as needed to fulfill the request.";

/** Separate pasted folders from the user-facing text of a serialized prompt. */
export function splitComposerDirectoryPrompt(content: string): { text: string; paths: string[] } {
  const guidanceStart = content.lastIndexOf(DIRECTORY_PROMPT_GUIDANCE);
  if (guidanceStart < 0 || (guidanceStart > 0 && content[guidanceStart - 1] !== "\n")) {
    return { text: content, paths: [] };
  }
  const body = content.slice(0, guidanceStart).trimEnd();
  const trailer = content.slice(guidanceStart + DIRECTORY_PROMPT_GUIDANCE.length);
  const marker = /<dir>([^<>]+)<\/dir>/g;
  const paths: string[] = [];
  const decodePath = (escaped: string) => escaped.replace(/&(amp|lt|gt);/g, (entity) =>
    entity === "&amp;" ? "&" : entity === "&lt;" ? "<" : ">");
  const absolute = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
  if (trailer) {
    // Current drafts append a block of directory references after the guidance.
    const markers = [...trailer.matchAll(marker)];
    if (trailer !== markers.map(([tag]) => "\n" + tag).join("")) return { text: content, paths };
    for (const [, escaped] of markers) paths.push(decodePath(escaped));
    return paths.every((path) => absolute.test(path)) ? { text: body, paths } : { text: content, paths: [] };
  }
  // Older drafts stored the markers inline before the guidance.
  const text = body.replace(/<dir>([^<>]+)<\/dir>([ \t]?)/g, (tag, escaped: string, space: string, offset: number) => {
    const path = decodePath(escaped);
    if (!absolute.test(path)) return tag;
    paths.push(path);
    return offset > 0 && /[ \t]/.test(body[offset - 1]) ? "" : space;
  }).trim();
  return paths.length ? { text, paths } : { text: content, paths };
}

/** XML escaping keeps directory names from breaking out of their data marker. */
function directoryPromptReference(path: string): string {
  const escaped = path.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<dir>${escaped}</dir>`;
}

/**
 * Resolve only inline generated tokens (legacy @name strings or single
 * sentinel characters backing atomic chips). Each resolved token keeps one
 * separating space so adjacent chips never fuse their @paths together. A
 * plugin mark's token resolves to the text it sends (`plugin.send`) instead
 * of a path, and a session reference resolves to its `pi-desktop://` link.
 * An agent chip resolves to `@name` and also keeps a space before it, because
 * the send-time resolver reads an `@token` only after whitespace (ADR 0346).
 */
export function serializeInlineComposerFileReferences(
  draft: string,
  references: ReadonlyArray<{ path: string; kind?: string; token?: string; plugin?: ComposerReferencePluginPart }>,
): string {
  let content = draft;
  for (const reference of references) {
    const token = reference.token?.trim();
    if (!token || !content.includes(token)) continue;
    const send = reference.plugin?.send;
    const agent = reference.kind === "agent";
    const insert = typeof send === "string"
      ? send
      : agent
        ? `@${reference.path}`
        : reference.kind === "session"
          ? formatSessionLink(reference.path)
          : reference.kind === "directory"
            ? directoryPromptReference(reference.path)
            : formatFileInsert(reference.path, "file").trim();
    let index = content.indexOf(token);
    while (index !== -1) {
      const nextChar = content[index + token.length];
      const separator = nextChar && !/\s/.test(nextChar) ? " " : "";
      const previousChar = content[index - 1];
      const lead = agent && previousChar && !/\s/.test(previousChar) ? " " : "";
      content =
        content.slice(0, index) +
        lead +
        insert +
        separator +
        content.slice(index + token.length);
      index = content.indexOf(token, index + lead.length + insert.length + separator.length);
    }
  }
  const directories = references.filter(reference => reference.kind === "directory" &&
    (!reference.token || draft.includes(reference.token)));
  const guidance = directories.length
    ? DIRECTORY_PROMPT_GUIDANCE
    : "";
  const unpositioned = directories.filter(reference => !reference.token).map(reference => directoryPromptReference(reference.path)).join("\n");
  return [content.trim(), guidance, unpositioned].filter(Boolean).join("\n");
}

/** Remove renderer-only inline reference tokens before a text transform. */
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
 * Restore inline reference chips around a transformed text-only draft. The
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
