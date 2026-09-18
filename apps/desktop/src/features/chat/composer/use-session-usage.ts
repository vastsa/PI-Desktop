import { useEffect, useState } from "react";
import type { SessionUsageTotals } from "@pi-desktop/shared";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";

/**
 * Totals together with the session they were read for: a sum read for one
 * session must never be shown against another one.
 */
type CachedSessionUsage = {
  sessionId: string;
  totals: SessionUsageTotals | undefined;
};

/**
 * The session's own completed-turn token totals (D449).
 *
 * The transcript is a paged window, so the renderer cannot sum its way to a
 * session total; the host aggregates the turns table for the whole session
 * instead. That total only moves when a turn finishes, so this refreshes when
 * the active session changes and once the run is idle again.
 */
export function useSessionUsage(): SessionUsageTotals | undefined {
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const isRunning = useAppStore((state) => state.isRunning);
  const messageCount = useAppStore((state) => state.messages.length);
  const [cached, setCached] = useState<CachedSessionUsage | undefined>(undefined);

  useEffect(() => {
    if (!activeSessionId || isRunning) return;
    let cancelled = false;
    void api
      .getSessionUsage(activeSessionId)
      .then((next) => {
        if (!cancelled) {
          setCached({ sessionId: activeSessionId, totals: next ?? undefined });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCached({ sessionId: activeSessionId, totals: undefined });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, isRunning, messageCount]);

  // The effect returns early while the run is live, so the cache outlives a
  // switch to a session that is still running: only the totals read for the
  // session on screen may be shown, and the rest reads as "not loaded yet".
  return cached && cached.sessionId === activeSessionId ? cached.totals : undefined;
}
