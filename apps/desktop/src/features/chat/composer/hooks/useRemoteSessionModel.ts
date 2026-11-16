/**
 * Everything the Composer needs from a paired Host for one remote session: the
 * Host's own model catalog, and the newest physical request's context occupancy.
 *
 * Both are Host-owned facts. The renderer never reads them from its local
 * provider store, because a remote session runs on another machine's providers
 * and the local catalog would name models that Host cannot serve. Loads are
 * fenced per session/host so a switch mid-await cannot paint stale rows.
 */
import { useEffect, useMemo, useState } from "react";
import type { RacpSessionUsage, SessionSummary } from "@pi-desktop/shared";
import { api } from "../../../../lib/api";
import {
  EMPTY_REMOTE_MODEL_CATALOG,
  remoteContextWindow,
  remoteModelCatalog,
  type RemoteModelCatalog,
} from "../../../../lib/remote-host-models";
import type { LatestTurnContextInspector } from "../../../../lib/latest-turn-context";

export type RemoteModelCatalogState = RemoteModelCatalog & {
  /** A load finished for the current host, whether or not it returned rows. */
  loaded: boolean;
  error: Error | undefined;
};

const EMPTY: RemoteModelCatalogState = {
  ...EMPTY_REMOTE_MODEL_CATALOG,
  loaded: false,
  error: undefined,
};

/** The Host's model catalog, or an empty catalog when the session is local. */
export function useRemoteModelCatalog(hostKey: string | undefined): RemoteModelCatalogState {
  const [state, setState] = useState<RemoteModelCatalogState>(EMPTY);
  useEffect(() => {
    if (!hostKey) {
      setState(EMPTY);
      return;
    }
    let live = true;
    setState(EMPTY);
    void (async () => {
      try {
        const result = await api.remoteHostModels(hostKey);
        if (live) setState({ ...remoteModelCatalog(result.models), loaded: true, error: undefined });
      } catch (caught) {
        if (live) {
          setState({
            ...EMPTY_REMOTE_MODEL_CATALOG,
            loaded: true,
            error: caught instanceof Error ? caught : new Error(String(caught)),
          });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [hostKey]);
  return state;
}

/**
 * The Host's newest completed request, as a composer inspector.
 *
 * A remote transcript carries usage only on nested tool operations, never the
 * top-level assistant row, so the local projection reports nothing for a remote
 * session. The Host answers instead, and its window travels with the figure.
 */
export function useRemoteSessionUsage(
  session: Pick<SessionSummary, "id" | "updatedAt"> | undefined,
  running: boolean,
): LatestTurnContextInspector | undefined {
  const sessionId = session?.id;
  // A turn's end republishes the session, which moves `updatedAt`; a stop that
  // ends without a new request still flips `running` back.
  const revision = session?.updatedAt;
  const [usage, setUsage] = useState<RacpSessionUsage | undefined>(undefined);
  useEffect(() => {
    if (!sessionId) {
      setUsage(undefined);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const result = await api.remoteSessionUsage(sessionId);
        if (live) setUsage(result.usage);
      } catch {
        // A Host that predates `session/usage`, or one that is momentarily
        // unreachable, simply leaves the ring off. It is display state.
        if (live) setUsage(undefined);
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionId, revision, running]);

  return useMemo(() => {
    if (!sessionId || !usage?.usage) return undefined;
    const contextWindow = remoteContextWindow(usage);
    return {
      usage: usage.usage,
      turnUsage: usage.usage,
      // The Host's window is authoritative for its own provider; the generic
      // fallback only keeps the ring drawable when it publishes none.
      contextWindow: contextWindow ?? 0,
      ...(contextWindow === undefined ? { contextWindowEstimated: true } : {}),
      tools: [],
      responseOutputEstimated: false,
    } satisfies LatestTurnContextInspector;
  }, [sessionId, usage]);
}
