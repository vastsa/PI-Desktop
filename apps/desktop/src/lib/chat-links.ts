/**
 * Detection and resolution of file/URL references in chat content so the
 * transcript can preview them: HTML in the work-panel browser, other files
 * with the OS default handler, URLs in the embedded browser.
 *
 * File detection is deliberately conservative: a bare token only counts as a
 * file when it carries a known extension, so ordinary dotted identifiers in
 * prose (`store.messages`) stay plain text. Explicit `@path` tokens from the
 * composer (D124 / D320) are accepted even when quoted or absolute.
 *
 * Path tokens recognize Unicode letters and digits, spaces, and Windows drive
 * paths. Absolute candidates stay whole for main-process resolution, which
 * checks the allowed roots before opening anything. Home paths stay plain.
 *
 * Relative paths are workspace-rooted unless they start with `./` or `../`,
 * in which case they resolve against an optional markdown-file directory and
 * still cannot escape the workspace (D322).
 */

import { formatSessionLink, parseSessionLinkToken } from "@pi-desktop/shared";
import {
  CHAT_LINK_SCAN_LIMITS,
  createChatLinkScanBudget,
  KNOWN_BARE_CHAT_FILES,
  scanChatLinkCandidates,
  spendChatLinkScanWork,
  type ChatLinkScanBudget,
  type ChatLinkScanStats,
} from "./chat-link-scanner.ts";
import { beginRenderDiagnostic } from "./render-diagnostics.ts";

const KNOWN_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "css", "scss", "less",
  "html", "htm", "md", "mdx", "txt", "rs", "py", "go", "rb", "sh", "zsh",
  "bash", "yml", "yaml", "toml", "sql", "swift", "kt", "java", "c", "h",
  "cpp", "hpp", "cs", "php", "vue", "svelte", "xml", "ini", "cfg", "conf",
  "env", "lock", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf",
  "csv", "tsv", "log",
]);

const FILE_TOKEN_RE =
  /^(?:(?:[A-Za-z]:[\\/]|~[\\/]|\\\\|\/\/|[\\/])|(?:\.{1,2}[\\/])?)[\p{L}\p{N}_@+. -]+(?:[\\/][\p{L}\p{N}_@+. -]+)*(?::\d+(?::\d+)?)?$/u;

const AT_QUOTED_RE = /^@"([^"\n]+)"$/;
const AT_UNQUOTED_RE = /^@(\/?[^\s]+)$/;

export function isHttpUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

export function isHtmlFilePath(path: string): boolean {
  return /\.html?$/i.test(path);
}

function stripLineRef(path: string): string {
  return path.replace(/:\d+(?::\d+)?$/, "");
}

/** Trailing `:line[:col]` on a file token, if any. */
export function parseFileRefPosition(
  text: string,
): { line: number; column?: number } | null {
  const token = text.trim().replace(/[.,!?;:，。！？；：]+$/u, "");
  const match = token.match(/:(\d+)(?::(\d+))?$/);
  if (!match) return null;
  const line = Number(match[1]);
  if (!Number.isFinite(line) || line < 1) return null;
  const column = match[2] !== undefined ? Number(match[2]) : undefined;
  return column !== undefined && Number.isFinite(column) && column >= 1
    ? { line, column }
    : { line };
}

function leafName(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
}

function isLikelyFilePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const base = normalized.split("/").pop() ?? "";
  const dotIndex = base.lastIndexOf(".");
  const ext = dotIndex > 0 ? base.slice(dotIndex + 1).toLowerCase() : "";
  const baseExt = ext.replace(/[+@-][\p{L}\p{N}_@+-]*$/u, "");
  if (normalized.includes("/")) {
    if (baseExt && baseExt.length <= 8) return true;
    if (KNOWN_BARE_CHAT_FILES.has(base)) return true;
    return false;
  }
  if (KNOWN_BARE_CHAT_FILES.has(base)) return true;
  return KNOWN_EXTS.has(baseExt);
}

