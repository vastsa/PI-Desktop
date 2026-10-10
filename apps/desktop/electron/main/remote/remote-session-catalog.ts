import type {
  RacpProjectSummary, RacpSession, RemoteHostCreateSessionRequest, SessionSummary,
} from "@pi-desktop/shared";
import { makeRemoteSessionId } from "./backend-router.js";
import type { RemoteHostConnection } from "./remote-host-connection.js";
import type { RemoteRacpClient } from "./remote-backend.js";
import { racpSessionToSummary } from "./remote-transcript.js";

export type RemoteCatalogHost = {
  hostKey: string;
  label: string;
  client: RemoteRacpClient;
  connection: Pick<RemoteHostConnection, "ensureSession">;
};

function unavailable(): Error {
  return Object.assign(new Error("remote host is disconnected"), { errorCode: "AGENT_UNAVAILABLE" });
}

/** A session directory, not a second transcript store. Offline rows remain identifiable. */
export function createRemoteSessionCatalog(options: {
  getHost: (hostKey: string) => RemoteCatalogHost | undefined;
}) {
  const cache = new Map<string, SessionSummary[]>();
  const pending = new Map<string, Promise<SessionSummary[]>>();
  const requireHost = (hostKey: string) => {
    const host = options.getHost(hostKey);
    if (!host) throw unavailable();
    return host;
  };
  const stillCurrent = (host: RemoteCatalogHost) => {
    if (options.getHost(host.hostKey)?.client !== host.client) throw unavailable();
  };
  const summary = (host: RemoteCatalogHost, session: RacpSession) =>
    racpSessionToSummary(makeRemoteSessionId(host.hostKey, session.id), session, 0, host.label);

  async function sessions(hostKey: string): Promise<SessionSummary[]> {
    const existing = pending.get(hostKey);
    if (existing) return existing;
    const host = requireHost(hostKey);
    const task = (async () => {
      const result = await host.client.request<{ sessions: RacpSession[] }>("session/list");
      stillCurrent(host);
      const rows = result.sessions.map((session) => summary(host, session));
      cache.set(hostKey, rows);
      return rows;
    })();
    pending.set(hostKey, task);
    try { return await task; }
    finally { if (pending.get(hostKey) === task) pending.delete(hostKey); }
  }

  return {
    sessions,
    summaries(): SessionSummary[] {
      return [...cache.entries()].flatMap(([hostKey, rows]) => {
        const connected = Boolean(options.getHost(hostKey));
        return rows.map((row) => ({
          ...row,
          capabilities: { ...row.capabilities!, canPrompt: connected, canStop: connected, canRefresh: connected },
          ...(connected ? {} : { readOnlyReason: "REMOTE_HOST_DISCONNECTED" }),
        }));
      });
    },
    forget(hostKey: string) { cache.delete(hostKey); pending.delete(hostKey); },
    async projects(hostKey: string): Promise<RacpProjectSummary[]> {
      const host = requireHost(hostKey);
      const result = await host.client.request<{ projects: RacpProjectSummary[] }>("project/list");
      stillCurrent(host);
      return result.projects;
    },
    async registerProject(hostKey: string, path: string) {
      const host = requireHost(hostKey);
      const result = await host.client.request<{ project: RacpProjectSummary & { path?: string } }>("project/register", { path });
      stillCurrent(host);
      return result.project;
    },
    async createSession(input: RemoteHostCreateSessionRequest): Promise<SessionSummary> {
      const host = requireHost(input.hostKey);
      const result = await host.client.request<{ session: RacpSession }>("session/create", {
        projectId: input.projectId,
        ...(input.title ? { title: input.title } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      });
      stillCurrent(host);
      await host.connection.ensureSession(result.session.id);
      stillCurrent(host);
      const row = summary(host, result.session);
      cache.set(host.hostKey, [row, ...(cache.get(host.hostKey) ?? []).filter((entry) => entry.id !== row.id)]);
      return row;
    },
  };
}
