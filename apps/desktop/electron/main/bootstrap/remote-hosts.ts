/**
 * Boot every paired remote host. Reads the persisted registry, builds a
 * `RemoteHostConnection` per record, opens them, and returns a disposer that
 * `bootstrap/shutdown.ts` calls on quit. An empty registry (the default
 * install with no user pairing) is a full no-op: nothing runs, the router
 * has no remote backends, and every renderer call keeps hitting the local
 * handler byte-for-byte.
 *
 * The transport factory is injected. Production wires it to
 * `wsClientTransport` from `@pi-desktop/racp` (loopback for local dev, the
 * forwarded loopback port for an SSH-bootstrapped host); tests wire the
 * in-memory `MemoryLink` so this boot layer exercises the real `RacpClient`
 * state machine without a socket.
 *
 * Two shapes of paired host live here. A `direct` host stores the URL the user
 * pasted, including a forward they opened themselves. An `ssh` host stores a
 * descriptor instead, and this layer owns a live `ssh -N -L` forward for it
 * (`remote/ssh-tunnel.ts`) — the URL is derived from that forward on every
 * launch, so a restart re-establishes the tunnel before connecting.
 */
import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type {
  RacpSession,
  RemoteHostBootstrapRequest,
  RemoteHostBootstrapResult,
  RemoteHostSshMetadata,
  RemoteHostSummary,
  RemoteHostTransport,
  RemoteProjectBrowseResult,
  RemoteProjectSummary,
  SessionSummary,
} from "@pi-desktop/shared";
import { assertSshArgument } from "../remote/ssh-transport.js";
import { wsClientTransport, type ClientTransportFactory } from "@pi-desktop/racp";
import type { BackendRouter } from "../remote/backend-router.js";
import { createRacpRemoteHostClient, exchangePairingToken, type RacpRemoteHostClient } from "../remote/racp-remote-host-client.js";
import {
  createSshBootstrap,
  type SshBootstrapDeps,
} from "../remote/ssh-bootstrap.js";
import { createSshTunnelManager, type SshTunnelManager } from "../remote/ssh-tunnel.js";
import {
  createRemoteHostConnection,
  type RemoteHostConnection,
} from "../remote/remote-host-connection.js";
import { createRemoteToolRelay } from "../remote/remote-tool-relay.js";
import type { UserMcpRuntime } from "../user-mcp.js";
import {
  createRemoteHostRegistry,
  type EncryptionPort,
  type RemoteHostRecord,
  type RemoteHostRegistry,
} from "../remote/remote-host-registry.js";

export type RemoteHostAdapterFactory = (record: RemoteHostRecord) => RacpRemoteHostClient;

/** Build one WebSocket transport from the currently live direct/SSH endpoint. */
export function createRemoteHostTransportFactory(
  record: RemoteHostRecord,
  tunnels: SshTunnelManager,
  buildTransport: typeof wsClientTransport = wsClientTransport,
): ClientTransportFactory {
  const ssh = sshMetadataOf(record);
  return async () => {
    const url = ssh
      ? (await tunnels.open(record.hostKey, ssh, record.sshSecret)).url
      : record.url;
    return buildTransport({ url, token: record.deviceToken })();
  };
}

export type RemoteHostRetryScheduler = {
  schedule(callback: () => Promise<void>, delayMs: number): unknown;
  cancel(handle: unknown): void;
};

const BOOT_RETRY_BASE_DELAY_MS = 500;
const BOOT_RETRY_MAX_DELAY_MS = 15_000;

