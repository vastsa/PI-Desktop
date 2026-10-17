import type {
  RacpProjectSummary, RacpSession, RemoteHostCreateSessionRequest, SessionSummary, RemoteHostBrowseProjectsResult,
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
    async browseProjects(hostKey: string, path?: string): Promise<RemoteHostBrowseProjectsResult> {
      const host = requireHost(hostKey);
      const result = await host.client.request<unknown>("project/browse", path === undefined ? {} : { path });
      stillCurrent(host);
      return validateProjectBrowse(result);
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

/** Validate untrusted Host picker data before it crosses the renderer boundary. */
function validateProjectBrowse(value: unknown): RemoteHostBrowseProjectsResult {
  const invalid = (): never => {
    throw Object.assign(new Error("invalid remote project browse response"), { errorCode: "INVALID_ARGUMENT" });
  };
  const absolutePath = (path: unknown): path is string =>
    typeof path === "string" && path.startsWith("/") && path.length <= 4096 && !/[\u0000-\u001f]/.test(path);
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (!absolutePath(result.path) || (result.parent !== undefined && !absolutePath(result.parent))
    || !Array.isArray(result.entries) || result.entries.length > 500) return invalid();
  const entries = result.entries.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const entry = value as Record<string, unknown>;
    if (typeof entry.name !== "string" || !entry.name || entry.name.length > 4096
      || /[\/\u0000-\u001f]/.test(entry.name) || entry.name === "." || entry.name === ".."
      || !absolutePath(entry.path)) return invalid();
    const prefix = result.path === "/" ? "/" : `${String(result.path).replace(/\/+$/, "")}/`;
    if (entry.path !== `${prefix}${entry.name}`) return invalid();
    return { name: entry.name, path: entry.path };
  });
  return { path: result.path, ...(typeof result.parent === "string" ? { parent: result.parent } : {}), entries };
}
