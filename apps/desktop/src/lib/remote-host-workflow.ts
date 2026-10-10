import type { ProviderPublic, RemoteHostSummary, RacpProjectSummary, SessionSummary, ProviderImportSummary } from "@pi-desktop/shared";
import { isSyncableProvider } from "@pi-desktop/shared";
import { api } from "./api";
import { safeSessionSummary } from "./remote-session-safety";

export type RemoteHostView = {
  busy: boolean;
  error: string | null;
  projects: RacpProjectSummary[];
  sessions: SessionSummary[];
  syncResult: ProviderImportSummary | null;
};

/** One host-owned workflow. Disposal invalidates reads and never replays mutations. */
export function createRemoteHostWorkflow(
  host: RemoteHostSummary,
  select: (session: SessionSummary) => Promise<void>,
) {
  let disposed = false;
  let generation = 0;
  let view: RemoteHostView = { busy: false, error: null, projects: [], sessions: [], syncResult: null };
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
    const [projects, sessions] = await Promise.all([
      api.remoteHostProjects(host.hostKey), api.remoteHostSessions(host.hostKey),
    ]);
    if (current()) publish({
      projects: projects.projects.filter((project) => !project.archived),
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
    create: (input: { projectId: string; path: string; title: string }) => run(async (current) => {
      const path = input.path.trim();
      let projectId = input.projectId;
      if (path) {
        // Linux/macOS SSH roots only in the MVP; never resolve against Desktop cwd.
        if (!path.startsWith("/") || path.includes("\0")) throw new Error("REMOTE_ABSOLUTE_PATH_REQUIRED");
        const result = await api.registerRemoteProject(host.hostKey, path);
        if (!current()) return;
        projectId = result.project.id;
        publish({ projects: [...view.projects.filter((project) => project.id !== projectId), result.project] });
      } else if (!view.projects.some((project) => project.id === projectId)) {
        throw new Error("REMOTE_PROJECT_REQUIRED");
      }
      const result = await api.createRemoteSession({
        hostKey: host.hostKey, projectId, mode: "agent", permissionMode: "ask",
        ...(input.title.trim() ? { title: input.title.trim() } : {}),
      });
      if (!current()) return;
      const session = safeSessionSummary(result.session);
      publish({ sessions: [session, ...view.sessions.filter((item) => item.id !== session.id)] });
      await select(session);
    }),
    sync: (providers: ProviderPublic[], selected: string[], consent: boolean, setDefault: boolean) => run(async (current) => {
      const eligible = new Set(providers.filter(isSyncableProvider).map((provider) => provider.id));
      if (host.transport !== "ssh" || !consent || selected.length === 0 || selected.some((id) => !eligible.has(id))) {
        throw new Error("REMOTE_SYNC_CONSENT_REQUIRED");
      }
      const result = await api.syncRemoteProviders({ hostKey: host.hostKey, providerIds: [...new Set(selected)], setDefault });
      if (current()) publish({ syncResult: result });
    }),
  };
}
