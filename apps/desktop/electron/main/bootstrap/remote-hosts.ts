/** Paired Host lifecycle. Persistence stays in the encrypted registry; session
 * projection and transport recovery live in their own domain modules. */
import {
  IPC,
  type RacpEventEnvelope, type RacpItemSummary, type RacpProjectSummary, type RacpSession,
  type RemoteHostBootstrapRequest, type RemoteHostBootstrapResult,
  type RemoteHostCreateSessionRequest, type RemoteHostSummary, type RemoteHostBrowseProjectsResult,
  type RemoteHostConnectionStatus, type RemoteHostSyncProvidersRequest, type RemoteHostSyncProvidersResult, type SessionSummary,
  type CommandShellOption, isCommandShellOption,
  type WorkspaceFilesRequest,
} from "@pi-desktop/shared";
import { wsClientTransport } from "@pi-desktop/racp";
import type { HostRpcPort } from "@pi-desktop/agent-host";
import type { BackendRouter } from "../remote/backend-router.js";
import { makeRemoteSessionId, parseRemoteSessionId } from "../remote/backend-router.js";
import { createRacpRemoteHostClient, exchangePairingToken, type RacpRemoteHostClient } from "../remote/racp-remote-host-client.js";
import { createRemoteHostRealigner, type RemoteHostRealignResult } from "../remote/remote-host-realign.js";
import { createSshBootstrap, type SshBootstrapDeps } from "../remote/ssh-bootstrap.js";
import { createSshTunnelManager, type SshTunnelManager } from "../remote/ssh-tunnel.js";
import { createRemoteHostConnection, type RemoteHostConnection } from "../remote/remote-host-connection.js";
import { createRemoteHostRegistry, type EncryptionPort, type RemoteHostRecord, type RemoteHostRegistry } from "../remote/remote-host-registry.js";
import { sshMetadataOf, sshHostRecord, transportOf } from "../remote/remote-host-metadata.js";
import { createRemoteSessionCatalog } from "../remote/remote-session-catalog.js";
import { syncRemoteProviders } from "../remote/remote-provider-transfer.js";
import { workspaceExecutionError } from "../remote/remote-workspace-outcome.js";
export { sshMetadataOf, sshHostRecord, transportOf } from "../remote/remote-host-metadata.js";
export type { RemoteHostSummary };

export type RemoteHostAdapterFactory = (record: RemoteHostRecord) => RacpRemoteHostClient;
export type RemoteWorkspaceToolInput = {
  hostKey: string; path: string; sessionId: string; turnId: string;
  toolCallId: string; toolName: string; args: unknown; timeoutMs?: number;
  expectedCommandShellId?: string; expectedCommandShellDialect?: string;
};
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
  ensureReady(hostKey: string): Promise<RemoteHostSummary>;
  removeHost(hostKey: string): Promise<void>;
  sessionSummaries(): SessionSummary[];
  sessions(hostKey: string): Promise<SessionSummary[]>;
  projects(hostKey: string): Promise<RacpProjectSummary[]>;
  browseProjects(hostKey: string, path?: string): Promise<RemoteHostBrowseProjectsResult>;
  registerProject(hostKey: string, path: string): Promise<RacpProjectSummary & { path?: string }>;
  createSession(request: RemoteHostCreateSessionRequest): Promise<SessionSummary>;
  syncProviders(request: RemoteHostSyncProvidersRequest): Promise<RemoteHostSyncProvidersResult>;
  executeWorkspaceTool(request: RemoteWorkspaceToolInput): Promise<unknown>;
  abortWorkspaceTool(request: { hostKey: string; sessionId: string; toolCallId: string }): Promise<void>;
  workspaceCommandShell(hostKey: string): Promise<CommandShellOption>;
  workspaceFiles(hostKey: string, input: WorkspaceFilesRequest): Promise<unknown>;
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

