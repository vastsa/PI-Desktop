/**
 * A live remote host: one desktop-side coordinator per paired `pi-host`. Owns
 * the {@link BackendRouter} registrations for that host's sessions, subscribes
 * to the host's RACP event streams, and pipes them through the event bridge
 * onto the renderer's IPC events. Ownership of the transport itself stays
 * with the caller (Stage 3b builds it around a real {@link RacpClient}); this
 * layer only speaks the two interfaces {@link RemoteHostClient} exposes.
 *
 * Compatibility: while no connection has {@link open}ed, the router has no
 * remote backends registered, so every renderer call still hits the local
 * handler byte-for-byte. Failure of a remote host — network drop, protocol
 * mismatch — never escalates into a local regression: `close()` unregisters
 * every session and the fallback route resumes.
 */
import type { RacpEventEnvelope, RacpSession } from "@pi-desktop/shared";
import type { BackendRouter, RemoteBackend } from "./backend-router.js";
import { makeRemoteSessionId } from "./backend-router.js";
import { createRemoteBackend, type RemoteRacpClient } from "./remote-backend.js";
import {
  createRemoteEventBridge,
  type RemoteEventBridge,
  type RemoteLifecycleEvent,
} from "./remote-event-bridge.js";

/**
 * The transport surface this connection needs. {@link RemoteRacpClient} covers
 * the request half; {@link subscribe} bridges RACP's single-callback
 * {@link RacpClient.onEvent} into a multiple-listener seam for tests.
 */
export type RemoteHostClient = RemoteRacpClient & {
  /** Subscribe to raw RACP envelopes. The returned function detaches this listener. */
  subscribe(listener: (envelope: RacpEventEnvelope) => void): () => void;
};

export type RemoteHostConnectionOptions = {
  hostKey: string;
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
   * List the host's sessions, register a backend for each, then subscribe to
   * host-scope and per-session RACP event streams. Idempotent: a second call
   * on an open connection is a no-op.
   */
  open(): Promise<void>;
  /**
   * Detach the event subscription, unregister every session, and drop internal
   * state. Idempotent: closing twice is a no-op. The underlying transport is
   * the caller's responsibility.
   */
  close(): Promise<void>;
}

type SessionListResponse = { sessions: RacpSession[] };

export function createRemoteHostConnection(
  options: RemoteHostConnectionOptions,
): RemoteHostConnection {
  const { hostKey, client, router, emit } = options;
  const log = options.log ?? (() => undefined);
  const backend: RemoteBackend = createRemoteBackend({
    hostKey,
    client,
    ...(options.newRequestId ? { newRequestId: options.newRequestId } : {}),
  });

  const registered = new Set<string>();
  let bridge: RemoteEventBridge | null = null;
  let unsubscribe: (() => void) | null = null;
  let opened = false;

  const registerSession = async (hostSessionId: string): Promise<void> => {
    const remoteSessionId = makeRemoteSessionId(hostKey, hostSessionId);
    if (registered.has(remoteSessionId)) return;
    router.registerBackend(remoteSessionId, backend);
    registered.add(remoteSessionId);
    try {
      await client.request("events/subscribe", { scope: "session", sessionId: hostSessionId });
    } catch (error) {
      // A session-scope subscribe failure keeps the backend registered; the
      // renderer can still fetch snapshot/history via request paths, and
      // Stage 3b's reconnect logic will retry the stream. Errors that must
      // surface to the user go through the RacpClient state channel instead.
      log("warn", `events/subscribe failed for session ${hostSessionId}`, error);
    }
  };

  const unregisterSession = (hostSessionId: string): void => {
    const remoteSessionId = makeRemoteSessionId(hostKey, hostSessionId);
    if (!registered.delete(remoteSessionId)) return;
    router.unregisterBackend(remoteSessionId);
  };

  const handleLifecycle = (event: RemoteLifecycleEvent): void => {
    if (event.kind === "session.created") {
      void registerSession(event.hostSessionId);
      return;
    }
    if (event.kind === "session.archived") {
      unregisterSession(event.hostSessionId);
    }
  };

  return {
    hostKey,
    async open() {
      if (opened) return;
      opened = true;
      bridge = createRemoteEventBridge({
        hostKey,
        emit,
        onLifecycle: handleLifecycle,
        log: (level, message, data) => log(level, message, data),
      });
      unsubscribe = client.subscribe((envelope) => bridge?.handle(envelope));
      // Subscribing to host scope BEFORE listing sessions closes the race: any
      // `session.created` a peer emits between the two calls arrives as an
      // event and is handled by the lifecycle path (idempotent register).
      try {
        await client.request("events/subscribe", { scope: "host" });
      } catch (error) {
        log("warn", "events/subscribe host scope failed", error);
      }
      let response: SessionListResponse;
      try {
        response = await client.request<SessionListResponse>("session/list");
      } catch (error) {
        log("error", "session/list failed; connection stays with no registered sessions", error);
        return;
      }
      await Promise.all(response.sessions.map((session) => registerSession(session.id)));
    },
    async close() {
      if (!opened) return;
      opened = false;
      unsubscribe?.();
      unsubscribe = null;
      bridge = null;
      for (const remoteSessionId of registered) router.unregisterBackend(remoteSessionId);
      registered.clear();
    },
  };
}