const systemRetryScheduler: RemoteHostRetryScheduler = {
  schedule(callback, delayMs) {
    return setTimeout(() => {
      void callback();
    }, delayMs);
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export type BootRemoteHostsOptions = {
  dataDir: string;
  encryption: EncryptionPort;
  router: BackendRouter;
  emit: (channel: string, payload: unknown) => void;
  /** `connection/initialize` identity forwarded to every paired host. */
  clientInfo: { name: string; version: string };
  /** Optional override; the default uses the real `wsClientTransport`. */
  buildAdapter?: RemoteHostAdapterFactory;
  /** Directly configured MCP tools available to paired remote Hosts. */
  userMcp?: Pick<
    UserMcpRuntime,
    "toolsForRemoteSession" | "callTool" | "cancelSessionCalls" | "onCatalogChanged"
  >;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  /** Durable SSH forwards; created on demand when the first SSH host is used. */
  tunnels?: SshTunnelManager;
  /** Retry timer injection; tests use this to advance retries deterministically. */
  retryScheduler?: RemoteHostRetryScheduler;
  /** Overrides for the SSH bootstrap's injected edges (tests only). */
  sshBootstrap?: Partial<SshBootstrapDeps>;
};

export type { RemoteHostSummary };

export interface RemoteHostsBoot {
  /** Read registry, connect every host, register their sessions. Returns
   * the number of hosts that finished `open()` without throwing. */
  open(): Promise<number>;
  /** Close every open connection. Idempotent; safe to call before `open`. */
  closeAll(): Promise<void>;
  /** Every paired host with its live connection state; safe from the renderer. */
  list(): Promise<RemoteHostSummary[]>;
  /** Persist a paired record, then open one live connection for it. */
  addHost(record: RemoteHostRecord): Promise<RemoteHostSummary>;
  /**
   * Install and pair a `pi-host` over SSH and bring it online (spec §5.2).
   * The forward the bootstrap opened is adopted rather than reopened, so
   * pairing pays for exactly one tunnel.
   */
  bootstrapHost(request: RemoteHostBootstrapRequest): Promise<RemoteHostBootstrapResult>;
  /** Close and unregister the host, then remove it from the registry. */
  removeHost(hostKey: string): Promise<void>;
  /** The sessions of every connected host, for the renderer's session list. */
  listRemoteSessions(): SessionSummary[];
  /** The projects a connected host has registered. */
  listProjects(hostKey: string): Promise<RemoteProjectSummary[]>;
  /** Directories under a connected host's browse root. */
  browseProject(hostKey: string, path?: string): Promise<RemoteProjectBrowseResult>;
  /** Register a host directory as a project. */
  registerProject(hostKey: string, path: string): Promise<RemoteProjectSummary>;
  /** Create a session on a connected host, running its default model. */
  createSession(hostKey: string, projectId: string, title?: string): Promise<SessionSummary>;
  /** The underlying registry, exposed for pairing flows that write directly. */
  readonly registry: RemoteHostRegistry;
}

/**
 * Single-slot registry so `bootstrap/shutdown.ts` can wait on the same boot
 * `startup.ts` created without expanding `index.ts` past its 1500-LOC ceiling.
 * The shutdown handler reads this on `before-quit` — never earlier — so the
 * ordering is: register the ref during startup, close during shutdown.
 */
let activeRemoteHostsBoot: RemoteHostsBoot | null = null;

export function setActiveRemoteHostsBoot(boot: RemoteHostsBoot | null): void {
  activeRemoteHostsBoot = boot;
}

export function getActiveRemoteHostsBoot(): RemoteHostsBoot | null {
  return activeRemoteHostsBoot;
}

/** Record metadata keys; `metadata` is the registry's forward-compatible slot. */
const TRANSPORT_KEY = "transport";
const SSH_KEY = "ssh";

/**
 * Read the SSH descriptor out of a record, or `null` for a `direct` host. The
 * shape is re-checked on read because `remote-hosts.json` is user-editable and
 * a malformed descriptor must degrade to "not an SSH host", never to a spawn
 * with garbage arguments.
 */
/**
 * A descriptor field that is safe to place in the `ssh` argv, or `null`. It
 * reuses the transport's own rule so the renderer path and the on-disk path
 * cannot drift apart.
 */
function safeSshField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return assertSshArgument(value, "ssh field");
  } catch {
    return null;
  }
}

/** `ssh -p` value, or `null` when absent or out of range. */
function safeSshPort(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535) {
    return value;
  }
  return null;
}

