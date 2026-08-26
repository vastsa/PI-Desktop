import type { SessionSummary, UiMessage } from "@pi-desktop/shared";

/**
 * A forked session's transcript window.
 *
 * A fork response carries the child's complete transcript, so the window is
 * whole: there is nothing older to page toward.
 */
export const FORKED_SESSION_WINDOW = {
  messageStart: 0,
  hasMoreBefore: false,
} as const;

export type ForkCommitInput<TSession extends { id: string }> = {
  /** Sessions currently listed in the sidebar. */
  sessions: TSession[];
  /** History entries recorded so far, and the index being viewed. */
  navStack: Array<{ page: string; sessionId?: string }>;
  navIndex: number;
};

export type ForkCommitResult<TSession extends { id: string }> = {
  sessions: TSession[];
  navStack: Array<{ page: string; sessionId?: string }>;
  navIndex: number;
  /** Whether the child becomes the visible session. */
  activated: boolean;
};

/**
 * Decide how a freshly forked child enters renderer state.
 *
 * The child is durable on the host as soon as `session.fork` returns, so it is
 * always inserted into the session list -- even when a newer navigation has
 * taken over the view. Only the visible switch and the history entry depend on
 * this fork still owning the navigation. Committing both together is what let a
 * branch exist on disk while the sidebar never showed it.
 */
export function commitForkedSessionState<TSession extends { id: string }>(
  current: ForkCommitInput<TSession>,
  child: TSession,
  options: { activate: boolean },
): ForkCommitResult<TSession> {
  const sessions = [
    child,
    ...current.sessions.filter((session) => session.id !== child.id),
  ];
  if (!options.activate) {
    return {
      sessions,
      navStack: current.navStack,
      navIndex: current.navIndex,
      activated: false,
    };
  }
  const stack = current.navStack.slice(0, current.navIndex + 1);
  const navStack = [...stack, { page: "chat", sessionId: child.id }].slice(-50);
  return {
    sessions,
    navStack,
    navIndex: navStack.length - 1,
    activated: true,
  };
}

/**
 * Messages a forked session starts with. A fork response always carries the
 * whole child transcript; a missing array means an empty conversation, never
 * "load it later".
 */
export function forkedSessionMessages(
  session: SessionSummary & { messages?: UiMessage[] },
): UiMessage[] {
  return session.messages ?? [];
}
