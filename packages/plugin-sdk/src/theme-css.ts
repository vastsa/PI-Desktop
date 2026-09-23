export const THEME_CSS_MAX_BYTES = 256 * 1024;

/** Extensions a theme may reference out of its own package. */
export const THEME_ASSET_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "avif",
  "svg",
  "woff2",
] as const;

/** Declared assets of one theme, summed. */
export const THEME_ASSET_MAX_BYTES = 4 * 1024 * 1024;

/** Host-owned scheme that serves plugin package bytes to the shell renderer. */
export const THEME_ASSET_SCHEME = "plugin-asset";

export type ThemeCssResult = { ok: true; css: string } | { ok: false; error: string };

/**
 * Maps one `url(...)` target written by a theme onto the URL the host serves it
 * from, or `null` when the target is not a declared, valid asset. Returning a
 * URL both allows the reference and replaces it.
 */
export type ThemeCssAssetResolver = (target: string) => string | null;

/**
 * A `url(...)` construct found in code the browser would apply.
 *
 * `start` and `end` span the whole construct, including the `url(` and the
 * closing paren. They are offsets in the text that was scanned, and because
 * {@link maskNonCodeCss} keeps its length they also address the author's
 * original text.
 */
export type ThemeCssUrlReference = { start: number; end: number; target: string };

const THEME_ASSET_EXTENSION_PATTERN = new RegExp(
  `\\.(${THEME_ASSET_EXTENSIONS.join("|")})$`,
  "i",
);

/**
 * `plugin-asset://<pluginId>/<assetPath>` — how a theme reaches its bytes.
 *
 * Package-relative path segments are encoded independently so `/` stays a
 * separator and URL delimiters such as `?` and `#` remain part of the filename.
 * Absolute filesystem keys are encoded as a whole so drive colons cannot alter
 * lookup.
 */
export function themeAssetUrl(pluginId: string, assetPath: string): string {
  const normalized = normalizeThemeAssetPath(assetPath);
  const key = isExternalThemeAssetPath(normalized)
    ? encodeURIComponent(normalized)
    : normalized.split("/").map(encodeURIComponent).join("/");
  return `${THEME_ASSET_SCHEME}://${pluginId}/${key}`;
}

/**
 * Whether a normalized asset key names an external filesystem path.
 */
export function isExternalThemeAssetPath(key: string): boolean {
  return key.startsWith("/") || /^[a-zA-Z]:\//.test(key);
}

/**
 * Normalize a theme asset reference to either a package-relative forward-slash
 * path or an absolute filesystem path. The host distinguishes both forms at
 * load time and keeps package-local files contained inside the plugin root.
 *
 * Both the declaration in the manifest and the `url()` target inside the sheet
 * go through this, so `./art/bg.png` and `art/bg.png` are one package asset.
 *
 * Returns an empty string when the value cannot name one: an unknown scheme,
 * empty or `.`/`..` segment, or an extension off the whitelist.
 */
export function normalizeThemeAssetPath(value: string): string {
  let raw = value.trim();
  if (/^file:/i.test(raw)) {
    const stripped = raw.replace(/^file:\/\//i, "").replace(/^file:/i, "");
    try {
      raw = decodeURIComponent(stripped);
    } catch {
      return "";
    }
    if (/^\/[a-zA-Z]:\//.test(raw)) raw = raw.slice(1);
  }
  const path = raw
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (!path) return "";
  if (path.includes(":" ) && !isExternalThemeAssetPath(path)) return "";
  const segments = isExternalThemeAssetPath(path) ? path.split("/").filter(Boolean) : path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return "";
  return THEME_ASSET_EXTENSION_PATTERN.test(path) ? path : "";
}

/**
 * `contributes.themes[].assets` entries may be package-relative or absolute
 * filesystem paths, but must be on the extension whitelist. The host contains
 * package-relative paths inside the plugin root before serving them.
 */
export function isThemeAssetPath(value: string): boolean {
  return normalizeThemeAssetPath(value) !== "";
}

/**
 * Decode CSS escape sequences (`\69` hex with an optional trailing space, and
 * `\c` single-character escapes) so `@\69mport` and `\75rl(` read as the
 * keywords they resolve to in the browser. Escapes inside comments and
 * strings are decoded too; that only makes the check stricter.
 */
export function decodeCssEscapes(css: string): string {
  return css.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\r\n\f]?|([^\r\n\f0-9a-fA-F]))/g, (match, hex, char) => {
    if (typeof hex === "string") {
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return "\ufffd";
      }
      return String.fromCodePoint(codePoint);
    }
    return typeof char === "string" ? char : match;
  });
}