export function sshMetadataOf(record: RemoteHostRecord): RemoteHostSshMetadata | null {
  const metadata = record.metadata;
  if (!metadata || metadata[TRANSPORT_KEY] !== "ssh") return null;
  const ssh = metadata[SSH_KEY];
  if (typeof ssh !== "object" || ssh === null) return null;
  const candidate = ssh as Partial<RemoteHostSshMetadata>;
  // `remote-hosts.json` is user-editable and every one of these values reaches
  // the `ssh` command line, where a leading `-` is read as an option
  // (`-oProxyCommand=…`) rather than as a destination. A record that fails the
  // check is not an SSH host at all — never a spawn with junk argv.
  const host = safeSshField(candidate.host);
  if (host === null) return null;
  const user = candidate.user === undefined ? null : safeSshField(candidate.user);
  if (user === null && candidate.user !== undefined) return null;
  const identityFile =
    candidate.identityFile === undefined ? null : safeSshField(candidate.identityFile);
  if (identityFile === null && candidate.identityFile !== undefined) return null;
  const port = candidate.port === undefined ? null : safeSshPort(candidate.port);
  if (port === null && candidate.port !== undefined) return null;
  if (
    typeof candidate.remotePort !== "number" ||
    !Number.isInteger(candidate.remotePort) ||
    candidate.remotePort <= 0 ||
    candidate.remotePort > 65_535
  ) {
    return null;
  }
  return {
    host,
    ...(port !== null ? { port } : {}),
    ...(user !== null ? { user } : {}),
    ...(identityFile !== null ? { identityFile } : {}),
    // Anything that is not the literal `"password"` reads back as a key
    // descriptor, so records written before this field existed are unchanged —
    // on disk and in memory alike.
    ...(candidate.auth === "password" ? { auth: "password" as const } : {}),
    remotePort: candidate.remotePort,
    version: typeof candidate.version === "string" ? candidate.version : "",
  };
}

/** The registry record for a bootstrapped host. */
export function sshHostRecord(input: {
  hostKey: string;
  label: string;
  url: string;
  deviceToken: string;
  ssh: RemoteHostSshMetadata;
  /** Login password for a host that uses one; the registry encrypts it. */
  sshSecret?: string;
}): RemoteHostRecord {
  return {
    hostKey: input.hostKey,
    label: input.label,
    url: input.url,
    deviceToken: input.deviceToken,
    ...(input.sshSecret ? { sshSecret: input.sshSecret } : {}),
    metadata: { [TRANSPORT_KEY]: "ssh", [SSH_KEY]: input.ssh },
  };
}

export function transportOf(record: RemoteHostRecord): RemoteHostTransport {
  return sshMetadataOf(record) ? "ssh" : "direct";
}

type OpenHost = {
  hostKey: string;
  adapter: RacpRemoteHostClient;
  connection: RemoteHostConnection;
  /** The URL this host is live on, which for an SSH host is the forward's. */
  url: string;
};

type BootRetryState = {
  record: RemoteHostRecord;
  hostGeneration: number;
  failures: number;
  cancelled: boolean;
  timer?: unknown;
  adapter?: RacpRemoteHostClient;
};

type OpenHostGuard = {
  isCurrent(): boolean;
  canCloseForward(): boolean;
  trackAdapter(adapter: RacpRemoteHostClient): void;
};

