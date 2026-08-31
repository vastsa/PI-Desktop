import type { UiMessage } from "@pi-desktop/shared";

/**
 * How many session panes stay mounted at once (ADR 0135): the visible one plus
 * the two most recently left. Each retained pane keeps its own transcript DOM,
 * scroll offset, and mounted-row window, so returning to it is a visibility
 * swap rather than a rebuild. The bound is what keeps that retention from
 * growing into every session the user has ever opened.
 */
export const RETAINED_SESSION_PANE_LIMIT = 3;

export type RetainedPanes = {
  /** Most recently visible first; the head is the pane on screen. */
  retainedSessionIds: string[];
  /**
   * Last transcript each retained pane painted. A pane reads the live
   * projection while it owns the active session and falls back to this snapshot
   * once another session takes over, so leaving a session cannot blank the pane
   * the user is coming back to.
   */
  retainedTranscripts: Record<string, UiMessage[]>;
};

/**
 * Promotes `id` to the visible pane slot and drops whatever falls outside the
 * retention bound.
 *
 * Retention is a pure projection rather than a ref inside the chat surface so
 * eviction is testable and so unrelated store paths (session deletion, project
 * switches) can release a pane without reaching into the component tree.
 * Unchanged results keep their previous identity, because every retained pane
 * subscribes to this state and a fresh object per commit would re-render all of
 * them on any store write.
 */
export function retainSessionPane(
  current: RetainedPanes,
  id: string | undefined,
  messages: UiMessage[],
): RetainedPanes {
  if (!id) return current;
  const order = [
    id,
    ...current.retainedSessionIds.filter((held) => held !== id),
  ].slice(0, RETAINED_SESSION_PANE_LIMIT);
  const next: Record<string, UiMessage[]> = { [id]: messages };
  for (const held of order) {
    if (held === id) continue;
    const snapshot = current.retainedTranscripts[held];
    if (snapshot) next[held] = snapshot;
  }
  return {
    retainedSessionIds: sameOrder(current.retainedSessionIds, order)
      ? current.retainedSessionIds
      : order,
    retainedTranscripts: sameTranscripts(current.retainedTranscripts, next)
      ? current.retainedTranscripts
      : next,
  };
}

/**
 * Drops every pane. Used by the paths that leave the chat with no active
 * session at all (switching project, clearing project): a retained pane whose
 * session is no longer reachable would otherwise stay on screen as the visible
 * pane and suppress the empty state.
 */
export function clearSessionPanes(): RetainedPanes {
  return { retainedSessionIds: [], retainedTranscripts: {} };
}

/** Releases a pane whose session is gone (deleted, or no longer reachable). */
export function releaseSessionPane(
  current: RetainedPanes,
  id: string,
): RetainedPanes {
  if (
    !current.retainedSessionIds.includes(id) &&
    !current.retainedTranscripts[id]
  ) {
    return current;
  }
  const { [id]: _released, ...rest } = current.retainedTranscripts;
  return {
    retainedSessionIds: current.retainedSessionIds.filter(
      (held) => held !== id,
    ),
    retainedTranscripts: rest,
  };
}

/**
 * Records what the visible pane is currently painting. Streaming, edits, and
 * retries all write the live projection; mirroring it here keeps the pane the
 * user leaves showing what it last painted rather than what it was opened with.
 */
export function recordPaneTranscript(
  current: RetainedPanes,
  id: string,
  messages: UiMessage[],
): RetainedPanes {
  if (!current.retainedSessionIds.includes(id)) return current;
  if (current.retainedTranscripts[id] === messages) return current;
  return {
    retainedSessionIds: current.retainedSessionIds,
    retainedTranscripts: { ...current.retainedTranscripts, [id]: messages },
  };
}

function sameOrder(a: string[], b: string[]) {
  return a.length === b.length && a.every((held, index) => b[index] === held);
}

function sameTranscripts(
  a: Record<string, UiMessage[]>,
  b: Record<string, UiMessage[]>,
) {
  const keys = Object.keys(b);
  return (
    Object.keys(a).length === keys.length &&
    keys.every((key) => a[key] === b[key])
  );
}
