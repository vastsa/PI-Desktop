import { useEffect, useState } from "react";
import type { UpdateState } from "@pi-desktop/shared";
import { api } from "./api";

/**
 * Live view of the app-update state: seeds from the main process snapshot,
 * then follows `updatesState` push events. Null until the bridge answers
 * (or forever in browser-only harnesses without a preload).
 */
export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    let mounted = true;
    api
      .updatesGetState()
      .then((snapshot) => {
        if (mounted) setState((current) => current ?? snapshot);
      })
      .catch(() => undefined);
    const off = api.onUpdateState((next) => setState(next));
    return () => {
      mounted = false;
      off();
    };
  }, []);

  return state;
}
