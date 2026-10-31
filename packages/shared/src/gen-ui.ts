/**
 * Inline generative UI visualizations (ADR gen-ui-inline-visualization).
 *
 * The model writes an HTML fragment to `<data_dir>/visualizations/<sessionId>/`
 * and references it from its reply with a standalone `::visualize{...}` line.
 * The renderer maps the referenced absolute path to a `pi-genui://` URL that
 * Electron Main resolves against the current data directory, so references
 * survive data-directory relocation.
 */

/** Custom scheme Electron Main serves visualization documents from. */
export const GEN_UI_SCHEME = "pi-genui";

/** Directory under the data root that holds per-session visualization files. */
export const GEN_UI_DIRECTORY_NAME = "visualizations";

/** Built-in skill that teaches the model the visualization contract. */
export const GEN_UI_SKILL_ID = "pi-desktop/visualize";

/** Largest fragment Electron Main will serve. */
export const GEN_UI_MAX_FRAGMENT_BYTES = 2 * 1024 * 1024;

/** Private Host → Main payload; base64 bounds JSON expansion of fragment bytes. */
export type GenUiFragmentReadResult =
  | { ok: true; base64: string }
  | { ok: false; code: "not-found" | "too-large" };

const MAX_BASE64_LENGTH = Math.ceil(GEN_UI_MAX_FRAGMENT_BYTES / 3) * 4;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Validate the private native-reader boundary before Main decodes any bytes. */
export function isGenUiFragmentReadResult(value: unknown): value is GenUiFragmentReadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2) return false;
  if (record.ok === false) return record.code === "not-found" || record.code === "too-large";
  return record.ok === true && typeof record.base64 === "string"
    && record.base64.length <= MAX_BASE64_LENGTH && record.base64.length % 4 === 0
    && BASE64_PATTERN.test(record.base64);
}

/** Guest → host: the guest document's content height in CSS pixels. */
export const GEN_UI_SIZE_MESSAGE = "pi-genui:size";
/** Host → guest: resolved theme variables to apply on the guest root. */
export const GEN_UI_THEME_MESSAGE = "pi-genui:theme";
/**
 * Guest → host: a wheel event the guest received. The guest is an
 * out-of-process frame, so the host page never sees its input; the host
 * replays this as a non-scrolling gesture signal for the transcript.
 */
export const GEN_UI_WHEEL_MESSAGE = "pi-genui:wheel";
/** Host → guest: which surface shows the guest (`inline` card or `expanded` dialog). */
export const GEN_UI_VIEW_MESSAGE = "pi-genui:view";
/**
 * Guest → host: the shell runtime is running. Sent from the shell `<head>`
 * before the fragment parses, so the host can post theme and view before
 * first paint instead of waiting for `load`.
 */
export const GEN_UI_READY_MESSAGE = "pi-genui:ready";
/**
 * Guest → host: a key the host acts on. The guest is out-of-process, so its
 * keydowns never reach the host window; only `Escape` is forwarded.
 */
export const GEN_UI_KEY_MESSAGE = "pi-genui:key";
/** Guest → host: Main served an error shell instead of the fragment. */
export const GEN_UI_ERROR_MESSAGE = "pi-genui:error";
/**
 * Guest → host: a fragment script threw (an uncaught error or an unhandled
 * rejection). The card stays mounted and shows the message, so a chart that
 * failed to draw is not just a blank frame. Sent with `{ message }`, where
 * the message is guest text: the host bounds it and renders it as plain text.
 */
export const GEN_UI_SCRIPT_ERROR_MESSAGE = "pi-genui:script-error";
/** Longest script-error message the host shows; longer text is truncated. */
export const GEN_UI_MAX_SCRIPT_ERROR_LENGTH = 300;

/** Why Main could not serve a visualization; carried by `GEN_UI_ERROR_MESSAGE`. */
export const GEN_UI_ERROR_CODES = ["not-found", "too-large", "not-fragment", "runtime-unavailable"] as const;
export type GenUiErrorCode = (typeof GEN_UI_ERROR_CODES)[number];

export function isGenUiErrorCode(value: unknown): value is GenUiErrorCode {
  return typeof value === "string" && (GEN_UI_ERROR_CODES as readonly string[]).includes(value);
}

export const GEN_UI_MIN_HEIGHT = 120;
export const GEN_UI_INITIAL_HEIGHT = 240;
export const GEN_UI_MAX_HEIGHT = 2000;

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.html$/;

/** Session IDs use the same alphabet host-core accepts for scratch roots. */
export function isGenUiSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

/** A single path component ending in `.html`; no dot-dot or hidden names. */
export function isGenUiFileName(value: string): boolean {
  return FILE_NAME_PATTERN.test(value) && !value.includes("..");
}

export interface GenUiLocation {
  sessionId: string;
  fileName: string;
}

/**
 * Locate the trailing `visualizations/<sessionId>/<file>.html` of an absolute
 * path written by the model. Returns `null` for anything else.
 */
