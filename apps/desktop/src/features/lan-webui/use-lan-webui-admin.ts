import { useCallback, useEffect, useRef, useState } from "react";
import { IPC, type LanAdminAction, type LanAdminView } from "@pi-desktop/shared";
import { api } from "../../lib/api";

const RUNNING_REFRESH_MS = 30_000;
export const LAN_DEFAULT_PORT = 37180;

/** Read live state without letting a refresh replace an action's result. */
export function useLanWebUiAdmin() {
  const [view, setView] = useState<LanAdminView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const active = useRef(false);
  const generation = useRef(0);
  const acting = useRef(false);
  const refreshQueued = useRef(false);

  const refresh = useCallback(() => {
    if (acting.current) {
      refreshQueued.current = true;
      return;
    }
    const ticket = ++generation.current;
    void api.lanWebUiAdmin({ kind: "state" }).then(
      (next) => {
        if (!active.current || ticket !== generation.current) return;
        setView(next);
        setLoadFailed(false);
        if (next.error) setError(next.error);
      },
      () => {
        if (active.current && ticket === generation.current) setLoadFailed(true);
      },
    );
  }, []);

  useEffect(() => {
    active.current = true;
    const off = window.piDesktop?.on?.(IPC.event.lanWebUiChanged, refresh);
    refresh();
    return () => {
      active.current = false;
      generation.current += 1;
      off?.();
    };
  }, [refresh]);

  const running = view?.running === true;
  useEffect(() => {
    if (!running) return;
    // Keep relative activity times and expired requests fresh without fast polling.
    const timer = setInterval(refresh, RUNNING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  const run = useCallback(async (action: LanAdminAction) => {
    if (acting.current || !active.current) return false;
    acting.current = true;
    const ticket = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const next = await api.lanWebUiAdmin(action);
      if (!active.current || ticket !== generation.current) return false;
      setView(next);
      setLoadFailed(false);
      setError(next.error);
      return next.error === null;
    } catch {
      if (active.current && ticket === generation.current) setError("FAILED");
      return false;
    } finally {
      acting.current = false;
      if (active.current) {
        setBusy(false);
        if (refreshQueued.current) {
          refreshQueued.current = false;
          refresh();
        }
      }
    }
  }, [refresh]);

  const clearError = () => setError(null);
  return { view, busy, error, loadFailed, run, refresh, clearError };
}

export function useCountdown(expiresAt: number | undefined): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!expiresAt) return;
    const start = Date.now();
    setNow(start);
    if (start >= expiresAt) return;
    const timer = setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      if (tick >= expiresAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;
}
