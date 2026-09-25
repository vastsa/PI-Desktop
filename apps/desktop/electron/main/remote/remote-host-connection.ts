/**
 * A live remote host: one desktop-side coordinator per paired `pi-host`. Owns
 * the {@link BackendRouter} registration for the host, the host's session list
 * cache, its bounded event subscriptions, and the event bridge onto the
 * renderer's IPC events. Ownership of the transport itself stays with the
 * caller; this layer only speaks the {@link RemoteHostClient} interface.
 *
 * Failure is fail-closed (ADR 0286 §3 as amended): while the host is not
 * registered, a call naming one of its sessions is refused with
 * `HOST_UNAVAILABLE` by the router — it never falls back to a local handler.
 */
import { IPC } from "@pi-desktop/shared";
import type {
  AgentQueueChangedEvent,
  QueuedTurnSummary,
  RacpCursor,
  RacpEventEnvelope,
  RacpInitializeResult,
  RacpLimits,
  RacpRemoteError,
  RacpServerCapabilities,
  RacpSession,
  RacpSessionSnapshot,
  SessionSummary,
} from "@pi-desktop/shared";
import type { BackendRouter, RemoteBackend } from "./backend-router.js";
import { makeRemoteSessionId } from "./backend-router.js";
import { createRemoteBackend, type RemoteRacpClient } from "./remote-backend.js";
import {
  createRemoteEventBridge,
  type RemoteEventBridge,
  type RemoteLifecycleEvent,
} from "./remote-event-bridge.js";
import {
  createRemoteSubscriptions,
  type RemoteSubscriptionRecovery,
  type RemoteSubscriptions,
} from "./remote-subscriptions.js";
import { remoteSessionSummary, type RemoteHostIdentity } from "./remote-transcript.js";
import type { RemoteToolRelay } from "./remote-tool-relay.js";

export type RemoteConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

/** A subscription the host closed, with the cursor to resume after. */
export type RemoteSubscriptionClosed = {
  subscriptionId: string;
  error: RacpRemoteError;
  lastSafeCursor: RacpCursor;
};

/**
 * The transport surface this connection needs. {@link RemoteRacpClient} covers
 * the request half; {@link subscribe} bridges RACP's single-callback
 * `RacpClient.onEvent` into a multiple-listener seam for tests.
 */
export type RemoteHostClient = RemoteRacpClient & {
  /** Subscribe to raw RACP envelopes. The returned function detaches this listener. */
  subscribe(listener: (envelope: RacpEventEnvelope) => void): () => void;
  /** Subscriptions the host closed; absent on transports that never close one. */
  onSubscriptionClosed?(listener: (notice: RemoteSubscriptionClosed) => void): () => void;
  /** The limits the host announced at initialize, once connected. */
  limits?(): RacpLimits | undefined;
  /** Host capabilities announced by `connection/initialize`. */
  hostCapabilities?(): RacpServerCapabilities | undefined;
  /** Principal returned by `connection/initialize`. */
  initialized?(): RacpInitializeResult | undefined;
  /** Last durable session cursor retained by the RACP client. */
  cursorFor?(sessionId: string): RacpCursor | undefined;
  /** Last durable host cursor retained by the RACP client. */
  cursorForHost?(): RacpCursor | undefined;
  /** Server-initiated requests, such as reverse `tool/execute`. */
  onServerRequest?(listener: (method: string, params: unknown) => Promise<unknown>): () => void;
  /** Transport state transitions. */
  onConnectionState?(listener: (state: RemoteConnectionState, error?: unknown) => void): () => void;
  /** Called once RACP has reinitialized after reconnect. */
  onReconnected?(listener: () => Promise<void> | void): () => void;
};