export function genUiLocationFromPath(path: string): GenUiLocation | null {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.length < 3) return null;
  const [directory, sessionId, fileName] = parts.slice(-3);
  if (directory !== GEN_UI_DIRECTORY_NAME) return null;
  if (!isGenUiSessionId(sessionId) || !isGenUiFileName(fileName)) return null;
  return { sessionId, fileName };
}

/** Fixed URL host; the session ID lives in the path because standard
 * schemes lower-case the host. */
export const GEN_UI_HOST = "session";

/** `pi-genui://session/<sessionId>/<file>.html` */
export function genUiUrl(location: GenUiLocation): string {
  return `${GEN_UI_SCHEME}://${GEN_UI_HOST}/${location.sessionId}/${encodeURIComponent(location.fileName)}`;
}

/** Parse a `pi-genui:` URL back into its location, rejecting anything else. */
export function genUiLocationFromUrl(url: string): GenUiLocation | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${GEN_UI_SCHEME}:`) return null;
  if (parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) return null;
  if (parsed.hostname !== GEN_UI_HOST) return null;
  const segments = parsed.pathname.split("/");
  if (segments.length !== 3 || segments[0] !== "") return null;
  const sessionId = segments[1];
  let fileName: string;
  try {
    fileName = decodeURIComponent(segments[2]);
  } catch {
    return null;
  }
  if (!isGenUiSessionId(sessionId) || !isGenUiFileName(fileName)) return null;
  return { sessionId, fileName };
}

export interface GenUiReference {
  /** Absolute path exactly as the model wrote it. */
  path: string;
  title?: string;
  location: GenUiLocation | null;
}

const REFERENCE_PREFIX = "::visualize";

/**
 * Parse the reference JSON. Models copying a Windows path often leave single
 * backslashes (`"C:\Users\..."`), which is invalid JSON; retry once with
 * every lone backslash doubled so the path survives literally.
 */
function parseReferenceJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    try {
      return JSON.parse(json.replace(/\\(?!["\\/])/g, "\\\\"));
    } catch {
      return null;
    }
  }
}

/** Parse one standalone `::visualize{...}` line; `null` when it is not one. */
export function parseGenUiReferenceLine(line: string): GenUiReference | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(`${REFERENCE_PREFIX}{`) || !trimmed.endsWith("}")) return null;
  const value = parseReferenceJson(trimmed.slice(REFERENCE_PREFIX.length));
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || record.path.length === 0) return null;
  const title =
    typeof record.title === "string" && record.title.trim() ? record.title.trim() : undefined;
  return { path: record.path, title, location: genUiLocationFromPath(record.path) };
}

export interface GenUiSplit {
  /** Message content with reference lines removed. */
  content: string;
  references: GenUiReference[];
}

/**
 * Split standalone reference lines out of completed assistant Markdown,
 * ignoring fenced (``` / ~~~) and indented code blocks.
 */
export function splitGenUiReferences(markdown: string): GenUiSplit {
  if (!markdown.includes(REFERENCE_PREFIX)) return { content: markdown, references: [] };
  const lines = markdown.split("\n");
  const kept: string[] = [];
  const references: GenUiReference[] = [];
  let fence: { marker: string; openIndex: number } | null = null;
  let lastBlock: FencedBlock | null = null;
  for (const line of lines) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      kept.push(line);
      if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) {
        lastBlock = { open: fence.openIndex, close: kept.length - 1 };
        fence = null;
      }
      continue;
    }
    const open = fenceOpen(line);
    if (open) {
      fence = { marker: open, openIndex: kept.length };
      kept.push(line);
      continue;
    }
    const indented = /^( {4}|\t)/.test(line);
    const reference = indented ? null : parseGenUiReferenceLine(line);
    if (reference) references.push(reference);
    else kept.push(line);
  }
  const closing = fence ? null : closingFencedReference(kept, lastBlock);
  if (closing) {
    kept.length = closing.start;
    references.push(closing.reference);
  }
  if (references.length === 0) return { content: markdown, references };
  return { content: kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd(), references };
}

interface FencedBlock {
  open: number;
  close: number;
}

const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** CommonMark fence opener; a backtick fence's info string has no backticks. */
function fenceOpen(line: string): string | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  if (match[1][0] === "`" && match[2].includes("`")) return null;
  return match[1];
}

/**
 * Models sometimes copy the reference into a code block. Code stays code in
 * general, but a reply that ends with a fenced block holding nothing except
 * one reference line meant that reference, so it is accepted there only.
 */
function closingFencedReference(
  lines: string[],
  block: FencedBlock | null,
): { start: number; reference: GenUiReference } | null {
  if (!block || block.close !== block.open + 2) return null;
  for (let index = block.close + 1; index < lines.length; index += 1) {
    if (lines[index].trim() !== "") return null;
  }
  const reference = parseGenUiReferenceLine(lines[block.open + 1]);
  return reference ? { start: block.open, reference } : null;
}
