/**
 * Detection and resolution of file/URL references in chat content so the
 * transcript can preview them: HTML in the work-panel browser, other files
 * with the OS default handler, URLs in the embedded browser.
 *
 * File detection is deliberately conservative: a bare token only counts as a
 * file when it carries a known extension, so ordinary dotted identifiers in
 * prose (`store.messages`) stay plain text. Explicit `@path` tokens from the
 * composer (D124 / D320) are accepted even when quoted or absolute.
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
  /^\/?(?:\.{1,2}\/)?[\w@+.-]+(?:\/[\w@+.-]+)*(?::\d+(?::\d+)?)?$/;

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
  const base = path.split("/").pop() ?? "";
  const dotIndex = base.lastIndexOf(".");
  const ext = dotIndex > 0 ? base.slice(dotIndex + 1).toLowerCase() : "";
  if (path.includes("/")) {
    if (ext && ext.length <= 8) return true;
    if (KNOWN_BARE_NAMES.has(base)) return true;
    return false;
  }
  if (KNOWN_BARE_NAMES.has(base)) return true;
  return KNOWN_EXTS.has(ext);
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

/**
 * Map a chat-mentioned path onto a workspace-relative path accepted by the
 * fs panel IPC. Absolute paths must live under the workspace root; anything
 * else (outside the root, `~` refs, parent escapes) returns null.
 */
export function toWorkspaceRel(path: string, root?: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("~")) return null;
  if (path.startsWith("/")) {
    if (!root) return null;
    const cleanRoot = root.replace(/\/+$/, "");
    if (path === cleanRoot) return null;
    if (!path.startsWith(cleanRoot + "/")) return null;
    return path.slice(cleanRoot.length + 1);
  }
  const rel = path.replace(/^\.\//, "");
  if (!rel || rel.startsWith("../") || rel === "..") return null;
  return rel;
}

export type ChatPreviewTarget =
  | { kind: "file"; path: string }
  | { kind: "url"; url: string };

/** Resolve one raw chat token into a previewable target, or null. */
export function resolvePreviewTarget(
  text: string,
  root?: string | null,
): ChatPreviewTarget | null {
  const trimmed = text.trim();
  if (isHttpUrl(trimmed)) return { kind: "url", url: trimmed };
  const at = unwrapAtFileRef(trimmed);
  if (at) return { kind: "file", path: at };
  const file = parseFileRef(trimmed);
  if (!file) return null;
  const rel = toWorkspaceRel(file, root);
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
      const rel = toWorkspaceRel(value.trim(), root);
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

const SCAN_RE =
  /@"[^"\n]+"|@[^\s]+|https?:\/\/[^\s<>"'()[\]{}]+|(?:\.{0,2}\/)?[\w@+.-]+(?:\/[\w@+.-]+)+(?::\d+(?::\d+)?)?|[\w@+-][\w@+.-]*\.[A-Za-z0-9]{1,8}\b/g;

/**
 * Split plain chat text (user messages) into literal runs and previewable
 * references. Unresolvable candidates stay literal text. File targets carry a
 * leaf-name `label` so the transcript can render composer-like chips (D320).
 */
export function splitChatText(
  text: string,
  root?: string | null,
): ChatTextSegment[] {
  const segments: ChatTextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(SCAN_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const target = resolvePreviewTarget(raw, root);
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