export type RemoteHostConnectionOptions = {
  hostKey: string;
  /** The host's display label, shown with each of its sessions. */
  hostLabel: string;
  client: RemoteHostClient;
  router: BackendRouter;
  /** Dispatch a local IPC event to the renderer. */
  emit: (channel: string, payload: unknown) => void;
  /** Optional deterministic request-id source; forwarded to the backend. */
  newRequestId?: () => string;
  /** Optional structured log; defaults to a no-op. */
  log?: (level: "warn" | "error", message: string, data?: unknown) => void;
  /** Optional owner-side reverse MCP relay for this Host connection. */
  toolRelay?: RemoteToolRelay;
};

export interface RemoteHostConnection {
  readonly hostKey: string;
  /**
   * Register the host with the router, subscribe to its host scope, and load
   * its session list. Idempotent: a second call on an open connection is a
   * no-op. Session scopes are subscribed on demand when a session is read.
   */
  open(): Promise<void>;
  /**
   * Detach listeners, release the router registration, and drop internal
   * state. Idempotent. The underlying transport is the caller's responsibility.
   */
  close(): Promise<void>;
  /** The host's sessions as the renderer lists them, newest first. */
  listSessions(): SessionSummary[];
  /** Record a session the host just returned, before any event reports it. */
  noteSession(session: RacpSession): SessionSummary;
  /** Restore subscriptions and snapshot state after the adapter reconnects. */
  reconnected(): Promise<void>;
}

type SessionListResponse = { sessions: RacpSession[] };
type AttachSnapshotResponse = { session: RacpSession; snapshot?: RacpSessionSnapshot };

/** Session-scope kinds after which the host's queue may have changed. */
const QUEUE_KINDS: ReadonlySet<string> = new Set([
  "turn.queued",
  "turn.started",
  "turn.completed",
  "turn.interrupted",
  "turn.failed",
  "turn.canceled",
]);

