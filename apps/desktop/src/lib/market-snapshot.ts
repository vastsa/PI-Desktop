/**
 * The last successful market result, kept so a later source failure can show
 * the list the user last saw instead of an empty pane (issue #1692). Both the
 * skill market and the MCP market keep one of these.
 */
export type MarketSnapshot<T> = {
  entries: T[];
  /** Epoch ms of the successful response, for the timestamp line. */
  at: number;
  /** The search text the snapshot was taken for; a stale snapshot must not
   * answer a different query. */
  query: string;
};

/** Whether a snapshot still describes the query currently on screen. */
export function snapshotMatchesQuery<T>(
  snapshot: MarketSnapshot<T> | null | undefined,
  query: string,
): boolean {
  if (snapshot == null) return false;
  // The main process filters case-insensitively, so the query identity that
  // matters is the trimmed, lowercased one.
  return snapshot.query.trim().toLocaleLowerCase() === query.trim().toLocaleLowerCase();
}

/**
 * Localized time for the snapshot line: clock time for today's snapshot, a
 * dated form otherwise, so "19:52" is never mistaken for today when the app
 * sat open overnight. Mirrors `formatMessageTime` in the transcript.
 */
export function snapshotTimeText(at: number, locale: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