function requiresUserAction(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const fields = error as { errorCode?: string; code?: string };
  return ["HOST_AUTH_FAILED", "REMOTE_AUTH_FAILED", "HOST_VERSION_MISMATCH", "CAPABILITY_UNAVAILABLE"]
    .includes(fields.errorCode ?? fields.code ?? "");
}

/** The one failure that a version realignment can fix (ADR 0327). */
function isHostVersionMismatch(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const fields = error as { errorCode?: string; code?: string };
  return (fields.errorCode ?? fields.code ?? "") === "HOST_VERSION_MISMATCH";
}

/**
 * A paired Host can run the right release and still predate the additive
 * workspace services a remote project needs — the bundle is reused by release
 * receipt, not by the capabilities it happens to contain. The handshake is the
 * only place that is observable, so it is checked once per connect rather than
 * on every `workspace/*` call. Adapters that report no capabilities (tests,
 * legacy callers) are left alone.
 */
function assertWorkspaceCapabilities(adapter: RacpRemoteHostClient): void {
  const capabilities = adapter.workspaceCapabilities?.();
  if (!capabilities || (capabilities.workspaceTools && capabilities.workspaceFiles)) return;
  throw Object.assign(
    new Error("the remote Host predates the workspace tools and files this Desktop release requires"),
    { errorCode: "HOST_VERSION_MISMATCH", retriable: false },
  );
}

