import { isAutomationSession } from "./session-origin";

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

/**
 * Empty slots keep their slot above ordinary history while composing (#2405).
 * A host append to any other session bumps its `sessions.updated_at`, so a
 * strict updatedAt order lets background activity displace the composing
 * empty slot: `latestSessionInScope` then hands New Task a session with
 * messages, the reuse check fails, and a second empty conversation is
 * created. Tiering by the durable empty predicate keeps the slot the
 * candidate until the first message lands; runtime signals (running, live
 * traffic, submitted drafts) stay with the reuse check at the call sites.
 */
export function emptySlotPrecedes(
  a: { messageCount: number },
  b: { messageCount: number },
): number {
  return Number(a.messageCount > 0) - Number(b.messageCount > 0);
}

export function sessionIsReusableEmpty(
  session: { messageCount: number; worktree?: unknown; scheduledRun?: boolean },
  options: {
    running?: boolean;
    liveMessageCount?: number;
    submitted?: boolean;
    /** The request asks for an isolated session (ADR 0329). */
    isolated?: boolean;
  } = {},
): boolean {
  // An isolated request always gets its own worktree, and an empty isolated
  // session is never handed out for an ordinary request (ADR 0329).
  if (options.isolated === true || session.worktree) return false;
  // Automation transcripts (scheduled runs) are entered only from their
  // task view and must never be reused as an interactive empty slot (#1684).
  if (isAutomationSession(session)) return false;
  if (session.messageCount > 0) return false;
  if (options.running === true) return false;
  if ((options.liveMessageCount ?? 0) > 0) return false;
  if (options.submitted === true) return false;
  return true;
}
