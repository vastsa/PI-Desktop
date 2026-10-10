/** Paired Host lifecycle. Persistence stays in the encrypted registry; session
 * projection and transport recovery live in their own domain modules. */
import {
  IPC,
  type RacpEventEnvelope, type RacpItemSummary, type RacpProjectSummary, type RacpSession,
  type RemoteHostBootstrapRequest, type RemoteHostBootstrapResult,
  type RemoteHostCreateSessionRequest, type RemoteHostSummary,
  type RemoteHostSyncProvidersRequest, type RemoteHostSyncProvidersResult, type SessionSummary,
} from "@pi-desktop/shared";
import { wsClientTransport } from "@pi-desktop/racp";
import type { HostRpcPort } from "@pi-desktop/agent-host";
import type { BackendRouter } from "../remote/backend-router.js";
import { makeRemoteSessionId, parseRemoteSessionId } from "../remote/backend-router.js";
import { createRacpRemoteHostClient, exchangePairingToken, type RacpRemoteHostClient } from "../remote/racp-remote-host-client.js";
import { createSshBootstrap, type SshBootstrapDeps } from "../remote/ssh-bootstrap.js";
import { createSshTunnelManager, type SshTunnelManager } from "../remote/ssh-tunnel.js";
import { createRemoteHostConnection, type RemoteHostConnection } from "../remote/remote-host-connection.js";
import { createRemoteHostRegistry, type EncryptionPort, type RemoteHostRecord, type RemoteHostRegistry } from "../remote/remote-host-registry.js";
import { sshMetadataOf, sshHostRecord, transportOf } from "../remote/remote-host-metadata.js";
import { createRemoteSessionCatalog } from "../remote/remote-session-catalog.js";
import { syncRemoteProviders } from "../remote/remote-provider-transfer.js";
export { sshMetadataOf, sshHostRecord, transportOf } from "../remote/remote-host-metadata.js";
export type { RemoteHostSummary };

export type RemoteHostAdapterFactory = (record: RemoteHostRecord) => RacpRemoteHostClient;
export type BootRemoteHostsOptions = {
  dataDir: string;
  encryption: EncryptionPort;
  router: BackendRouter;
  emit: (channel: string, payload: unknown) => void;
  clientInfo: { name: string; version: string };
  getLocalHost?: () => HostRpcPort | null;
  buildAdapter?: RemoteHostAdapterFactory;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  tunnels?: SshTunnelManager;
  sshBootstrap?: Partial<SshBootstrapDeps>;
};
export type RemoteLiveSessionSummary = Pick<RacpSession, "id" | "title" | "mode" | "permissionMode" | "status" | "activeTurnId" | "workspaceLabel"> & {
  source: "remote"; hostKey: string; hostLabel: string;
};
export interface RemoteHostsBoot {
  open(): Promise<number>;
  listSessions(): Promise<RemoteLiveSessionSummary[]>;
  readHistory(sessionId: string, limit: number): Promise<RacpItemSummary[]>;
  subscribeSession(sessionId: string, listener: (envelope: RacpEventEnvelope) => void): (() => void) | null;
  closeAll(): Promise<void>;
  list(): Promise<RemoteHostSummary[]>;
  addHost(record: RemoteHostRecord): Promise<RemoteHostSummary>;
  bootstrapHost(request: RemoteHostBootstrapRequest): Promise<RemoteHostBootstrapResult>;
  reconnectHost(hostKey: string): Promise<RemoteHostSummary>;
  removeHost(hostKey: string): Promise<void>;
  sessionSummaries(): SessionSummary[];
  sessions(hostKey: string): Promise<SessionSummary[]>;
  projects(hostKey: string): Promise<RacpProjectSummary[]>;
  registerProject(hostKey: string, path: string): Promise<RacpProjectSummary & { path?: string }>;
  createSession(request: RemoteHostCreateSessionRequest): Promise<SessionSummary>;
  syncProviders(request: RemoteHostSyncProvidersRequest): Promise<RemoteHostSyncProvidersResult>;
  readonly registry: RemoteHostRegistry;
}
let activeRemoteHostsBoot: RemoteHostsBoot | null = null;
export function setActiveRemoteHostsBoot(boot: RemoteHostsBoot | null): void { activeRemoteHostsBoot = boot; }
export function getActiveRemoteHostsBoot(): RemoteHostsBoot | null { return activeRemoteHostsBoot; }