export function createRemoteHostsBoot(options: BootRemoteHostsOptions): RemoteHostsBoot {
  const log = options.log ?? (() => undefined);
  const registry = createRemoteHostRegistry({ dataDir: options.dataDir, encryption: options.encryption, log });
  const tunnels = options.tunnels ?? createSshTunnelManager({ log });
  const opened = new Map<string, OpenHost>();
  const actionRequired = new Set<string>();
  const openingHosts = new Set<OpenHost>();
  const hostClosings = new WeakMap<OpenHost, Promise<void>>();
  const operations = new Map<string, Promise<unknown>>();
  const readiness = new Map<string, Promise<RemoteHostSummary>>();
  const bootstraps = new Map<AbortController, Promise<unknown>>();
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
      expectedHostId: ssh?.hostId,
      onStateChange: () => { if (!closed) changed(); },
      clientInfo: options.clientInfo,
      reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 15_000, maxAttempts: 10 },
      log,
    });
  });
  const bootstrap = createSshBootstrap({
    version: options.clientInfo.version,
    exchangePairing: ({ url, pairingToken, label, expectedHostId }) => exchangePairingToken({ url, pairingToken, label, expectedHostId, clientInfo: options.clientInfo, requireWorkspace: true, log }),
    log, ...options.sshBootstrap,
  });

  /**
   * Re-provision one paired Host onto this desktop's release, in place. It
   * reuses the verified bootstrap the pairing path uses, so the artifact must
   * still match the published SHA-256 and pass the installed manifest check;
   * only the trigger differs (ADR 0327).
   */
  const realigner = createRemoteHostRealigner({
    version: options.clientInfo.version,
    bootstrap: (request, execOptions) => bootstrap.bootstrap(request, execOptions),
    upsert: (record) => registry.upsert(record),
    log,
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
  async function openHostOnce(record: RemoteHostRecord): Promise<OpenHost> {
    assertOpen();
    const ssh = sshMetadataOf(record);
    if (record.metadata?.transport === "ssh" && !ssh) {
      throw Object.assign(new Error("invalid SSH host metadata"), { errorCode: "INVALID_ARGUMENT" });
    }
    // Readiness compares the running Host against the release this desktop
    // expects, not the version recorded at pairing time: a stale descriptor
    // must not mask a Host that is behind, which is the case realignment
    // repairs.
    const expected = ssh ? { ...ssh, version: options.clientInfo.version } : undefined;
    const url = expected
      ? (await tunnels.open(record.hostKey, expected, record.sshSecret)).url
      : record.url;
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
      actionRequired.delete(record.hostKey);
      opened.set(record.hostKey, live);
      await adapter.connect();
      assertOpen();
      assertWorkspaceCapabilities(adapter);
      await connection.open();
      assertOpen();
      opened.set(record.hostKey, live);
      await refresh(record.hostKey);
      assertOpen();
      return live;
    } catch (error) {
      if (requiresUserAction(error)) actionRequired.add(record.hostKey);
      if (opened.get(record.hostKey) === live) opened.delete(record.hostKey);
      await closeHost(live);
      throw error;
    } finally {
      openingHosts.delete(live);
    }
  }

  /**
   * Re-provision a paired Host onto this desktop's release and re-pair it in
   * place. `force` is the user's explicit reconnect, which must not be silently
   * throttled. Returns the refreshed record, or `null` when the attempt was not
   * allowed or did not succeed.
   */
  async function realignHost(record: RemoteHostRecord, force: boolean): Promise<RemoteHostRecord | null> {
    const decision = realigner.decide(record, { force });
    if (decision !== "attempt") {
      log("info", "remote host realignment not attempted", {
        hostKey: record.hostKey, decision, version: options.clientInfo.version,
      });
      return null;
    }
    log("info", "remote host realignment started", {
      hostKey: record.hostKey, version: options.clientInfo.version,
    });
    assertOpen();
    await closeLive(record.hostKey);
    await tunnels.close(record.hostKey);
    assertOpen();
    const controller = new AbortController();
    const task = realigner.realign(record, { force, signal: controller.signal });
    bootstraps.set(controller, task);
    let result: RemoteHostRealignResult | null;
    try { result = await task; }
    finally { bootstraps.delete(controller); }
    if (!result) return null;
    try {
      assertOpen();
      await tunnels.adopt(record.hostKey, result.outcome.ssh, result.outcome.forward);
    } catch (error) {
      // `adopt` never took ownership, so this call still owns the forward.
      await result.outcome.forward.close().catch(() => undefined);
      throw error;
    }
    return result.record;
  }

  /**
   * Open one host, and when it is refused for its version, bring it up to this
   * release and open it again. A second failure is surfaced unchanged: a
   * realignment that cannot help must never hide the reason the user sees.
   */
  async function openHost(record: RemoteHostRecord, forceRealign = false): Promise<OpenHost> {
    try {
      return await openHostOnce(record);
    } catch (error) {
      if (closed || !isHostVersionMismatch(error)) throw error;
      const realigned = await realignHost(record, forceRealign);
      if (!realigned) throw error;
      return await openHostOnce(realigned);
    }
  }
  function summaryOf(record: RemoteHostRecord): RemoteHostSummary {
    const state = opened.get(record.hostKey)?.adapter.state();
    const status: RemoteHostConnectionStatus = state === "connected" || state === "connecting" || state === "reconnecting"
      ? state
      : state === "error" || actionRequired.has(record.hostKey) ? "action-required" : "disconnected";
    return { hostKey: record.hostKey, label: record.label, url: opened.get(record.hostKey)?.url ?? record.url,
      connected: status === "connected", status, transport: transportOf(record) };
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

  const ensureReady = (key: string): Promise<RemoteHostSummary> => {
    const pending = readiness.get(key);
    if (pending) return pending;
    const task = serial(key, async () => {
      const record = (await registry.list()).find((item) => item.hostKey === key);
      assertOpen();
      if (!record) throw unavailable();
      if (!connectedHost(key)) {
        await closeLive(key);
        assertOpen();
        await openHost(record);
      }
      return summaryOf(record);
    });
    readiness.set(key, task);
    void task.finally(() => { if (readiness.get(key) === task) readiness.delete(key); }).catch(() => undefined);
    return task;
  };

  return {
    registry,
    ensureReady,
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
      for (const controller of bootstraps.keys()) controller.abort();
      const hosts = new Set([...opened.values(), ...openingHosts]);
      opened.clear();
      closing = (async () => {
        const cleanup = [...hosts].map(closeHost);
        // Forward creation is itself an operation we must cancel, not await
        // before disposal. The same fence prevents all late registrations.
        const disposal = tunnels.dispose();
        await Promise.allSettled([...cleanup, disposal, ...operations.values(), ...bootstraps.values()]);
        await disposal;
      })();
      return closing;
    },
    async list() { return (await registry.list()).map(summaryOf); },
    sessionSummaries: () => catalog.summaries(),
    sessions: catalog.sessions,
    projects: catalog.projects,
    async browseProjects(hostKey, path) {
      await ensureReady(hostKey);
      return catalog.browseProjects(hostKey, path);
    },
    registerProject: catalog.registerProject,
    async workspaceFiles(hostKey, input) {
      await ensureReady(hostKey);
      const host = connectedHost(hostKey);
      if (!host) throw unavailable();
      const result = await host.adapter.client.request("workspace/files", input);
      if (connectedHost(hostKey) !== host) throw unavailable();
      return result;
    },
    async workspaceCommandShell(hostKey) {
      await ensureReady(hostKey);
      const host = connectedHost(hostKey);
      if (!host) throw unavailable();
      const { shell } = await host.adapter.client.request<{ shell: unknown }>("workspace/toolShell", {});
      if (connectedHost(hostKey) !== host) throw unavailable();
      if (!isCommandShellOption(shell) || !shell.available) {
        throw Object.assign(new Error("remote command shell unavailable"), { errorCode: "COMMAND_SHELL_INVALID" });
      }
      return shell;
    },
    async executeWorkspaceTool(input) {
      const host = connectedHost(input.hostKey);
      if (!host) throw unavailable();
      const { hostKey: _hostKey, ...request } = input;
      if (!request.path.startsWith("/") || request.path.includes("\0")
        || !["Read", "Glob", "Grep", "Write", "Edit", "Bash"].includes(request.toolName)) {
        throw Object.assign(new Error("invalid remote workspace tool"), { errorCode: "INVALID_ARGUMENT" });
      }
      const timeoutMs = input.timeoutMs ?? 60_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 21_600_000) {
        throw Object.assign(new Error("invalid remote tool timeout"), { errorCode: "INVALID_ARGUMENT" });
      }
      try {
        const result = await host.adapter.client.request("workspace/toolExecute", request, timeoutMs + 15_000);
        if (connectedHost(input.hostKey) !== host) throw unavailable();
        if (!result || typeof result !== "object" || !("ok" in result)
          || typeof result.ok !== "boolean" || !("content" in result)) {
          throw Object.assign(new Error("remote host returned an invalid tool result"), { errorCode: "INVALID_ARGUMENT" });
        }
        return result;
      } catch (error) {
        // A timeout/disconnection never replays a side effect. Cancel on the
        // original connection only; a replacement connection owns no such call.
        if (connectedHost(input.hostKey) === host) {
          try { await host.adapter.client.request("workspace/toolAbort", {
            sessionId: input.sessionId, toolCallId: input.toolCallId,
          }); } catch (abortError) { log("warn", "remote tool abort failed", { error: String(abortError) }); }
        }
        throw workspaceExecutionError(input.toolName, error);
      }
    },
    async abortWorkspaceTool(input) {
      const host = connectedHost(input.hostKey);
      if (!host) throw unavailable();
      await host.adapter.client.request("workspace/toolAbort", {
        sessionId: input.sessionId, toolCallId: input.toolCallId,
      });
    },
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
      // An explicit reconnect is the user asking again, so it may realign a
      // Host the automatic throttling has already given up on for this release.
      await openHost(record, true);
      return summaryOf(record);
    }),
    async bootstrapHost(request) {
      assertOpen();
      const controller = new AbortController();
      const task = bootstrap.bootstrap(request, { signal: controller.signal });
      bootstraps.set(controller, task);
      const outcome = await task.finally(() => { bootstraps.delete(controller); });
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
      actionRequired.delete(key);
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
