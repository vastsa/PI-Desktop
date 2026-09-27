export const THEME_CSS_MAX_BYTES = 256 * 1024;

export type ThemeCssResult = { ok: true; css: string } | { ok: false; error: string };

/**
 * Validate CSS contributed by a plugin before it is injected into the shell.
 *
 * The renderer applies the text verbatim, so the checks here are the whole
 * boundary: no remote loads, no stylesheet chaining, no tag break-out, and a
 * hard size cap.
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
  if (/@import\b/i.test(css)) {
    return { ok: false, error: "theme css must not use @import" };
  }
  if (/<\/?\s*style/i.test(css) || /<!--/.test(css)) {
    return { ok: false, error: "theme css must not contain markup" };
  }
  if (/javascript\s*:/i.test(css) || /expression\s*\(/i.test(css)) {
    return { ok: false, error: "theme css must not contain script expressions" };
  }
  let wellFormedUrls = 0;
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    wellFormedUrls += 1;
    const target = match[2].trim();
    if (!/^data:/i.test(target)) {
      return { ok: false, error: `theme css may only reference data: urls (found "${target}")` };
    }
  }
  // A `url(` the regex above could not parse (unterminated, nested quotes) is a
  // reference we cannot reason about, so refuse the whole sheet.
  if ((css.match(/url\(/gi) ?? []).length !== wellFormedUrls) {
    return { ok: false, error: "theme css contains a malformed url() reference" };
  }
  return { ok: true, css: css.trim() };
}
