import type { RemoteHostSummary, SessionSummary } from "@pi-desktop/shared";
import { api } from "./api";
import { safeSessionSummary } from "./remote-session-safety";

export type RemoteHostView = {
  busy: boolean;
  error: string | null;
  sessions: SessionSummary[];
};

/** One host-owned workflow. Disposal invalidates reads and never replays mutations. */
export function createRemoteHostWorkflow(
  host: RemoteHostSummary,
  select: (session: SessionSummary) => Promise<void>,
) {
  let disposed = false;
  let generation = 0;
  let view: RemoteHostView = { busy: false, error: null, sessions: [] };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<RemoteHostView>) => {
    if (disposed) return;
    view = { ...view, ...patch };
    for (const listener of listeners) listener();
  };
  const run = async (operation: (current: () => boolean) => Promise<void>) => {
    if (disposed || view.busy) return;
    const request = ++generation;
    const current = () => !disposed && generation === request;
    publish({ busy: true, error: null });
    try { await operation(current); }
    catch (error) {
      if (current()) publish({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (current()) publish({ busy: false });
    }
  };
  const read = async (current: () => boolean) => {
    const sessions = await api.remoteHostSessions(host.hostKey);
    if (current()) publish({
      sessions: sessions.sessions.map(safeSessionSummary),
    });
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    start() { disposed = false; publish({ busy: false }); return run(read); },
    dispose() { disposed = true; generation++; listeners.clear(); },
    load: () => run(read),
    reconnect: () => run(async (current) => {
      await api.reconnectRemoteHost(host.hostKey);
      if (current()) await read(current);
    }),
    open: (session: SessionSummary) => run(async (current) => {
      if (current()) await select(safeSessionSummary(session));
    }),
  };
}
