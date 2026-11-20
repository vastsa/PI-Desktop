/**
 * Text for a GitHub connector failure, in the user's language (ADR
 * github-connector).
 *
 * The connector lives in Electron main and writes its messages in English.
 * Every failure it reports also carries one of eleven `GITHUB_*` codes, and
 * the catalogs hold a sentence for each under `errors.<code>`, so the
 * renderer shows that sentence. Main's own message is the fallback, for a
 * failure with no code or with one the connector does not own.
 */

/** A translator: react-i18next's `t`, or anything with its fallback option. */
export type Translate = (key: string, options?: { defaultValue?: string }) => string;

const GITHUB_ERROR_CODES: ReadonlySet<string> = new Set([
  "GITHUB_NOT_CONNECTED",
  "GITHUB_AUTH_FAILED",
  "GITHUB_FORBIDDEN",
  "GITHUB_NOT_FOUND",
  "GITHUB_RATE_LIMITED",
  "GITHUB_NETWORK",
  "GITHUB_INVALID_TOKEN",
  "GITHUB_DEVICE_FLOW_UNAVAILABLE",
  "GITHUB_LOGIN_EXPIRED",
  "GITHUB_LOGIN_DENIED",
  "GITHUB_VALIDATION_FAILED",
]);

/** The catalog's sentence for a connector code, or `fallback` for any other. */
export function githubErrorTextForCode(
  t: Translate,
  code: unknown,
  fallback: string,
): string {
  if (typeof code !== "string" || !GITHUB_ERROR_CODES.has(code)) return fallback;
  return t(`errors.${code}`, { defaultValue: fallback });
}

/** The same, for a thrown value: `api` rejections carry the code as `code`. */
export function githubErrorText(t: Translate, error: unknown): string {
  const fallback = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return githubErrorTextForCode(t, code, fallback);
}