type CssScanState = "code" | "comment" | "string" | "url";

/**
 * Blank out everything the browser never applies: comment bodies and string
 * literals.
 *
 * The keyword checks below are plain regexes, so they have to run on CSS that
 * actually takes effect. A comment that merely *mentions* `@import` used to
 * reject the whole sheet, and so did an empty `url()` form inside a comment;
 * the author never wrote either construct.
 *
 * Masking emits one space per masked character, so every offset in the result
 * still points at the same character of the input — the `url()` span and target
 * reported by the caller are the author's original spelling.
 *
 * This cannot be a `/* … *\/` regex: in `content: "/*";` the browser sees a
 * string, a naive strip would read a comment, and everything up to the next
 * `*\/` — including a real `@import "x.css";` — would be hidden from the check.
 *
 * A `url(...)` argument is copied through verbatim. It is a genuine reference
 * whose target must survive for the caller to judge it, and inside a comment or
 * a string it is precisely the false positive being removed here. Scanning it
 * in the same pass keeps a quote inside a `url()` argument from leaking into
 * the general string state.
 */
export function maskNonCodeCss(css: string): string {
  const out: string[] = [];
  let state: CssScanState = "code";
  let quote = "";
  let index = 0;
  while (index < css.length) {
    const ch = css.charAt(index);
    if (state === "comment") {
      if (ch === "*" && css.charAt(index + 1) === "/") {
        out.push("  ");
        index += 2;
        state = "code";
        continue;
      }
      out.push(" ");
      index += 1;
      continue;
    }
    if (state === "string") {
      if (ch === "\\" && index + 1 < css.length) {
        out.push("  ");
        index += 2;
        continue;
      }
      out.push(" ");
      index += 1;
      if (ch === quote) {
        quote = "";
        state = "code";
      }
      continue;
    }
    if (state === "url") {
      if (quote) {
        out.push(ch);
        if (ch === "\\" && index + 1 < css.length) {
          out.push(css.charAt(index + 1));
          index += 2;
          continue;
        }
        if (ch === quote) quote = "";
        index += 1;
        continue;
      }
      out.push(ch);
      index += 1;
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ")") state = "code";
      continue;
    }
    if (ch === "/" && css.charAt(index + 1) === "*") {
      out.push("  ");
      index += 2;
      state = "comment";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out.push(" ");
      index += 1;
      state = "string";
      continue;
    }
    if ((ch === "u" || ch === "U") && css.slice(index, index + 4).toLowerCase() === "url(") {
      out.push(css.slice(index, index + 4));
      index += 4;
      state = "url";
      continue;
    }
    out.push(ch);
    index += 1;
  }
  return out.join("");
}

/**
 * Every `url(...)` the browser would resolve, with its span.
 *
 * Run this on masked text: a `url()` inside a comment or a string is not a
 * reference, and the spans stay valid for the source because masking preserves
 * length.
 */
export function findThemeCssUrlReferences(masked: string): ThemeCssUrlReference[] {
  const references: ThemeCssUrlReference[] = [];
  for (const match of masked.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const start = match.index ?? 0;
    references.push({ start, end: start + match[0].length, target: match[2] ?? "" });
  }
  return references;
}

