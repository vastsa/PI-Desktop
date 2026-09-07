/**
 * New Task empty-slot reuse (ADR 0113) and first-frame empty reveal (ADR 0154).
 *
 * Host `messageCount` is the durable empty predicate, but the renderer may
 * already know the latest session is no longer empty: a prompt can be
 * streaming, live in the transcript cache, or sitting in the submitted-draft
 * map before `session.list` refreshes. Those in-memory signals replace a
 * blocking list round-trip on New Task.
 */

export const EMPTY_SESSION_WINDOW = {
  messageStart: 0,
  hasMoreBefore: false,
} as const;

export function sessionIsReusableEmpty(
  session: { messageCount: number },
  options: {
    running?: boolean;
    liveMessageCount?: number;
    submitted?: boolean;
  } = {},
): boolean {
  if (session.messageCount > 0) return false;
  if (options.running === true) return false;
  if ((options.liveMessageCount ?? 0) > 0) return false;
  if (options.submitted === true) return false;
  return true;
}