function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function encodeWindowsPathForHref(path: string): string {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")
    ? encodeURIComponent(path)
    : path;
}

function normalizeMarkdownWindowsPath(url: string): string {
  // Keep a drive letter from being interpreted as a URI scheme by the
  // renderer and sanitizer; the anchor decodes this back before file lookup.
  const decoded = safeDecodeUri(url);
  if (!/^[A-Za-z]:[\\/]/.test(decoded)) return url;
  const path = parseFileRef(decoded);
  if (path !== decoded) return url;
  return encodeWindowsPathForHref(path);
}

/**
 * Returns the cleaned path when `text` plausibly names a file (trailing
 * `:line[:col]` refs are stripped), otherwise null. A leading `@` — the
 * composer's file-reference sigil (D124) — is accepted and stripped so
 * `@src/a.ts` previews like `src/a.ts`.
 */
export function parseFileRef(text: string): string | null {
  let raw = text.trim();
  if (!raw || raw.length > 512) return null;
  if (raw.startsWith("@")) raw = raw.slice(1);
  if (!raw || !FILE_TOKEN_RE.test(raw)) return null;
  const path = stripLineRef(raw);
  return isLikelyFilePath(path) ? path : null;
}

/**
 * Unwrap a composer-serialized `@path` / `@"path with spaces"` token into the
 * canonical path. Quoted paths keep interior whitespace; unquoted tokens stop
 * at whitespace. Returns null when the token is not an `@` file reference.
 */
export function unwrapAtFileRef(text: string): string | null {
  const raw = text.trim();
  if (!raw || raw.length > 512) return null;
  const quoted = raw.match(AT_QUOTED_RE);
  if (quoted) {
    const path = stripLineRef(quoted[1]);
    return path && isLikelyFilePath(path) ? path : null;
  }
  const unquoted = raw.match(AT_UNQUOTED_RE);
  if (unquoted) {
    const path = stripLineRef(unquoted[1]);
    return path && isLikelyFilePath(path) ? path : null;
  }
  return null;
}

/** Parent directory of a workspace-relative (or POSIX) file path. */
export function fileDirOf(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "" : normalized.slice(0, index);
}

export function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isDotRelative(path: string): boolean {
  return (
    path === "." ||
    path === ".." ||
    path.startsWith("./") ||
    path.startsWith("../")
  );
}