/**
 * Find the first thing that makes a contributed sheet unacceptable.
 *
 * `css` must already be masked (and, on the escaped pass, escape-decoded):
 * these checks look for keywords, and text the browser would not apply has to
 * be gone before they run. A reference is accepted when it is a `data:` URI or
 * when `resolveAsset` claims it.
 */
function findThemeCssViolation(
  css: string,
  resolveAsset?: ThemeCssAssetResolver,
): string | undefined {
  if (/@import\b/i.test(css)) {
    return "theme css must not use @import";
  }
  if (/<\/?\s*style/i.test(css) || /<!--/.test(css)) {
    return "theme css must not contain markup";
  }
  if (/javascript\s*:/i.test(css) || /expression\s*\(/i.test(css)) {
    return "theme css must not contain script expressions";
  }
  const references = findThemeCssUrlReferences(css);
  for (const reference of references) {
    const target = reference.target.trim();
    if (/^data:/i.test(target)) continue;
    if (resolveAsset?.(target)) continue;
    return `theme css may only reference data: urls or declared assets (found "${target}")`;
  }
  // A `url(` the regex above could not parse (unterminated, nested quotes) is a
  // reference we cannot reason about, so refuse the whole sheet.
  if ((css.match(/url\(/gi) ?? []).length !== references.length) {
    return "theme css contains a malformed url() reference";
  }
  return undefined;
}

/**
 * Replace each resolvable reference with the host URL that serves it.
 *
 * Only the `url(...)` construct is rewritten, so the file's own bytes never
 * enter the sheet: the renderer gets a `plugin-asset://` URL it can fetch, and
 * nothing else about the cascade changes.
 */
function rewriteThemeAssetReferences(
  source: string,
  masked: string,
  resolveAsset: ThemeCssAssetResolver,
): string {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const reference of findThemeCssUrlReferences(masked)) {
    const target = reference.target.trim();
    if (/^data:/i.test(target)) continue;
    const url = resolveAsset(target);
    if (!url) continue;
    edits.push({ start: reference.start, end: reference.end, text: `url("${url}")` });
  }
  let out = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/**
 * Validate CSS contributed by a plugin before it is injected into the shell.
 *
 * The renderer applies the text verbatim, so the checks here are the whole
 * boundary: no remote loads, no stylesheet chaining, no tag break-out, and a
 * hard size cap. Each pass runs on the text with comments and strings blanked,
 * so only declarations and at-rules the browser would apply are inspected; the
 * second pass repeats it on a copy with CSS escapes decoded, because the
 * browser decodes `@\69mport` before parsing.
 *
 * `resolveAsset` opts into package assets: when it answers, the reference is
 * allowed and the returned sheet points that `url(...)` at the host's own
 * scheme. Omitting it keeps the `data:`-only rule, so a caller that cannot
 * serve package bytes denies them instead of letting a relative path through.
 */
export function sanitizeThemeCss(
  raw: string,
  maxBytes = THEME_CSS_MAX_BYTES,
  resolveAsset?: ThemeCssAssetResolver,
): ThemeCssResult {
  const css = raw.replace(/^\ufeff/, "");
  const bytes = new TextEncoder().encode(css).length;
  if (bytes > maxBytes) {
    return { ok: false, error: `theme css exceeds ${maxBytes} bytes (${bytes})` };
  }
  if (!css.trim()) {
    return { ok: false, error: "theme css is empty" };
  }
  const decoded = decodeCssEscapes(css);
  const masked = maskNonCodeCss(css);
  const violation =
    findThemeCssViolation(masked, resolveAsset) ??
    (decoded !== css
      ? findThemeCssViolation(maskNonCodeCss(decoded), resolveAsset)
      : undefined);
  if (violation) return { ok: false, error: violation };
  const rewritten = resolveAsset
    ? rewriteThemeAssetReferences(css, masked, resolveAsset)
    : css;
  return { ok: true, css: rewritten.trim() };
}
