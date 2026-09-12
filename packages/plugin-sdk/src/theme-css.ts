export const THEME_CSS_MAX_BYTES = 256 * 1024;

export type ThemeCssResult = { ok: true; css: string } | { ok: false; error: string };

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
        return "�";
      }
      return String.fromCodePoint(codePoint);
    }
    return typeof char === "string" ? char : match;
  });
}

function findThemeCssViolation(css: string): string | undefined {
  if (/@import\b/i.test(css)) {
    return "theme css must not use @import";
  }
  if (/<\/?\s*style/i.test(css) || /<!--/.test(css)) {
    return "theme css must not contain markup";
  }
  if (/javascript\s*:/i.test(css) || /expression\s*\(/i.test(css)) {
    return "theme css must not contain script expressions";
  }
  let wellFormedUrls = 0;
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    wellFormedUrls += 1;
    const target = match[2].trim();
    if (!/^data:/i.test(target)) {
      return `theme css may only reference data: urls (found "${target}")`;
    }
  }
  // A `url(` the regex above could not parse (unterminated, nested quotes) is a
  // reference we cannot reason about, so refuse the whole sheet.
  if ((css.match(/url\(/gi) ?? []).length !== wellFormedUrls) {
    return "theme css contains a malformed url() reference";
  }
  return undefined;
}

/**
 * Validate CSS contributed by a plugin before it is injected into the shell.
 *
 * The renderer applies the text verbatim, so the checks here are the whole
 * boundary: no remote loads, no stylesheet chaining, no tag break-out, and a
 * hard size cap. Every check runs on the raw text and on a copy with CSS
 * escapes decoded, because the browser decodes `@\69mport` before parsing.
 */
export function sanitizeThemeCss(raw: string, maxBytes = THEME_CSS_MAX_BYTES): ThemeCssResult {
  const css = raw.replace(/^﻿/, "");
  const bytes = new TextEncoder().encode(css).length;
  if (bytes > maxBytes) {
    return { ok: false, error: `theme css exceeds ${maxBytes} bytes (${bytes})` };
  }
  if (!css.trim()) {
    return { ok: false, error: "theme css is empty" };
  }
  const decoded = decodeCssEscapes(css);
  const violation =
    findThemeCssViolation(css) ??
    (decoded !== css ? findThemeCssViolation(decoded) : undefined);
  if (violation) return { ok: false, error: violation };
  return { ok: true, css: css.trim() };
}