/** Collapse `.` / `..` and reject any walk that leaves the workspace. */
function normalizeWorkspaceRel(path: string): string | null {
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

/**
 * Map a chat-mentioned path onto a workspace-relative path accepted by the
 * fs panel IPC. Absolute paths must live under the workspace root.
 * Unprefixed relative paths are workspace-rooted. `./` and `../` resolve
 * against `baseDir` (the viewed markdown file's directory) when provided,
 * otherwise against the workspace root. `~`, parent escapes, and paths
 * outside the root return null.
 */
export function toWorkspaceRel(
  path: string,
  root?: string | null,
  baseDir?: string | null,
): string | null {
  if (!path) return null;
  if (path.startsWith("~")) return null;
  const normalizedPath = path.replaceAll("\\", "/");

  let rel: string;
  if (isAbsoluteFilePath(path)) {
    if (!root) return null;
    const cleanRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
    const windowsPath = /^[A-Za-z]:\//.test(normalizedPath);
    const comparisonPath = windowsPath ? normalizedPath.toLowerCase() : normalizedPath;
    const comparisonRoot = windowsPath ? cleanRoot.toLowerCase() : cleanRoot;
    if (!comparisonPath.startsWith(comparisonRoot + "/")) return null;
    rel = normalizedPath.slice(cleanRoot.length + 1);
  } else if (isDotRelative(normalizedPath)) {
    const base = (baseDir ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
    rel = base ? `${base}/${normalizedPath}` : normalizedPath;
  } else {
    rel = normalizedPath;
  }

  return normalizeWorkspaceRel(rel);
}

export type ChatPreviewTarget =
  | { kind: "file"; path: string; line?: number; column?: number }
  | { kind: "url"; url: string }
  | { kind: "session"; sessionId: string };

/** Resolve one raw chat token into a previewable target, or null. */
export function resolvePreviewTarget(
  text: string,
  root?: string | null,
  baseDir?: string | null,
): ChatPreviewTarget | null {
  const trimmed = text.trim();
  const sessionId = parseSessionLinkToken(trimmed);
  if (sessionId) return { kind: "session", sessionId };
  if (isHttpUrl(trimmed)) return { kind: "url", url: trimmed };
  const position = parseFileRefPosition(trimmed);
  const pathText = position
    ? trimmed.replace(/[.,!?;:，。！？；：]+$/u, "")
    : trimmed;
  const at = unwrapAtFileRef(pathText);
  if (at) {
    const cleaned = stripLineRef(at);
    if (isAbsoluteFilePath(cleaned)) {
      return { kind: "file", path: cleaned, ...(position ?? {}) };
    }
    const rel = toWorkspaceRel(cleaned, root, baseDir);
    return rel ? { kind: "file", path: rel, ...(position ?? {}) } : null;
  }
  const file = parseFileRef(pathText);
  if (!file) return null;
  if (isAbsoluteFilePath(file)) return { kind: "file", path: file, ...(position ?? {}) };
  const rel = toWorkspaceRel(file, root, baseDir);
  return rel ? { kind: "file", path: rel, ...(position ?? {}) } : null;
}

/** Route a plain click on a local Markdown link through the existing file opener. */
export function handleMarkdownFileLinkClick(
  event: { preventDefault(): void },
  href: string,
  root: string | null | undefined,
  baseDir: string | undefined,
  openFileRef: (path: string, baseDir?: string) => void,
): boolean {
  const decoded = safeDecodeUri(href);
  const target = resolvePreviewTarget(decoded, root, baseDir);
  const ref = target?.kind === "file" ? target.path : toWorkspaceRel(decoded, root, baseDir);
  if (!ref) return false;
  event.preventDefault();
  openFileRef(ref, baseDir);
  return true;
}

/** Tool-call args → preview target (Read/Write/Edit paths, fetch URLs). */
export function getToolPreviewTarget(
  args: unknown,
  root?: string | null,
): ChatPreviewTarget | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      const raw = value.trim();
      if (isAbsoluteFilePath(raw)) return { kind: "file", path: raw };
      const rel = toWorkspaceRel(raw, root);
      if (rel) return { kind: "file", path: rel };
      return null;
    }
  }
  const url = record["url"];
  if (typeof url === "string" && isHttpUrl(url)) {
    return { kind: "url", url: url.trim() };
  }
  return null;
}

export type ChatTextSegment =
  | { kind: "text"; text: string }
  | {
      kind: "target";
      text: string;
      /** Compact leaf label for file chips; the raw token for URLs. */
      label: string;
      target: ChatPreviewTarget;
    };

