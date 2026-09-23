import type { SessionDetail } from "@pi-desktop/shared";

/**
 * Whether a durable window read is suspiciously empty (issue #795).
 *
 * The host answers `session.get` from a transcript file it may be rewriting at
 * that moment, so it can return "the session exists and has no messages" for a
 * session that has thousands. Taking that answer at face value cached an empty
 * transcript that the sidebar's hover prefetch re-served on every later open,
 * and the session stayed blank until the app restarted. A read is only
 * trustworthy as "empty" when the session's own count agrees with it.
 */
export function sessionReadLooksEmpty(
  session: Pick<SessionDetail, "messages" | "messageCount"> | null | undefined,
): boolean {
  if (!session) return false;
  return (session.messages ?? []).length === 0 && (session.messageCount ?? 0) > 0;
}
