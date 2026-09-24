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
  RacpLimits,
  RacpRemoteError,
  RacpSession,
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
import { createRemoteSubscriptions, type RemoteSubscriptions } from "./remote-subscriptions.js";
import { remoteSessionSummary, type RemoteHostIdentity } from "./remote-transcript.js";

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
}

type SessionListResponse = { sessions: RacpSession[] };

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
  const host: RemoteHostIdentity = { hostKey, hostLabel: options.hostLabel };
  const log = options.log ?? (() => undefined);
  const sessions = new Map<string, RacpSession>();
  let subscriptions: RemoteSubscriptions | null = null;
  let bridge: RemoteEventBridge | null = null;
  let detach: Array<() => void> = [];
  let opened = false;
  const queueSyncs = new Set<string>();

  const summaryOf = (session: RacpSession) =>
    remoteSessionSummary(makeRemoteSessionId(hostKey, session.id), session, host);

  const noteSession = (session: RacpSession): SessionSummary => {
    sessions.set(session.id, session);
    subscriptions?.noteStatus(session.id, session.status);
    return summaryOf(session);
  };

  const forgetSession = (hostSessionId: string) => {
    sessions.delete(hostSessionId);
    void subscriptions?.release(hostSessionId);
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
    onSessionRead: (hostSessionId, cursor) => {
      void subscriptions?.touch(hostSessionId, cursor);
    },
  });

  /** Push the host's queue for a session, coalescing a burst into one read. */
  const syncQueue = (hostSessionId: string) => {
    if (queueSyncs.has(hostSessionId)) return;
    queueSyncs.add(hostSessionId);
    queueMicrotask(() => {
      queueSyncs.delete(hostSessionId);
      if (!opened) return;
      const sessionId = makeRemoteSessionId(hostKey, hostSessionId);
      backend
        .invoke(IPC.invoke.agentQueueList, [{ sessionId }])
        .then((result) => {
          const { entries } = result as { entries: QueuedTurnSummary[] };
          emit(IPC.event.agentQueueChanged, { sessionId, entries } satisfies AgentQueueChangedEvent);
        })
        .catch((error) => log("warn", `queue sync failed for session ${hostSessionId}`, error));
    });
  };

  const handleLifecycle = (event: RemoteLifecycleEvent): void => {
    if (event.kind === "session.archived") {
      forgetSession(event.hostSessionId);
      return;
    }
    const known = sessions.get(event.hostSessionId);
    if (known) {
      noteSession({ ...known, ...event.session });
      return;
    }
    // A full session (created, renamed) is cached as is; a status-only change
    // for an unknown session waits for the next list refresh.
    const candidate = event.session as Partial<RacpSession>;
    if (typeof candidate.title === "string" && typeof candidate.createdAt === "string") {
      noteSession({ queuedTurnIds: [], status: "idle", ...candidate } as RacpSession);
    }
  };

  const handleEnvelope = (envelope: RacpEventEnvelope) => {
    subscriptions?.observe(envelope);
    bridge?.handle(envelope);
    if (envelope.scope === "session" && envelope.sessionId && QUEUE_KINDS.has(envelope.kind)) {
      syncQueue(envelope.sessionId);
    }
  };

  return {
    hostKey,
    async open() {
      if (opened) return;
      opened = true;
      subscriptions = createRemoteSubscriptions({
        client,
        ...(client.limits?.()?.maxSubscriptionsPerConnection
          ? { maxSubscriptions: client.limits()!.maxSubscriptionsPerConnection }
          : {}),
        log,
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
      router.registerHost(hostKey, backend);
      // Subscribing to host scope BEFORE listing sessions closes the race: a
      // `session.created` between the two calls arrives as an event.
      await subscriptions.openHost();
      try {
        const response = await client.request<SessionListResponse>("session/list");
        if (!opened) return;
        for (const session of response.sessions) noteSession(session);
      } catch (error) {
        log("error", "session/list failed; the host lists no sessions until reconnect", error);
      }
    },
    async close() {
      if (!opened) return;
      opened = false;
      for (const release of detach) release();
      detach = [];
      subscriptions?.reset();
      subscriptions = null;
      bridge = null;
      sessions.clear();
      queueSyncs.clear();
      router.unregisterHost(hostKey, backend);
    },
    listSessions() {
      return [...sessions.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(summaryOf);
    },
    noteSession,
  };
}