// Unmarked first-segment spaces cannot be distinguished from prose. Retry
// after common introducers so ordinary bare file links still work.
const PROSE_INTRODUCERS = new Set([
  "a", "an", "the", "and", "or", "plus", "because", "with", "then", "against", "i", "is", "this", "please",
  "see", "open", "read", "view", "check", "show", "find", "edit",
  "update", "fix", "inspect", "compare", "review", "use", "add", "remove",
  "write", "create", "created", "delete", "rename", "move", "copy",
  "change", "saved", "generated", "和", "与", "再看", "然后", "接着",
  "打开", "请看", "先看", "查看", "读取", "编辑",
]);
function spacedRefDisposition(
  raw: string,
  source: string,
  start: number,
  budget: ChatLinkScanBudget,
  stats: ChatLinkScanStats,
): "accept" | "retry" | "skip" | "exhausted" {
  if (isAbsoluteFilePath(raw) || raw.startsWith("@") || isHttpUrl(raw)) return "accept";
  const firstSegment = raw.split(/[\\/]/, 1)[0];
  if (!firstSegment.includes(" ")) {
    if (start > 0 && /[ \t]/u.test(source[start - 1])) {
      if (!spendChatLinkScanWork(budget, stats, 1)) return "exhausted";
      let previousStart = start - 1;
      let inspected = 0;
      const separator = /[\s(),!?;:，。！？；：()[\]{}<>"']/u;
      while (previousStart > 0 && inspected < CHAT_LINK_SCAN_LIMITS.maxFileCandidateCodeUnits) {
        if (!spendChatLinkScanWork(budget, stats, 1)) return "exhausted";
        inspected += 1;
        if (separator.test(source[previousStart - 1])) {
          break;
        }
        previousStart -= 1;
      }
      const previousWord = source.slice(previousStart, start - 1).toLowerCase();
      const previousLooksLikeFile = /[./\\]/u.test(previousWord) ||
        /\.[A-Za-z0-9]{1,8}(?:[+@-][\p{L}\p{N}_@+-]*)?$/u.test(previousWord) ||
        /\p{Script=Han}/u.test(previousWord);
      if (
        previousWord &&
        inspected < CHAT_LINK_SCAN_LIMITS.maxFileCandidateCodeUnits &&
        !previousLooksLikeFile &&
        !PROSE_INTRODUCERS.has(previousWord)
      ) return "skip";
    }
    return "accept";
  }
  const firstWord = firstSegment.slice(0, firstSegment.indexOf(" ")).toLowerCase();
  return PROSE_INTRODUCERS.has(firstWord) ? "retry" : "skip";
}

function splitChatTextWithBudget(
  text: string,
  root?: string | null,
  baseDir?: string | null,
  budget: ChatLinkScanBudget = createChatLinkScanBudget(),
): ChatTextSegment[] {
  const segments: ChatTextSegment[] = [];
  let last = 0;
  const { candidates } = scanChatLinkCandidates(
    text,
    budget,
    (raw) => resolvePreviewTarget(raw, root, baseDir),
    spacedRefDisposition,
  );
  for (const { start, end, raw, target } of candidates) {
    if (start < last) continue;
    if (start > last) segments.push({ kind: "text", text: text.slice(last, start) });
    const label =
      target.kind === "file" ? leafName(target.path) : raw;
    segments.push({ kind: "target", text: raw, label, target });
    last = end;
  }
  if (segments.length === 0) return [{ kind: "text", text }];
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

/**
 * Split plain chat text (user messages) into literal runs and previewable
 * references. Unresolvable candidates stay literal text. File targets carry a
 * leaf-name `label` so the transcript can render composer-like chips (D320).
 */
export function splitChatText(
  text: string,
  root?: string | null,
  baseDir?: string | null,
): ChatTextSegment[] {
  return splitChatTextWithBudget(text, root, baseDir);
}

/** Minimal mdast node the markdown rewriter understands. */
export type MdastNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
};

const SKIP_MDAST = new Set([
  "code",
  "link",
  "image",
  "definition",
  "html",
]);

function normalizeMarkdownLinkDestination(node: MdastNode): void {
  if ((node.type === "link" || node.type === "definition") && typeof node.url === "string") {
    node.url = normalizeMarkdownWindowsPath(node.url);
  }
}

/**
 * Turn bare file/URL tokens in markdown phrasing into link nodes so the
 * existing markdown Anchor handler can preview them. Skips fenced code,
 * inline code, and existing links/images.
 */
export function linkifyMdastTree(
  tree: MdastNode | null | undefined,
  root?: string | null,
  baseDir?: string | null,
): void {
  const budget = createChatLinkScanBudget();
  const finishDiagnostic = beginRenderDiagnostic("markdown-linkify-tree");
  let inputNodeCount = 0;
  let sourceLength = 0;
  walk(tree, false);
  finishDiagnostic({
    inputNodeCount,
    sourceLength,
    linkCount: budget.links,
    workCodeUnits: budget.workCodeUnits,
    reason: budget.workCodeUnits >= CHAT_LINK_SCAN_LIMITS.maxScanWorkCodeUnits
      ? "scan-budget"
      : budget.links >= CHAT_LINK_SCAN_LIMITS.maxLinks
        ? "link-limit"
        : undefined,
  });

  function walk(node: MdastNode | null | undefined, skip: boolean) {
    if (!node || typeof node.type !== "string") return;
    inputNodeCount += 1;
    normalizeMarkdownLinkDestination(node);
    if ((node.type === "text" || node.type === "inlineCode") && typeof node.value === "string") {
      sourceLength += node.value.length;
    }
    const nextSkip = skip || SKIP_MDAST.has(node.type);
    if (!node.children) return;
    const next: MdastNode[] = [];
    for (const child of node.children) {
      if (!child || typeof child.type !== "string") continue;
      if (!nextSkip && child.type === "inlineCode" && typeof child.value === "string") {
        // The reported path in #1169 arrives as inline code; a code run that
        // resolves to a real file reference becomes a link (styled inline
        // code stays intact via the renderer's own code handling). A spaced
        // token must still look path-like the way the text scanner demands —
        // absolute or drive-letter anchored — so ordinary prose code runs
        // never turn into chips.
        let target: ChatPreviewTarget | null = null;
        const withinBudget =
          child.value.length <= CHAT_LINK_SCAN_LIMITS.maxFileCandidateCodeUnits &&
          budget.fileCandidates < CHAT_LINK_SCAN_LIMITS.maxFileCandidates &&
          budget.links < CHAT_LINK_SCAN_LIMITS.maxLinks &&
          budget.workCodeUnits + child.value.length * 2 <=
            CHAT_LINK_SCAN_LIMITS.maxScanWorkCodeUnits;
        if (withinBudget) {
          budget.fileCandidates += 1;
          budget.workCodeUnits += child.value.length * 2;
          const value = child.value.trim();
          const spacedPathLike = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("~/");
          target = spacedPathLike || !value.includes(" ")
            ? resolvePreviewTarget(value, root, baseDir)
            : null;
          if (target) budget.links += 1;
        }
        if (target) {
          const url =
            target.kind === "url"
              ? target.url
              : target.kind === "session"
                ? formatSessionLink(target.sessionId)
                : encodeWindowsPathForHref(target.path);
          next.push({
            type: "link",
            url,
            children: [child],
          });
          continue;
        }
      }
      if (!nextSkip && child.type === "text" && typeof child.value === "string") {
        const segments = splitChatTextWithBudget(child.value, root, baseDir, budget);
        if (segments.length === 1 && segments[0].kind === "text") {
          next.push(child);
          continue;
        }
        for (const segment of segments) {
          if (segment.kind === "text") {
            next.push({ type: "text", value: segment.text });
            continue;
          }
          const url =
            segment.target.kind === "url"
              ? segment.target.url
              : segment.target.kind === "session"
                ? formatSessionLink(segment.target.sessionId)
                : encodeWindowsPathForHref(segment.target.path);
          next.push({
            type: "link",
            url,
            children: [{ type: "text", value: segment.text }],
          });
        }
        continue;
      }
      walk(child, nextSkip);
      next.push(child);
    }
    node.children = next;
  }
}

/**
 * unified attacher for the chat file-link pass. `ReactMarkdown` / unified
 * call the plugin with options at freeze time and expect a transformer
 * back; returning the transformer itself makes unified invoke it with
 * `tree === undefined` and crash on `tree.type` when a session paints.
 */
export function remarkChatFileLinks(
  root?: string | null,
  baseDir?: string | null,
) {
  return function remarkChatFileLinksPlugin() {
    return (tree: MdastNode) => {
      linkifyMdastTree(tree, root, baseDir);
    };
  };
}
