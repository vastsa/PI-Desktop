/**
 * Detection and resolution of file/URL references in chat content so the
 * transcript can preview them in the work panel (files viewer / browser).
 *
 * File detection is deliberately conservative: a bare token only counts as a
 * file when it carries a known extension, so ordinary dotted identifiers in
 * prose (`store.messages`) stay plain text. Anything with a path separator
 * and an extension qualifies.
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

/**
 * A pathy token: optional leading `/` (absolute) or `./`/`../` prefix, then
 * segments of word chars, dots, @, +, - and spaces (spaces only where a path
 * could plausibly carry them — macOS/Windows paths like
 * `/Users/name/Documents/My Project/file.ts`), optionally a trailing
 * `:line[:col]` ref. A bare token must still end with a known extension or
 * bare name to count as a file (checked by `parseFileRef`).
 */
const FILE_TOKEN_RE =
  /^\/?(?:\.{1,2}\/)?[\w@+.-]+(?:(?:\/|\s)[\w@+.-]+)*(?::\d+(?::\d+)?)?$/;

export function isHttpUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
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
  const path = raw.replace(/:\d+(?::\d+)?$/, "");
  const base = path.split("/").pop() ?? "";
  const dotIndex = base.lastIndexOf(".");
  const ext = dotIndex > 0 ? base.slice(dotIndex + 1).toLowerCase() : "";
  if (path.includes("/")) {
    // Pathy tokens still need an extension or a well-known bare name so
    // module ids and slash-phrases stay plain.
    if (ext && ext.length <= 8) return path;
    if (KNOWN_BARE_NAMES.has(base)) return path;
    return null;
  }
  if (KNOWN_BARE_NAMES.has(base)) return path;
  return KNOWN_EXTS.has(ext) ? path : null;
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
    // Inside the workspace root, shorten to a workspace-relative path so the
    // file viewer lists it in context. Absolute paths outside the workspace
    // are passed through as-is: the host's read channel accepts a real file
    // outside the roots for explicit chat-reference previews, while the file
    // tree itself stays workspace-scoped.
    if (!root) return path;
    const cleanRoot = root.replace(/\/+$/, "");
    if (path === cleanRoot) return null;
    if (path.startsWith(cleanRoot + "/")) return path.slice(cleanRoot.length + 1);
    return path;
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
  | { kind: "target"; text: string; target: ChatPreviewTarget };

const SCAN_RE =
  /https?:\/\/[^\s<>"'()[\]{}]+|(?:\.{0,2}\/)?[\w@+ .-]+(?:\/[\w@+ .-]+)+(?::\d+(?::\d+)?)?|[\w@+-][\w@+.-]*\.[A-Za-z0-9]{1,8}\b/g;

/**
 * Split plain chat text (user messages) into literal runs and previewable
 * references. Unresolvable candidates stay literal text.
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
    // The scanner may include a leading space before a path segment; trim
    // before resolving and display the cleaned token.
    const cleaned = raw.trim();
    const target = resolvePreviewTarget(cleaned, root);
    if (!target) continue;
    if (start > last) segments.push({ kind: "text", text: text.slice(last, start) });
    segments.push({ kind: "target", text: cleaned, target });
    last = start + raw.length;
  }
  if (segments.length === 0) return [{ kind: "text", text }];
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}
