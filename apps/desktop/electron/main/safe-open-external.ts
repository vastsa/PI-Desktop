/**
 * Main-owned allowlist for URLs handed to `shell.openExternal` (D330, ADR 0168).
 *
 * `file:`, `javascript:`, `data:`, and OS/custom URI schemes must never reach
 * the operating system from renderer- or plugin-supplied strings. Workspace
 * files use `shell.openPath` after a separate path gate (ADR 0109).
 */
export const DISALLOWED_EXTERNAL_URL = "DISALLOWED_EXTERNAL_URL";

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Return the normalized href if `rawUrl` is an http(s) or mailto URL the OS
 * may open, otherwise `null`.
 */
export function parseAllowedExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || CONTROL_CHARS.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (!parsed.hostname) return null;
      // WHATWG special-scheme filling turns `https:alert(1)` into
      // `https://alert(1)/`. Require the `//` form the caller actually wrote.
      if (!/^https?:\/\//i.test(trimmed)) return null;
      if (!parsed.href.startsWith("http://") && !parsed.href.startsWith("https://")) {
        return null;
      }
      return parsed.href;
    }
    if (parsed.protocol === "mailto:") {
      if (!parsed.pathname) return null;
      if (!parsed.href.startsWith("mailto:")) return null;
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

export function isAllowedExternalUrl(rawUrl: unknown): boolean {
  return parseAllowedExternalUrl(rawUrl) !== null;
}

export function isAllowedHttpUrl(rawUrl: unknown): boolean {
  const url = parseAllowedExternalUrl(rawUrl);
  return url !== null && (url.startsWith("http://") || url.startsWith("https://"));
}

export async function openAllowedExternal(
  rawUrl: unknown,
  openExternal: (url: string) => Promise<void>,
): Promise<string> {
  const url = parseAllowedExternalUrl(rawUrl);
  if (!url) {
    throw new Error(DISALLOWED_EXTERNAL_URL);
  }
  await openExternal(url);
  return url;
}