export function createRemoteHostConnection(
  options: RemoteHostConnectionOptions,
): RemoteHostConnection {
  const { hostKey, client, router, emit } = options;
  const host: RemoteHostIdentity = {
    hostKey,
    hostLabel: options.hostLabel,
    canTerminal: client.hostCapabilities?.()?.terminal === true,
  };
  const log = options.log ?? (() => undefined);
  const sessions = new Map<string, RacpSession>();
  let subscriptions: RemoteSubscriptions | null = null;
  let bridge: RemoteEventBridge | null = null;
  let detach: Array<() => void> = [];
  let opened = false;
  let lifecycleGeneration = 0;
  let snapshotEvents: RemoteLifecycleEvent[] | null = null;
  let recovery: Promise<void> | null = null;
  const queueSyncs = new Set<string>();
  let reconcileSession: (
    hostSessionId: string,
    reason: RemoteSubscriptionRecovery["reason"],
    generation: number,
  ) => Promise<boolean> = async () => false;

  const summaryOf = (session: RacpSession) =>
    remoteSessionSummary(makeRemoteSessionId(hostKey, session.id), session, host);

  const storeSession = (session: RacpSession, advertise = true): SessionSummary => {
    sessions.set(session.id, session);
    subscriptions?.noteStatus(session.id, session.status);
    if (advertise) {
      void options.toolRelay?.addSession(session.id).catch((error) =>
        log("warn", `remote MCP catalog update failed for session ${session.id}`, error),
      );
    }
    return summaryOf(session);
  };

  const noteSession = (session: RacpSession): SessionSummary => {
    if (snapshotEvents) {
      snapshotEvents.push({
        kind: "session.changed",
        hostSessionId: session.id,
        remoteSessionId: makeRemoteSessionId(hostKey, session.id),
        session,
      });
      return summaryOf(session);
    }
    return storeSession(session);
  };

  const removeSession = (hostSessionId: string, releaseRelay = true) => {
    sessions.delete(hostSessionId);
    void subscriptions?.release(hostSessionId);
    if (releaseRelay) options.toolRelay?.removeSession(hostSessionId);
  };

  const forgetSession = (hostSessionId: string) => {
    if (snapshotEvents) {
      snapshotEvents.push({
        kind: "session.archived",
        hostSessionId,
        remoteSessionId: makeRemoteSessionId(hostKey, hostSessionId),
      });
      return;
    }
    removeSession(hostSessionId);
  };

  const backend: RemoteBackend = createRemoteBackend({
    hostKey,
    hostLabel: options.hostLabel,
    client,
    ...(options.newRequestId ? { newRequestId: options.newRequestId } : {}),
    onSession: (session) => {
      noteSession(session);
    },
    onSessionRemoved: forgetSession,
    onSessionRead: async (hostSessionId, cursor) => {
      const resync = await subscriptions?.touch(hostSessionId, cursor);
      if (!resync) return false;
      return reconcileSession(hostSessionId, resync.reason, lifecycleGeneration);
    },
  });

  /** Push the host's queue for a session, coalescing a burst into one read. */
  const syncQueue = (hostSessionId: string) => {
    if (queueSyncs.has(hostSessionId)) return;
    queueSyncs.add(hostSessionId);
    const generation = lifecycleGeneration;
    queueMicrotask(() => {
      if (!opened || generation !== lifecycleGeneration) return;
      queueSyncs.delete(hostSessionId);
      const sessionId = makeRemoteSessionId(hostKey, hostSessionId);
      backend
        .invoke(IPC.invoke.agentQueueList, [{ sessionId }])
        .then((result) => {
          if (!isCurrentGeneration(generation)) return;
          const { entries } = result as { entries: QueuedTurnSummary[] };
          emit(IPC.event.agentQueueChanged, { sessionId, entries } satisfies AgentQueueChangedEvent);
        })
        .catch((error) => log("warn", `queue sync failed for session ${hostSessionId}`, error));
    });
  };

  const mergeLifecycleEvent = (
    target: Map<string, RacpSession>,
    event: RemoteLifecycleEvent,
  ): void => {
    if (event.kind === "session.archived") {
      target.delete(event.hostSessionId);
      return;
    }
    const known = target.get(event.hostSessionId);
    if (known) {
      target.set(event.hostSessionId, { ...known, ...event.session, id: event.hostSessionId });
      return;
    }
    // A full session (created, renamed) is cached as is; a status-only change
    // for an unknown session waits for the next list refresh.
    const candidate = event.session as Partial<RacpSession>;
    if (typeof candidate.title === "string" && typeof candidate.createdAt === "string") {
      target.set(event.hostSessionId, {
        queuedTurnIds: [],
        status: "idle",
        ...candidate,
        id: event.hostSessionId,
      } as RacpSession);
    }
  };

  const syncSessionSideEffects = async (previous: Set<string>): Promise<void> => {
    for (const hostSessionId of previous) {
      if (!sessions.has(hostSessionId)) removeSession(hostSessionId);
    }
    const relayUpdates: Promise<void>[] = [];
    for (const session of sessions.values()) {
      subscriptions?.noteStatus(session.id, session.status);
      if (options.toolRelay) {
        relayUpdates.push(options.toolRelay.addSession(session.id).catch((error) => {
          log("warn", `remote MCP catalog update failed for session ${session.id}`, error);
        }));
      }
    }
    await Promise.all(relayUpdates);
  };

  const handleLifecycle = (event: RemoteLifecycleEvent): void => {
    if (snapshotEvents) {
      snapshotEvents.push(event);
      return;
    }
    mergeLifecycleEvent(sessions, event);
    if (event.kind === "session.archived") {
      removeSession(event.hostSessionId);
      return;
    }
    const session = sessions.get(event.hostSessionId);
    if (!session) return;
    subscriptions?.noteStatus(session.id, session.status);
    void options.toolRelay?.addSession(session.id).catch((error) =>
      log("warn", `remote MCP catalog update failed for session ${session.id}`, error),
    );
  };

  const handleEnvelope = (envelope: RacpEventEnvelope) => {
    subscriptions?.observe(envelope);
    bridge?.handle(envelope);
    if (envelope.scope === "session" && envelope.sessionId && QUEUE_KINDS.has(envelope.kind)) {
      syncQueue(envelope.sessionId);
    }
  };

  const isCurrentGeneration = (generation: number): boolean =>
    opened && generation === lifecycleGeneration;

  reconcileSession = async (
    hostSessionId,
    reason,
    generation,
  ): Promise<boolean> => {
    if (!isCurrentGeneration(generation)) return false;
    const wasKnown = sessions.has(hostSessionId);
    try {
      const result = await client.request<AttachSnapshotResponse>("session/attach", {
        sessionId: hostSessionId,
        includeSnapshot: true,
      });
      const snapshot = result.snapshot;
      if (!snapshot || !isCurrentGeneration(generation)) return false;
      // A concurrent archive must win over an older attach response.
      if (wasKnown && !sessions.has(hostSessionId)) return false;
      const current = sessions.get(hostSessionId);
      if (!current || (snapshot.session.revision ?? 0) >= (current.revision ?? 0)) {
        storeSession(snapshot.session, false);
      }
      subscriptions?.noteStatus(hostSessionId, snapshot.session.status);
      subscriptions?.checkpoint(hostSessionId, snapshot.cursor);
      bridge?.restoreSnapshot(hostSessionId, snapshot);
      syncQueue(hostSessionId);
      return true;
    } catch (error) {
      log("warn", `remote session resync failed for ${hostSessionId}`, { hostKey, reason, error });
      return false;
    }
  };

  const refreshSessionSnapshot = async (generation: number): Promise<void> => {
    const events: RemoteLifecycleEvent[] = [];
    snapshotEvents = events;
    let listed: RacpSession[] | null = null;
    try {
      const response = await client.request<SessionListResponse>("session/list");
      if (Array.isArray(response.sessions)) listed = response.sessions;
      else log("warn", "session/list returned an invalid session snapshot", { hostKey });
    } catch (error) {
      log("warn", "session/list failed while refreshing remote state", { hostKey, error });
    }

    if (snapshotEvents === events) snapshotEvents = null;
    if (!isCurrentGeneration(generation)) return;

    const previous = new Set(sessions.keys());
    const replacement = new Map<string, RacpSession>();
    if (listed) {
      for (const session of listed) replacement.set(session.id, session);
    } else {
      for (const [id, session] of sessions) replacement.set(id, session);
    }
    // Host lifecycle notifications observed while `session/list` was in
    // flight are newer than that response. Replay them in arrival order so an
    // archive or a rename cannot be overwritten by the snapshot.
    for (const event of events) mergeLifecycleEvent(replacement, event);

    sessions.clear();
    for (const [id, session] of replacement) sessions.set(id, session);
    await syncSessionSideEffects(previous);
  };

  const reconnected = (): Promise<void> => {
    if (!opened) return Promise.resolve();
    if (recovery) return recovery;
    const generation = lifecycleGeneration;
    const pending = (async () => {
      let resyncs: RemoteSubscriptionRecovery[] = [];
      try {
        resyncs = (await subscriptions?.reconnect()) ?? [];
      } catch (error) {
        log("warn", "remote event subscriptions failed to restore", { hostKey, error });
      }
      if (!isCurrentGeneration(generation)) return;

      // Initialize is repeated on every transport. Refresh capability-derived
      // session surfaces before publishing the recovered snapshot.
      host.canTerminal = client.hostCapabilities?.()?.terminal === true;
      await refreshSessionSnapshot(generation);
      if (!isCurrentGeneration(generation)) return;

      const restored = await Promise.all(
        resyncs.map(async ({ hostSessionId, reason }) => {
          if (!sessions.has(hostSessionId)) return null;
          const recovered = await reconcileSession(hostSessionId, reason, generation);
          return recovered ? makeRemoteSessionId(hostKey, hostSessionId) : null;
        }),
      );
      if (!isCurrentGeneration(generation)) return;

      try {
        await options.toolRelay?.reconnected();
      } catch (error) {
        log("warn", "remote MCP relay failed to recover", { hostKey, error });
      }
      if (!isCurrentGeneration(generation)) return;
      emit(IPC.event.sessionsChanged, {
        reason: "remote.host.reconnected",
        hostKey,
        sessionResyncIds: restored.filter((sessionId): sessionId is string => sessionId !== null),
      });
    })();
    const wrapped = pending.finally(() => {
      if (recovery === wrapped) recovery = null;
    });
    recovery = wrapped;
    return wrapped;
  };

  return {
    hostKey,
    async open() {
      if (opened) return;
      opened = true;
      const generation = ++lifecycleGeneration;
      subscriptions = createRemoteSubscriptions({
        client,
        ...(client.limits?.()?.maxSubscriptionsPerConnection
          ? { maxSubscriptions: client.limits()!.maxSubscriptionsPerConnection }
          : {}),
        log,
        onSessionRecovery: async ({ hostSessionId, reason }) => {
          const recovered = await reconcileSession(hostSessionId, reason, lifecycleGeneration);
          if (recovered) {
            emit(IPC.event.sessionsChanged, {
              reason: "remote.session.resynced",
              hostKey,
              sessionResyncIds: [makeRemoteSessionId(hostKey, hostSessionId)],
            });
          }
        },
        onHostRecovery: async () => {
          if (recovery) {
            await recovery;
            return;
          }
          await refreshSessionSnapshot(lifecycleGeneration);
          if (isCurrentGeneration(lifecycleGeneration)) {
            emit(IPC.event.sessionsChanged, { reason: "remote.host.resynced", hostKey });
          }
        },
      });
      bridge = createRemoteEventBridge({
        hostKey,
        emit,
        onLifecycle: handleLifecycle,
        log: (level, message, data) => log(level, message, data),
      });
      detach = [client.subscribe(handleEnvelope)];
      if (client.onSubscriptionClosed) {
        detach.push(
          client.onSubscriptionClosed((notice) =>
            subscriptions?.closed(notice.subscriptionId, notice.lastSafeCursor),
          ),
        );
      }
      if (client.onServerRequest && options.toolRelay) {
        detach.push(client.onServerRequest((method, params) =>
          options.toolRelay!.handleServerRequest(method, params),
        ));
      }
      if (client.onConnectionState) {
        detach.push(client.onConnectionState((state) => {
          if (state !== "connected") options.toolRelay?.disconnected();
          if (state === "reconnecting") {
            emit(IPC.event.sessionsChanged, { reason: "remote.host.reconnecting", hostKey });
          } else if (state === "error") {
            emit(IPC.event.sessionsChanged, { reason: "remote.host.error", hostKey });
          }
        }));
      }
      if (client.onReconnected) detach.push(client.onReconnected(reconnected));
      router.registerHost(hostKey, backend);
      // Subscribing to host scope BEFORE listing sessions closes the race: a
      // `session.created` between the two calls arrives as an event.
      await subscriptions.openHost();
      if (!isCurrentGeneration(generation)) return;
      await refreshSessionSnapshot(generation);
    },
    async close() {
      if (!opened) return;
      opened = false;
      lifecycleGeneration += 1;
      snapshotEvents = null;
      recovery = null;
      for (const release of detach) release();
      detach = [];
      subscriptions?.reset();
      subscriptions = null;
      bridge = null;
      sessions.clear();
      queueSyncs.clear();
      options.toolRelay?.close();
      router.unregisterHost(hostKey, backend);
    },
    listSessions() {
      return [...sessions.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(summaryOf);
    },
    noteSession,
    reconnected,
  };
}
