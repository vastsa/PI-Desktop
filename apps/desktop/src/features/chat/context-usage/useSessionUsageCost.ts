import { useEffect, useState } from "react";
import type { SessionUsageCost } from "@pi-desktop/shared";
import { api } from "../../../lib/api";

export type SessionUsageCostState =
  | { status: "loading"; data?: undefined }
  | { status: "error"; data?: undefined }
  | { status: "ready"; data: SessionUsageCost };

type Loaded = { sessionId: string; key: string; state: SessionUsageCostState };

/**
 * Reads the host's whole-session cost rollup while `enabled`. The renderer
 * holds only a window of the transcript, so summing loaded messages would
 * undercount long sessions. `refreshKey` changes whenever a request may have
 * been billed; the previous figure stays visible until the refresh lands so
 * the value does not flicker during a run. Results for an older session or
 * key are dropped.
 */
export function useSessionUsageCost({
  enabled,
  sessionId,
  refreshKey,
  load = api.getSessionUsageCost,
}: {
  enabled: boolean;
  sessionId?: string;
  refreshKey: string;
  load?: (sessionId: string) => Promise<SessionUsageCost>;
}): SessionUsageCostState | undefined {
  const [loaded, setLoaded] = useState<Loaded>();

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let current = true;
    load(sessionId).then(
      (data) => {
        if (current) setLoaded({ sessionId, key: refreshKey, state: { status: "ready", data } });
      },
      () => {
        if (current) setLoaded({ sessionId, key: refreshKey, state: { status: "error" } });
      },
    );
    return () => {
      current = false;
    };
  }, [enabled, load, refreshKey, sessionId]);

  if (!enabled || !sessionId) return undefined;
  if (loaded?.sessionId !== sessionId) return { status: "loading" };
  // A stale ready figure beats a spinner; a stale error is retried silently.
  if (loaded.key !== refreshKey && loaded.state.status !== "ready") return { status: "loading" };
  return loaded.state;
}
