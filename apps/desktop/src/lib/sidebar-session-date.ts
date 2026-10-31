const DAY_MS = 24 * 60 * 60 * 1000;

/** Format the session's most recent update as a relative day or a calendar date. */
export function formatSessionLastReplyDate(
  value: string | undefined,
  now = new Date(),
  locale?: string,
): string {
  if (!value) return "";

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";

  const date = new Date(timestamp);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const replyDay = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const daysAgo = Math.round((today - replyDay) / DAY_MS);

  try {
    if (daysAgo >= 0 && daysAgo <= 7) {
      return new Intl.RelativeTimeFormat(locale || undefined, {
        numeric: "always",
      }).format(-daysAgo, "day");
    }

    return new Intl.DateTimeFormat(locale || undefined, {
      month: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(date);
  }
}