export function createRemoteHostsBoot(
  options: BootRemoteHostsOptions,
): RemoteHostsBoot {
  const log = options.log ?? (() => undefined);
  const registry = createRemoteHostRegistry({
    dataDir: options.dataDir,
    encryption: options.encryption,
    log: (level, message, data) => log(level, message, data),
  });

  const tunnels =
    options.tunnels ??
    createSshTunnelManager({ log: (level, message, data) => log(level, message, data) });

  const buildAdapter: RemoteHostAdapterFactory = options.buildAdapter ?? ((record) => {
    return createRacpRemoteHostClient({
      // RACP calls this factory for every retry. Resolve the live SSH forward
      // each time because a failed tunnel may be replaced on another port.
      transport: createRemoteHostTransportFactory(record, tunnels),
      clientInfo: options.clientInfo,
      reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 15_000 },
      log: (level, message, data) => log(level, message, data),
    });
  });

  const bootstrap = createSshBootstrap({
    version: options.clientInfo.version,
    exchangePairing: ({ url, pairingToken, label }) =>
      exchangePairingToken({
        url,
        pairingToken,
        label,
        clientInfo: options.clientInfo,
        log: (level, message, data) => log(level, message, data),
      }),
    log: (level, message, data) => log(level, message, data),
    ...options.sshBootstrap,
  });

  const opened: OpenHost[] = [];
  const retryScheduler = options.retryScheduler ?? systemRetryScheduler;
  const retryStates = new Map<string, BootRetryState>();
  const retryCleanup = new Map<string, Promise<void>>();
  const hostGenerations = new Map<string, number>();
  let nextHostGeneration = 0;
  let registryGeneration = 0;
  let bootGeneration = 0;

  const bumpHostGeneration = (hostKey: string): number => {
    const generation = ++nextHostGeneration;
    hostGenerations.set(hostKey, generation);
    return generation;
  };

  const currentHostGeneration = (hostKey: string): number =>
    hostGenerations.get(hostKey) ?? 0;

  const isRetryCurrent = (state: BootRetryState): boolean =>
    !state.cancelled &&
    retryStates.get(state.record.hostKey) === state &&
    currentHostGeneration(state.record.hostKey) === state.hostGeneration;

  const retireRetryState = (hostKey: string): BootRetryState | undefined => {
    const state = retryStates.get(hostKey);
    if (!state) return undefined;
    retryStates.delete(hostKey);
    state.cancelled = true;
    if (state.timer !== undefined) {
      retryScheduler.cancel(state.timer);
      state.timer = undefined;
    }
    return state;
  };

  const closeRetryState = async (
    state: BootRetryState | undefined,
    closeForward: boolean,
  ): Promise<void> => {
    if (!state) return;
    const adapter = state.adapter;
    state.adapter = undefined;
    if (adapter) {
      await adapter.close().catch((error: unknown) => {
        log("warn", `remote host ${state.record.hostKey} adapter cancellation threw`, {
          error: String(error),
        });
      });
    }
    if (closeForward) {
      await tunnels.close(state.record.hostKey).catch((error: unknown) => {
        log("warn", `remote host ${state.record.hostKey} forward cancellation threw`, {
          error: String(error),
        });
      });
    }
  };

  const trackRetryCleanup = (
    state: BootRetryState,
    closeForward: boolean,
  ): Promise<void> => {
    const hostKey = state.record.hostKey;
    const cleanup = closeRetryState(state, closeForward);
    retryCleanup.set(hostKey, cleanup);
    void cleanup.then(() => {
      if (retryCleanup.get(hostKey) === cleanup) retryCleanup.delete(hostKey);
    });
    return cleanup;
  };

  const cancelRetry = async (hostKey: string, closeForward = true): Promise<void> => {
    const previousCleanup = retryCleanup.get(hostKey);
    const state = retireRetryState(hostKey);
    const currentCleanup = state ? trackRetryCleanup(state, closeForward) : undefined;
    await Promise.all([previousCleanup, currentCleanup]);
  };

  /** Bring one record online and register its router backends. */
  const openHost = async (
    record: RemoteHostRecord,
    guard?: OpenHostGuard,
  ): Promise<OpenHost> => {
    const ensureCurrent = (): void => {
      if (guard && !guard.isCurrent()) {
        throw new Error("remote host open attempt was cancelled");
      }
    };
    const ssh = sshMetadataOf(record);
    // An SSH host is only reachable while its forward is up; opening one here
    // — rather than trusting the stored URL — is what makes a restart work.
    let url = record.url;
    let adapter: RacpRemoteHostClient | undefined;
    let connection: RemoteHostConnection | undefined;
    let relay: ReturnType<typeof createRemoteToolRelay> | undefined;
    try {
      if (ssh) url = (await tunnels.open(record.hostKey, ssh, record.sshSecret)).url;
      ensureCurrent();
      adapter = buildAdapter({ ...record, url });
      guard?.trackAdapter(adapter);
      ensureCurrent();
      await adapter.connect();
      ensureCurrent();
      if (options.userMcp) {
        relay = createRemoteToolRelay({
          hostKey: record.hostKey,
          pairedDevice: record.deviceToken.length > 0,
          client: adapter.client,
          userMcp: options.userMcp,
          log: (level, message, data) => log(level, message, data),
        });
      }
      connection = createRemoteHostConnection({
        hostKey: record.hostKey,
        hostLabel: record.label,
        client: adapter.client,
        router: options.router,
        emit: options.emit,
        log: (level, message, data) => log(level, message, data),
        ...(relay ? { toolRelay: relay } : {}),
      });
      await connection.open();
      ensureCurrent();
      return { hostKey: record.hostKey, adapter, connection, url };
    } catch (error) {
      await connection?.close().catch(() => undefined);
      relay?.close();
      await adapter?.close().catch(() => undefined);
      // The host is not online, so nothing needs this forward; drop it rather
      // than leave an idle ssh process behind.
      // Cancellation owners close the forward. A stale attempt must not close
      // a newer attempt's tunnel under the same host key.
      if (ssh && (!guard || guard.isCurrent() || guard.canCloseForward())) {
        await tunnels.close(record.hostKey).catch(() => undefined);
      }
      throw error;
    }
  };

  const closeHost = async (host: OpenHost, closeForward = true): Promise<void> => {
    try {
      await host.connection.close();
    } catch (error) {
      log("warn", `remote host ${host.hostKey} connection close threw`, {
        error: String(error),
      });
    }
    try {
      await host.adapter.close();
    } catch (error) {
      log("warn", `remote host ${host.hostKey} adapter close threw`, {
        error: String(error),
      });
    }
    if (closeForward) {
      await tunnels.close(host.hostKey).catch((error: unknown) => {
        log("warn", `remote host ${host.hostKey} forward close threw`, {
          error: String(error),
        });
      });
    }
  };

  /** Drop a live connection for one host key, if there is one. */
  const closeLive = async (hostKey: string): Promise<void> => {
    const index = opened.findIndex((host) => host.hostKey === hostKey);
    if (index < 0) return;
    const [host] = opened.splice(index, 1);
    if (host) await closeHost(host);
  };

  const scheduleRetry = (state: BootRetryState): void => {
    if (!isRetryCurrent(state)) return;
    const exponent = Math.min(Math.max(0, state.failures - 1), 10);
    const delayMs = Math.min(
      BOOT_RETRY_BASE_DELAY_MS * 2 ** exponent,
      BOOT_RETRY_MAX_DELAY_MS,
    );
    state.timer = retryScheduler.schedule(async () => {
      state.timer = undefined;
      await attemptOpen(state, true);
    }, delayMs);
  };

  const attemptOpen = async (
    state: BootRetryState,
    emitOnSuccess: boolean,
  ): Promise<boolean> => {
    if (!isRetryCurrent(state)) return false;
    try {
      const host = await openHost(state.record, {
        isCurrent: () => isRetryCurrent(state),
        canCloseForward: () =>
          !retryStates.has(state.record.hostKey) &&
          !opened.some((candidate) => candidate.hostKey === state.record.hostKey),
        trackAdapter: (adapter) => {
          state.adapter = adapter;
        },
      });
      if (!isRetryCurrent(state)) {
        // The cancellation owner has already retired this attempt and its
        // forward. Do not let a stale success close a newer host generation.
        await closeHost(host, false);
        return false;
      }
      state.adapter = undefined;
      retryStates.delete(state.record.hostKey);
      opened.push(host);
      if (emitOnSuccess) {
        options.emit(IPC.event.sessionsChanged, { reason: "remote.hosts.changed" });
      }
      return true;
    } catch (error) {
      state.adapter = undefined;
      if (!isRetryCurrent(state)) return false;
      state.failures += 1;
      const exponent = Math.min(Math.max(0, state.failures - 1), 10);
      const delayMs = Math.min(
        BOOT_RETRY_BASE_DELAY_MS * 2 ** exponent,
        BOOT_RETRY_MAX_DELAY_MS,
      );
      log("warn", `remote host ${state.record.hostKey} failed to open; retry scheduled`, {
        error: String(error),
        retryDelayMs: delayMs,
      });
      scheduleRetry(state);
      return false;
    }
  };

  const startAttempt = (
    record: RemoteHostRecord,
    hostGeneration: number,
    emitOnSuccess: boolean,
  ): Promise<boolean> => {
    const previousCleanup = retryCleanup.get(record.hostKey);
    const previous = retireRetryState(record.hostKey);
    const previousStateCleanup = previous
      ? trackRetryCleanup(previous, true)
      : undefined;
    const state: BootRetryState = {
      record,
      hostGeneration,
      failures: 0,
      cancelled: false,
    };
    retryStates.set(record.hostKey, state);
    return (async () => {
      await Promise.all([previousCleanup, previousStateCleanup]);
      if (!isRetryCurrent(state)) return false;
      return attemptOpen(state, emitOnSuccess);
    })();
  };

  /** The live host for `hostKey`; a host that is not connected fails closed. */
  const liveHost = (hostKey: string): OpenHost => {
    const host = opened.find((candidate) => candidate.hostKey === hostKey);
    if (!host) {
      throw Object.assign(new Error("the remote host is not connected"), {
        errorCode: ErrorCodes.HOST_UNAVAILABLE,
        data: { errorCode: ErrorCodes.HOST_UNAVAILABLE, retriable: true },
      });
    }
    return host;
  };

  const request = <T>(hostKey: string, method: string, params?: unknown): Promise<T> =>
    liveHost(hostKey).adapter.client.request<T>(method, params);

  const summaryOf = (record: RemoteHostRecord): RemoteHostSummary => {
    const live = opened.find((host) => host.hostKey === record.hostKey);
    return {
      hostKey: record.hostKey,
      label: record.label,
      url: live?.url ?? record.url,
      connected: live !== undefined,
      transport: transportOf(record),
    };
  };

  const addHost = async (record: RemoteHostRecord): Promise<RemoteHostSummary> => {
    const operationGeneration = bumpHostGeneration(record.hostKey);
    registryGeneration += 1;
    const operationBootGeneration = bootGeneration;
    // Retire pending retry work before replacing the persisted credential or
    // transport descriptor. The close waits for an SSH open already in flight.
    await cancelRetry(record.hostKey);
    if (
      operationBootGeneration !== bootGeneration ||
      currentHostGeneration(record.hostKey) !== operationGeneration
    ) {
      return summaryOf(record);
    }
    // Replace any prior live connection under the same hostKey (a re-pair
    // rotates the device token but the routing key stays stable).
    await closeLive(record.hostKey);
    if (
      operationBootGeneration !== bootGeneration ||
      currentHostGeneration(record.hostKey) !== operationGeneration
    ) {
      return summaryOf(record);
    }
    // Persist before opening so a crash between the two leaves a record the
    // next boot can retry; a failed open is surfaced but the row stays.
    await registry.upsert(record);
    if (
      operationBootGeneration !== bootGeneration ||
      currentHostGeneration(record.hostKey) !== operationGeneration
    ) {
      // The sidebar lists hosts and their sessions from this cue.
      options.emit(IPC.event.sessionsChanged, { reason: "remote.hosts.changed" });
      return summaryOf(record);
    }
    const connected = await startAttempt(record, operationGeneration, false);
    // The sidebar lists hosts and their sessions from this cue.
    options.emit(IPC.event.sessionsChanged, { reason: "remote.hosts.changed" });
    return { ...summaryOf(record), connected };
  };

  return {
    registry,
    async open() {
      const openingGeneration = bootGeneration;
      let records: RemoteHostRecord[];
      try {
        for (;;) {
          const beforeRead = registryGeneration;
          records = await registry.list();
          if (beforeRead === registryGeneration) break;
        }
      } catch (error) {
        log("error", "remote host registry read failed; skipping remote boot", {
          error: String(error),
        });
        return 0;
      }
      if (openingGeneration !== bootGeneration) return 0;
      if (records.length === 0) return 0;

      // Each host gets its first bounded connect in parallel. A failed host
      // schedules its own retry and cannot serialize the rest of startup.
      const attempts = records.map((record) => {
        if (opened.some((host) => host.hostKey === record.hostKey)) {
          return Promise.resolve(true);
        }
        const generation = bumpHostGeneration(record.hostKey);
        return startAttempt(record, generation, false);
      });
      const results = await Promise.all(attempts);
      const successes = results.filter(Boolean).length;
      if (successes > 0) options.emit(IPC.event.sessionsChanged, { reason: "remote.hosts.opened" });
      return successes;
    },
    async closeAll() {
      bootGeneration += 1;
      // Snapshot and clear first so a re-entrant close finds nothing to do.
      const pendingRetries = [...retryStates.values()];
      for (const state of pendingRetries) retireRetryState(state.record.hostKey);
      const existingCleanup = [...retryCleanup.values()];
      const cancelledCleanup = pendingRetries.map((state) =>
        trackRetryCleanup(state, false),
      );
      await Promise.allSettled([...existingCleanup, ...cancelledCleanup]);
      const hosts = opened.splice(0, opened.length);
      await Promise.allSettled(hosts.map((host) => closeHost(host)));
      // A tunnel can outlive its connection when the connect failed; sweep it.
      await tunnels.dispose();
    },
    async list() {
      const records = await registry.list();
      return records.map(summaryOf);
    },
    listRemoteSessions() {
      return opened.flatMap((host) => host.connection.listSessions());
    },
    async listProjects(hostKey) {
      const result = await request<{ projects: RemoteProjectSummary[] }>(hostKey, "project/list");
      return result.projects.map(({ id, label, archived }) => ({ id, label, archived }));
    },
    async browseProject(hostKey, path) {
      return request<RemoteProjectBrowseResult>(hostKey, "project/browse", path ? { path } : {});
    },
    async registerProject(hostKey, path) {
      const { project } = await request<{ project: RemoteProjectSummary }>(
        hostKey,
        "project/register",
        { path },
      );
      return { id: project.id, label: project.label, archived: project.archived };
    },
    async createSession(hostKey, projectId, title) {
      const host = liveHost(hostKey);
      const { session } = await host.adapter.client.request<{ session: RacpSession }>(
        "session/create",
        { projectId, ...(title ? { title } : {}) },
      );
      const summary = host.connection.noteSession(session);
      options.emit(IPC.event.sessionsChanged, { reason: "remote.session.created" });
      return summary;
    },
    addHost,
    async bootstrapHost(request) {
      const outcome = await bootstrap.bootstrap(request);
      // A re-pair under the same key must release the previous live
      // connection — and with it the previous forward — before the new
      // forward is adopted. Otherwise adopting would evict the very forward
      // the bootstrap just opened for us.
      await cancelRetry(outcome.hostKey);
      await closeLive(outcome.hostKey);
      // Adopt before persisting: the forward is already live and the device
      // token only works over it.
      await tunnels.adopt(outcome.hostKey, outcome.ssh, outcome.forward);
      const host = await addHost(
        sshHostRecord({
          hostKey: outcome.hostKey,
          label: outcome.label,
          url: outcome.url,
          deviceToken: outcome.deviceToken,
          ssh: outcome.ssh,
          ...(outcome.sshSecret ? { sshSecret: outcome.sshSecret } : {}),
        }),
      );
      return { host, ssh: outcome.ssh, steps: outcome.steps };
    },
    async removeHost(hostKey) {
      bumpHostGeneration(hostKey);
      registryGeneration += 1;
      await cancelRetry(hostKey);
      await closeLive(hostKey);
      // A paired host that never came online still owns a tunnel slot.
      await tunnels.close(hostKey);
      await registry.remove(hostKey);
      options.emit(IPC.event.sessionsChanged, { reason: "remote.hosts.changed" });
    },
  };
}
