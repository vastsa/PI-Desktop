import type { PluginActiveSession } from "@pi-desktop/plugin-sdk";

/**
 * What the user is looking at, in the shape a plugin can subscribe to
 * (spec 07-plugins/03 §session).
 *
 * Two owners feed one snapshot. The renderer owns the selection, because the
 * shell is what decides which session is on screen, so it pushes the id and the
 * project path. The main process owns turn identity, because `activeTurns` is
 * the only place a durable turn id exists; this module remembers *when* that
 * turn started and never invents an identity of its own.
 *
 * The snapshot is a value. A session can switch or go idle between two reads, so
 * every consumer compares `sessionId` instead of holding a reference, and a
 * navigation naming a stale session is refused rather than applied.
 */
export type PluginActiveSessionSelection = {
  sessionId: string;
  projectPath: string | null;
};

export type PluginSessionContextDependencies = {
  /** The live turn this session is running, straight from `activeTurns`. */
  getActiveTurn: (sessionId: string) => string | null;
  /** Fan-out to the three plugin surfaces: processes, panels, docked views. */
  announce: (event: "session:activated", payload: PluginActiveSession | null) => void;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

/**
 * Sessions whose turn start this module still remembers. Start times exist only
 * to date the selected session's turn, and a turn that ends without a notice
 * never removes its entry, so the map is capped instead of growing with every
 * session that ever ran. Oldest insertions go first.
 */
const MAX_TRACKED_SESSIONS = 64;

/** Drop the oldest insertions until `map` holds at most `limit` entries. */
function enforceBound<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

export type PluginSessionContext = ReturnType<typeof createPluginSessionContext>;

export function createPluginSessionContext({
  getActiveTurn,
  announce,
  now = Date.now,
  log,
}: PluginSessionContextDependencies) {
  let selection: PluginActiveSessionSelection | null = null;
  /**
   * sessionId → the turn whose start this module saw. Only a start that was
   * observed can be dated, so an entry here is what lets the snapshot report
   * `startedAt`; the turn id it names is still validated against `activeTurns`
   * on every read, which is why a turn that ended without notice ages out
   * instead of pinning a stale "running" state.
   */
  const turnStarts = new Map<string, { turnId: string; startedAt: number }>();
  /** The last payload delivered, so identical snapshots stay silent. */
  let announced: string | null = null;

  const snapshot = (): PluginActiveSession | null => {
    if (!selection) return null;
    const turnId = getActiveTurn(selection.sessionId);
    const started = turnStarts.get(selection.sessionId);
    return {
      sessionId: selection.sessionId,
      projectPath: selection.projectPath,
      activeTurn:
        turnId && started?.turnId === turnId
          ? { turnId, startedAt: started.startedAt }
          : null,
    };
  };

  const publish = (): void => {
    const next = snapshot();
    const key = JSON.stringify(next);
    if (key === announced) return;
    announced = key;
    try {
      announce("session:activated", next);
    } catch (error) {
      // Delivery is best-effort by contract: a surface that is gone must not
      // break the others, and the whole fan-out is the caller's responsibility,
      // so this only records that the snapshot reached nobody.
      log?.("session activated announce failed", {
        sessionId: next?.sessionId ?? null,
        data: String(error),
      });
    }
  };

  return {
    /** The current snapshot, for `pi.session.getActive` and stale checks. */
    snapshot,
    /**
     * The renderer reported a different selection, or none. Keeping the start
     * times of turns it already reported is deliberate: switching away and back
     * must not reset the running turn's duration.
     */
    setActiveSession(next: PluginActiveSessionSelection | null): void {
      const sessionId = String(next?.sessionId ?? "").trim();
      const projectPath = String(next?.projectPath ?? "").trim() || null;
      selection = sessionId ? { sessionId, projectPath } : null;
      publish();
    },
    /**
     * A host turn opened for this session: date it so the snapshot can report
     * it whenever the user switches to that session.
     */
    noteTurnStarted(sessionId: string, turnId: string): void {
      const id = String(sessionId ?? "").trim();
      const turn = String(turnId ?? "").trim();
      if (!id || !turn) return;
      turnStarts.set(id, { turnId: turn, startedAt: now() });
      // Only the selected session can change the snapshot, so no other session
      // needs an announcement — but every session needs a bounded map, because
      // a turn that ends without a notice never reports its end.
      enforceBound(turnStarts, MAX_TRACKED_SESSIONS);
      if (selection?.sessionId === id) publish();
    },
    /** That turn reached a terminal state, so the session is idle again. */
    noteTurnEnded(sessionId: string, turnId: string): void {
      const id = String(sessionId ?? "").trim();
      const turn = String(turnId ?? "").trim();
      if (turnStarts.get(id)?.turnId === turn) turnStarts.delete(id);
      if (selection?.sessionId === id) publish();
    },
  };
}
