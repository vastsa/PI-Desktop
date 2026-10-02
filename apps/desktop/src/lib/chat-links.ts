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

const KNOWN_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "css", "scss", "less",
  "html", "htm", "md", "mdx", "txt", "rs", "py", "go", "rb", "sh", "zsh",
  "bash", "yml", "yaml", "toml", "sql", "swift", "kt", "java", "c", "h",
  "cpp", "hpp", "cs", "php", "vue", "svelte", "xml", "ini", "cfg", "conf",
  "env", "lock", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf",
  "csv", "tsv", "log",
]);

const KNOWN_BARE_NAMES = new Set([
  "Makefile",
  "Dockerfile",
  "LICENSE",
  "README",
  "CHANGELOG",
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
    if (KNOWN_BARE_NAMES.has(base)) return true;
    return false;
  }
  if (KNOWN_BARE_NAMES.has(base)) return true;
  return KNOWN_EXTS.has(baseExt);
}

function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
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
  | { kind: "file"; path: string }
  | { kind: "url"; url: string };

/** Resolve one raw chat token into a previewable target, or null. */
export function resolvePreviewTarget(
  text: string,
  root?: string | null,
  baseDir?: string | null,
): ChatPreviewTarget | null {
  const trimmed = text.trim();
  if (isHttpUrl(trimmed)) return { kind: "url", url: trimmed };
  const at = unwrapAtFileRef(trimmed);
  if (at) {
    if (isAbsoluteFilePath(at)) return { kind: "file", path: at };
    const rel = toWorkspaceRel(at, root, baseDir);
    return rel ? { kind: "file", path: rel } : null;
  }
  const file = parseFileRef(trimmed);
  if (!file) return null;
  if (isAbsoluteFilePath(file)) return { kind: "file", path: file };
  const rel = toWorkspaceRel(file, root, baseDir);
  return rel ? { kind: "file", path: rel } : null;
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

// Unicode-aware scan (#235). Keep absolute candidates whole, and do not stop
// at an inner extension such as the `.v1` in `report.v1.md`. CJK prose after
// the extension remains outside the link (Unicode `\b` cannot express that).
const PATH_WORD = String.raw`[\p{L}\p{N}_@+.-]+`;
const PATH_SEGMENT = String.raw`[\p{L}\p{N}_@+. -]+`;
// Only adjacent characters can extend a dotted directory. Whitespace after an
// extension is ambiguous with prose; quote such paths with @"...".
const PATH_CONTINUATION = String.raw`[\p{L}\p{N}_@+.-]*[\\/]`;
const FILE_END = String.raw`\.[A-Za-z0-9]{1,8}(?:[+@-][\p{L}\p{N}_@+-]*)?(?::\d+(?::\d+)?)?(?![A-Za-z0-9_@+-]|\.[A-Za-z0-9]|${PATH_CONTINUATION})`;
const BARE_FILE_END = String.raw`(?:${[...KNOWN_BARE_NAMES].join("|")})(?![\p{L}\p{N}_@+.-]|${PATH_CONTINUATION})`;
const FILE_NAME = String.raw`(?:${PATH_SEGMENT}?${FILE_END}|${BARE_FILE_END})`;
const UNC_PREFIX = String.raw`(?:\\\\[^\\/\s]+[\\/]|\/\/[^/\s]+\/)`;
const SPACED_START = String.raw`(?<![\p{L}\p{N}_@+.-])[A-Za-z][\p{L}\p{N}_+-]*(?: [\p{L}\p{N}_+-]+)+`;
// Unmarked first-segment spaces cannot be distinguished from prose. Retry
// after common introducers so ordinary bare file links still work.
const PROSE_INTRODUCERS = new Set([
  "a", "an", "the", "and", "or", "plus", "because", "with", "then", "against", "i", "is", "this", "please",
  "see", "open", "read", "view", "check", "show", "find", "edit",
  "update", "fix", "inspect", "compare", "review", "use", "add", "remove",
  "write", "create", "created", "delete", "rename", "move", "copy",
  "change", "saved", "generated",
]);
const SCAN_RE = new RegExp([
  String.raw`@"[^"\n]+"`,
  String.raw`@[^\s]+`,
  String.raw`https?:\/\/(?=[^\s<>"'()[\]{}])`,
  String.raw`(?:[A-Za-z]:[\\/]|${UNC_PREFIX}|\/)(?:${PATH_SEGMENT}[\\/])*?${FILE_NAME}`,
  String.raw`${SPACED_START}[\\/](?:${PATH_SEGMENT}[\\/])*?${FILE_NAME}`,
  String.raw`${SPACED_START}(?:\.[A-Za-z0-9_-]+)*${FILE_END}`,
  String.raw`(?:${PATH_WORD}[\\/])+(?:${PATH_SEGMENT}[\\/])*?${FILE_NAME}`,
  String.raw`(?:~\/)?\/?\.{1,2}\/(?:${PATH_WORD}\/)*${PATH_WORD}(?::\d+(?::\d+)?)?`,
  String.raw`(?:~\/)?\/?(?:${PATH_WORD}\/)+${PATH_WORD}(?::\d+(?::\d+)?)?`,
  String.raw`[\p{L}\p{N}_@+-][\p{L}\p{N}_@+.-]*${FILE_END}`,
].join("|"), "gu");

function spacedRefDisposition(raw: string): "accept" | "retry" | "skip" {
  if (isAbsoluteFilePath(raw) || raw.startsWith("@") || isHttpUrl(raw)) return "accept";
  const firstSegment = raw.split(/[\\/]/, 1)[0];
  if (!firstSegment.includes(" ")) return "accept";
  const firstWord = firstSegment.slice(0, firstSegment.indexOf(" ")).toLowerCase();
  return PROSE_INTRODUCERS.has(firstWord) ? "retry" : "skip";
}

/** Scan once, keeping URL parentheses but stopping at a closing prose wrapper. */
function scanUrl(text: string, start: number): string {
  let depth = 0;
  let end = start;
  for (; end < text.length; end += 1) {
    const character = text[end];
    if (/[\s<>"'[\]{}]/u.test(character)) break;
    if (character === "(") depth += 1;
    else if (character === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  // Sentence punctuation belongs to the surrounding prose, regardless of
  // whether the URL itself ends with a parenthesized path segment.
  return text.slice(start, end).replace(/[.,!?;:，。！？；：]+$/u, "");
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
  const segments: ChatTextSegment[] = [];
  let last = 0;
  const scanner = new RegExp(SCAN_RE);
  for (let match = scanner.exec(text); match; match = scanner.exec(text)) {
    const start = match.index;
    const raw = /^https?:\/\//i.test(match[0])
      ? scanUrl(text, start)
      : match[0];
    scanner.lastIndex = start + raw.length;
    if ((text[start - 1] === "~" && /^[\\/]/u.test(raw)) ||
        ["~/", "~\\"].includes(text.slice(start - 2, start))) continue;
    const disposition = spacedRefDisposition(raw);
    if (disposition === "skip") continue;
    if (disposition === "retry") {
      scanner.lastIndex = start + raw.indexOf(" ") + 1;
      continue;
    }
    const target = resolvePreviewTarget(raw, root, baseDir);
    if (!target) continue;
    if (start > last) segments.push({ kind: "text", text: text.slice(last, start) });
    const label =
      target.kind === "file" ? leafName(target.path) : raw;
    segments.push({ kind: "target", text: raw, label, target });
    last = start + raw.length;
  }
  if (segments.length === 0) return [{ kind: "text", text }];
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
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
  walk(tree, false);

  function walk(node: MdastNode | null | undefined, skip: boolean) {
    if (!node || typeof node.type !== "string") return;
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
        const value = child.value.trim();
        const spacedPathLike = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("~/");
        const target =
          spacedPathLike || !value.includes(" ")
            ? resolvePreviewTarget(value, root, baseDir)
            : null;
        if (target) {
          const url =
            target.kind === "url"
              ? target.url
              : /^[A-Za-z]:[\\/]/.test(target.path) || target.path.startsWith("\\\\")
                ? encodeURIComponent(target.path)
                : target.path;
          next.push({
            type: "link",
            url,
            children: [child],
          });
          continue;
        }
      }
      if (!nextSkip && child.type === "text" && typeof child.value === "string") {
        const segments = splitChatText(child.value, root, baseDir);
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
              : (/^[A-Za-z]:[\\/]/.test(segment.target.path) || segment.target.path.startsWith("\\\\"))
                ? encodeURIComponent(segment.target.path)
                : segment.target.path;
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