type OpenHost = {
  hostKey: string; label: string; url: string;
  adapter: RacpRemoteHostClient; connection: RemoteHostConnection;
};
function unavailable(): Error {
  return Object.assign(new Error("remote host is unavailable"), { errorCode: "AGENT_UNAVAILABLE" });
}

export function createRemoteHostsBoot(options: BootRemoteHostsOptions): RemoteHostsBoot {
  const log = options.log ?? (() => undefined);
  const registry = createRemoteHostRegistry({ dataDir: options.dataDir, encryption: options.encryption, log });
  const tunnels = options.tunnels ?? createSshTunnelManager({ log });
  const opened = new Map<string, OpenHost>();
  const openingHosts = new Set<OpenHost>();
  const hostClosings = new WeakMap<OpenHost, Promise<void>>();
  const operations = new Map<string, Promise<unknown>>();
  let closed = false;
  let opening: Promise<number> | undefined;
  let closing: Promise<void> | undefined;
  const assertOpen = () => { if (closed) throw unavailable(); };
  const connectedHost = (key: string) => {
    const host = opened.get(key);
    return host?.adapter.state() === "connected" ? host : undefined;
  };
  const catalog = createRemoteSessionCatalog({
    getHost: (key) => {
      const host = connectedHost(key);
      return host ? { hostKey: key, label: host.label, client: host.adapter.client, connection: host.connection } : undefined;
    },
  });
  const changed = () => options.emit(IPC.event.sessionsChanged, { reason: "remote.host.changed" });
  const refresh = async (key: string) => {
    try { await catalog.sessions(key); }
    catch (error) { log("warn", `remote host ${key} session refresh failed`, { error: String(error) }); }
    if (!closed) changed();
  };
  function serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = operations.get(key);
    const task = (async () => {
      if (previous) await previous.catch(() => undefined);
      assertOpen();
      return action();
    })();
    operations.set(key, task);
    void task.finally(() => { if (operations.get(key) === task) operations.delete(key); }).catch(() => undefined);
    return task;
  }
  const buildAdapter = options.buildAdapter ?? ((record: RemoteHostRecord) => {
    let first = true;
    const ssh = sshMetadataOf(record);
    return createRacpRemoteHostClient({
      transport: async () => {
        assertOpen();
        let url = record.url;
        if (!first && ssh) {
          // A broken forward is not reusable, even when the ssh process has
          // not emitted exit yet. Reopen it before reconnecting the WebSocket.
          await tunnels.close(record.hostKey);
          assertOpen();
          url = (await tunnels.open(record.hostKey, ssh, record.sshSecret)).url;
          assertOpen();
          const live = opened.get(record.hostKey);
          if (live) live.url = url;
        }
        first = false;
        return wsClientTransport({ url, token: record.deviceToken })();
      },
      clientInfo: options.clientInfo,
      reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 15_000, maxAttempts: 10 },
      log,
    });
  });
  const bootstrap = createSshBootstrap({
    version: options.clientInfo.version,
    exchangePairing: ({ url, pairingToken, label }) => exchangePairingToken({ url, pairingToken, label, clientInfo: options.clientInfo, log }),
    log, ...options.sshBootstrap,
  });

  function closeHost(host: OpenHost): Promise<void> {
    const existing = hostClosings.get(host);
    if (existing) return existing;
    // Closing the adapter cancels connect/RPC waits, including subscription
    // cleanup. Start both owners before awaiting either one.
    const task = Promise.all([
      host.connection.close().catch((error: unknown) => log("warn", "remote connection close failed", { error: String(error) })),
      host.adapter.close().catch((error: unknown) => log("warn", "remote adapter close failed", { error: String(error) })),
      tunnels.close(host.hostKey),
    ]).then(() => undefined);
    hostClosings.set(host, task);
    return task;
  }
  async function closeLive(key: string): Promise<void> {
    const host = opened.get(key);
    opened.delete(key);
    if (host) await closeHost(host);
  }
  async function openHost(record: RemoteHostRecord): Promise<OpenHost> {
    assertOpen();
    const ssh = sshMetadataOf(record);
    if (record.metadata?.transport === "ssh" && !ssh) {
      throw Object.assign(new Error("invalid SSH host metadata"), { errorCode: "INVALID_ARGUMENT" });
    }
    const url = ssh ? (await tunnels.open(record.hostKey, ssh, record.sshSecret)).url : record.url;
    if (closed) { await tunnels.close(record.hostKey); throw unavailable(); }
    const adapter = buildAdapter({ ...record, url });
    const connection = createRemoteHostConnection({
      hostKey: record.hostKey, hostLabel: record.label, client: adapter.client, router: options.router,
      emit: (channel, payload) => {
        if (closed) return;
        if (channel === IPC.event.sessionsChanged) void refresh(record.hostKey);
        else options.emit(channel, payload);
      },
      log,
    });
    const live = { hostKey: record.hostKey, label: record.label, adapter, connection, url };
    openingHosts.add(live);
    try {
      assertOpen();
      await adapter.connect();
      assertOpen();
      await connection.open();
      assertOpen();
      opened.set(record.hostKey, live);
      await refresh(record.hostKey);
      assertOpen();
      return live;
    } catch (error) {
      if (opened.get(record.hostKey) === live) opened.delete(record.hostKey);
      await closeHost(live);
      throw error;
    } finally {
      openingHosts.delete(live);
    }
  }
  function summaryOf(record: RemoteHostRecord): RemoteHostSummary {
    return { hostKey: record.hostKey, label: record.label, url: opened.get(record.hostKey)?.url ?? record.url,
      connected: Boolean(connectedHost(record.hostKey)), transport: transportOf(record) };
  }
  async function addRecord(record: RemoteHostRecord): Promise<RemoteHostSummary> {
    assertOpen();
    await registry.upsert(record);
    await closeLive(record.hostKey);
    try { await openHost(record); }
    catch (error) {
      if (closed) throw error;
      log("warn", `remote host ${record.hostKey} paired but failed to open`, { error: String(error) });
    }
    return summaryOf(record);
  }

  return {
    registry,
    open() {
      if (opening) return opening;
      opening = (async () => {
        assertOpen();
        const records = await registry.list();
        assertOpen();
        let successes = 0;
        for (const record of records) {
          if (closed) break;
          try {
            await serial(record.hostKey, async () => {
              if (!opened.has(record.hostKey)) await openHost(record);
            });
            successes++;
          } catch (error) {
            if (closed) throw error;
            log("warn", `remote host ${record.hostKey} failed to open; leaving it disconnected`, { error: String(error) });
          }
        }
        return successes;
      })();
      return opening;
    },
    closeAll() {
      if (closing) return closing;
      closed = true;
      const hosts = new Set([...opened.values(), ...openingHosts]);
      opened.clear();
      closing = (async () => {
        const cleanup = [...hosts].map(closeHost);
        // Forward creation is itself an operation we must cancel, not await
        // before disposal. The same fence prevents all late registrations.
        const disposal = tunnels.dispose();
        await Promise.allSettled([...cleanup, disposal, ...operations.values()]);
        await disposal;
      })();
      return closing;
    },
    async list() { return (await registry.list()).map(summaryOf); },
    sessionSummaries: () => catalog.summaries(),
    sessions: catalog.sessions,
    projects: catalog.projects,
    registerProject: catalog.registerProject,
    async createSession(input) {
      const session = await catalog.createSession(input);
      changed();
      return session;
    },
    syncProviders(input) {
      return serial(input.hostKey, async () => {
        if (!connectedHost(input.hostKey)) throw unavailable();
        const record = (await registry.list()).find((item) => item.hostKey === input.hostKey);
        if (!record) throw unavailable();
        const host = options.getLocalHost?.();
        if (!host) throw unavailable();
        return syncRemoteProviders(input, record, host);
      });
    },
    addHost: (record) => serial(record.hostKey, () => addRecord(record)),
    reconnectHost: (key) => serial(key, async () => {
      const record = (await registry.list()).find((item) => item.hostKey === key);
      if (!record) throw unavailable();
      await closeLive(key);
      await tunnels.close(key);
      await openHost(record);
      return summaryOf(record);
    }),
    async bootstrapHost(request) {
      assertOpen();
      const outcome = await bootstrap.bootstrap(request);
      let adopted = false;
      try {
        return await serial(outcome.hostKey, async () => {
          await closeLive(outcome.hostKey);
          assertOpen();
          await tunnels.adopt(outcome.hostKey, outcome.ssh, outcome.forward);
          adopted = true;
          try {
            assertOpen();
            const host = await addRecord(sshHostRecord(outcome));
            return { host, ssh: outcome.ssh, steps: outcome.steps };
          } catch (error) {
            await tunnels.close(outcome.hostKey);
            throw error;
          }
        });
      } finally {
        // serial can reject before invoking the action; until adopt succeeds
        // this call, not the tunnel manager, still owns the bootstrap forward.
        if (!adopted) await outcome.forward.close();
      }
    },
    removeHost: (key) => serial(key, async () => {
      await closeLive(key);
      await tunnels.close(key);
      await registry.remove(key);
      catalog.forget(key);
      changed();
    }),
    async listSessions() {
      const results = await Promise.all([...opened.values()].map(async (host) => {
        if (!connectedHost(host.hostKey)) return [];
        try {
          const result = await host.adapter.client.request<{ sessions: RacpSession[] }>("session/list");
          if (connectedHost(host.hostKey) !== host) return [];
          return result.sessions.map((session): RemoteLiveSessionSummary => ({
            id: makeRemoteSessionId(host.hostKey, session.id), title: session.title,
            mode: session.mode, permissionMode: session.permissionMode, status: session.status,
            ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}),
            ...(session.workspaceLabel ? { workspaceLabel: session.workspaceLabel } : {}),
            source: "remote", hostKey: host.hostKey, hostLabel: host.label,
          }));
        } catch (error) {
          log("warn", `remote host ${host.hostKey} session list failed`, { error: String(error) });
          return [];
        }
      }));
      return results.flat();
    },
    async readHistory(sessionId, limit) {
      const parsed = parseRemoteSessionId(sessionId);
      const host = parsed ? connectedHost(parsed.hostKey) : undefined;
      if (!parsed || !host) throw Object.assign(new Error("Remote session is unavailable"), { errorCode: "LIVE_WORK_SESSION_UNAVAILABLE" });
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24) throw Object.assign(new Error("Remote history limit is invalid"), { errorCode: "INVALID_ARGUMENT" });
      const result = await host.adapter.client.request<{ items?: RacpItemSummary[] }>("session/history", { sessionId: parsed.hostSessionId, limit });
      return result.items ?? [];
    },
    subscribeSession(sessionId, listener) {
      const parsed = parseRemoteSessionId(sessionId);
      const host = parsed ? connectedHost(parsed.hostKey) : undefined;
      if (!parsed || !host) return null;
      return host.adapter.client.subscribe((envelope) => {
        if (envelope.scope === "session" && envelope.sessionId === parsed.hostSessionId) listener(envelope);
      });
    },
  };
}
