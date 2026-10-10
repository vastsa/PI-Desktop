/** Lifecycle owner for a host's router registrations and bounded event streams. */
import { IPC, RACP_DEFAULT_LIMITS, type RacpCursor, type RacpEventEnvelope, type RacpSession, type RacpSessionSnapshot } from "@pi-desktop/shared";
import type { BackendRouter } from "./backend-router.js";
import { makeRemoteSessionId } from "./backend-router.js";
import { createRemoteBackend, type RemoteRacpClient } from "./remote-backend.js";
import { createRemoteEventBridge } from "./remote-event-bridge.js";
import { createRemoteSubscriptions } from "./remote-subscriptions.js";

export type RemoteHostClientState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
export type RemoteSubscriptionClosed = { subscriptionId: string; error: { code: string }; lastSafeCursor: RacpCursor };
export type RemoteHostClient = RemoteRacpClient & {
  subscribe(listener: (envelope: RacpEventEnvelope) => void): () => void;
  subscribeReconnect?(listener: () => Promise<void>): () => void;
  subscribeState?(listener: (state: RemoteHostClientState) => void): () => void;
  subscribeSubscriptionClosed?(listener: (notice: RemoteSubscriptionClosed) => void): () => void;
  state?(): RemoteHostClientState;
};
export type RemoteHostConnectionOptions = {
  hostKey: string;
  hostLabel?: string;
  client: RemoteHostClient;
  router: BackendRouter;
  emit: (channel: string, payload: unknown) => void;
  newRequestId?: () => string;
  /** Reserve one subscription for host scope. Excess sessions remain routable. */
  maxSessionSubscriptions?: number;
  log?: (level: "warn" | "error", message: string, data?: unknown) => void;
};
export interface RemoteHostConnection {
  readonly hostKey: string;
  open(): Promise<void>;
  /** Register and watch a user-reachable session without waiting for its host event. */
  ensureSession(hostSessionId: string): Promise<void>;
  close(): Promise<void>;
}

export function createRemoteHostConnection(options: RemoteHostConnectionOptions): RemoteHostConnection {
  const { hostKey, client, router, emit } = options;
  const log = options.log ?? (() => undefined);
  const limit = Math.max(1, Math.min(RACP_DEFAULT_LIMITS.maxSubscriptionsPerConnection - 1, options.maxSessionSubscriptions ?? 7));
  let generation = 0;
  let current: ReturnType<typeof start> | undefined;
  const disconnected = () => Object.assign(new Error("remote connection closed or replaced"), { code: "HOST_DISCONNECTED", errorCode: "HOST_DISCONNECTED" });

  function start() {
    const token = ++generation;
    const registered = new Set<string>();
    const watched = new Set<string>();
    const recovering = new Map<string, Promise<void>>();
    const detachers: (() => void)[] = [];
    let online = true;
    let ready = false;
    let refreshAfterReconnect = false;
    let listingChanges: Set<string> | undefined;
    let transportGeneration = 0;
    let queue = Promise.resolve();
    const alive = () => token === generation && online;
    const check = (epoch = transportGeneration) => { if (!alive() || epoch !== transportGeneration) throw disconnected(); };
    const enqueue = (work: () => Promise<void>) => {
      const epoch = transportGeneration;
      const result = queue.then(() => { check(epoch); return work(); });
      queue = result.catch(() => undefined);
      return result;
    };
    const bridge = createRemoteEventBridge({ hostKey, emit, log, onLifecycle: event => {
      if (!alive()) return;
      if (event.kind === "session.created") {
        register(event.hostSessionId);
        // Peers do not steal the selected session or evict its stream.
        if (watched.size < limit) background(ensure(event.hostSessionId));
      } else if (event.kind === "session.archived") {
        unregister(event.hostSessionId);
        background(enqueue(() => subscriptions.remove(event.hostSessionId)));
      }
    } });
    const backend = createRemoteBackend({
      hostKey,
      client: { async request<T>(method: string, params?: unknown): Promise<T> {
        const epoch = transportGeneration;
        check(epoch);
        if (!ready) throw disconnected();
        const result = await client.request<T>(method, params);
        check(epoch);
        return result;
      } },
      ...(options.hostLabel ? { hostLabel: options.hostLabel } : {}),
      ...(options.newRequestId ? { newRequestId: options.newRequestId } : {}),
      onSnapshot(snapshot: RacpSessionSnapshot) {
        if (!alive() || !registered.has(snapshot.session.id)) return;
        bridge.restoreSnapshot(snapshot);
        background(ensure(snapshot.session.id));
      },
    });
    const subscriptions = createRemoteSubscriptions({ client, alive, handle: event => bridge.handle(event),
      recover: id => background(recover(id)), log: (message, error) => log("warn", message, error),
    });
    function background(promise: Promise<void>) {
      void promise.catch(error => { if (alive()) log("error", "remote event recovery failed", error); });
    }
    function register(id: string) {
      check();
      if (!id) throw new Error("remote session id is empty");
      listingChanges?.add(id);
      registered.add(id);
      if (ready) router.registerBackend(makeRemoteSessionId(hostKey, id), backend);
    }
    function unregister(id: string) {
      listingChanges?.add(id);
      registered.delete(id);
      watched.delete(id);
      bridge.forgetSession(id);
      router.unregisterBackend(makeRemoteSessionId(hostKey, id));
    }
    async function watch(id: string) {
      const epoch = transportGeneration;
      await subscriptions.remove(id);
      check(epoch);
      // A snapshot is the authoritative recovery boundary. Replay starts after
      // it, so old deltas and already-resolved prompts cannot be appended again.
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await client.request<{ snapshot?: RacpSessionSnapshot }>("session/attach", { sessionId: id, includeSnapshot: true });
        check(epoch);
        if (!registered.has(id)) return;
        const snapshot = result.snapshot;
        if (!snapshot || snapshot.session?.id !== id || !snapshot.cursor) throw new Error(`remote session/attach returned no valid snapshot for ${id}`);
        bridge.restoreSnapshot(snapshot);
        const complete = await subscriptions.subscribe(id, snapshot.cursor);
        check(epoch);
        if (!registered.has(id)) { await subscriptions.remove(id); return; }
        if (complete) return;
        await subscriptions.remove(id);
        check(epoch);
      }
      throw new Error(`remote event cursor could not be recovered for ${id}`);
    }
    async function list() {
      const epoch = transportGeneration;
      const before = new Set(registered);
      const changed = new Set<string>();
      listingChanges = changed;
      let result: { sessions: RacpSession[] };
      try { result = await client.request<{ sessions: RacpSession[] }>("session/list"); }
      finally { if (listingChanges === changed) listingChanges = undefined; }
      check(epoch);
      if (!Array.isArray(result.sessions)) throw new Error("remote session/list returned no sessions");
      const sessions = result.sessions.filter(s => !changed.has(s.id) || registered.has(s.id));
      const live = new Set(sessions.map(s => s.id));
      for (const id of before) {
        if (!live.has(id) && !changed.has(id)) { unregister(id); await subscriptions.remove(id); check(epoch); }
      }
      for (const session of sessions) if (!changed.has(session.id)) register(session.id);
      return sessions;
    }
    function ensure(id: string) {
      try { register(id); } catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        const epoch = transportGeneration;
        if (!registered.has(id)) return;
        if (watched.has(id) && subscriptions.get(id)?.subscriptionId && !subscriptions.get(id)?.paused) {
          watched.delete(id); watched.add(id);
          return;
        }
        if (!watched.has(id) && watched.size >= limit) {
          const oldest = watched.values().next().value;
          if (oldest !== undefined) { watched.delete(oldest); await subscriptions.remove(oldest); check(epoch); }
        }
        watched.add(id);
        try { await watch(id); }
        catch (error) {
          watched.delete(id);
          if (alive() && epoch === transportGeneration) router.unregisterBackend(makeRemoteSessionId(hostKey, id));
          throw error;
        }
      });
    }
    async function host(after?: RacpCursor) {
      const epoch = transportGeneration;
      await subscriptions.remove(); check(epoch);
      const complete = await subscriptions.subscribe(undefined, after); check(epoch);
      if (!complete) { await subscriptions.remove(); check(epoch); await subscriptions.subscribe(); check(epoch); }
      return list();
    }
    function recover(id?: string) {
      const key = id === undefined ? "host" : `session:${id}`;
      const existing = recovering.get(key);
      if (existing) return existing;
      const result = enqueue(async () => {
        const epoch = transportGeneration;
        if (id !== undefined) {
          if (!registered.has(id) || !watched.has(id)) return;
          await watch(id);
        } else {
          await host(); check(epoch);
          for (const watchedId of watched) { await watch(watchedId); check(epoch); }
        }
        check(epoch);
        emit(IPC.event.sessionsChanged, { reason: "remote.resync" });
      }).catch(error => {
        if (alive()) {
          const affected = id === undefined ? registered : [id];
          for (const sessionId of affected) router.unregisterBackend(makeRemoteSessionId(hostKey, sessionId));
          emit(IPC.event.sessionsChanged, { reason: "remote.recovery.failed" });
        }
        throw error;
      });
      recovering.set(key, result);
      void result.finally(() => { if (recovering.get(key) === result) recovering.delete(key); }).catch(() => undefined);
      return result;
    }
    async function reconnect() {
      transportGeneration++;
      online = true;
      ready = false;
      for (const id of registered) router.unregisterBackend(makeRemoteSessionId(hostKey, id));
      return enqueue(async () => {
        const epoch = transportGeneration;
        const cursor = subscriptions.get()?.cursor;
        await subscriptions.clear(true); check(epoch);
        await host(cursor); check(epoch);
        for (const id of watched) { await watch(id); check(epoch); }
        ready = true;
        for (const id of registered) router.registerBackend(makeRemoteSessionId(hostKey, id), backend);
        if (client.state?.() === "reconnecting") refreshAfterReconnect = true;
        else emit(IPC.event.sessionsChanged, { reason: "remote.reconnected" });
      });
    }
    detachers.push(client.subscribe(event => { if (alive()) subscriptions.handle(event); }));
    if (client.subscribeReconnect) detachers.push(client.subscribeReconnect(reconnect));
    if (client.subscribeState) detachers.push(client.subscribeState(state => {
      if (token !== generation || state === "connecting") return;
      if (state === "connected") {
        if (refreshAfterReconnect) {
          refreshAfterReconnect = false;
          emit(IPC.event.sessionsChanged, { reason: "remote.reconnected" });
        }
        return;
      }
      const wasOnline = online;
      online = false; ready = false; transportGeneration++;
      subscriptions.pause();
      for (const id of registered) router.unregisterBackend(makeRemoteSessionId(hostKey, id));
      if (wasOnline) emit(IPC.event.sessionsChanged, { reason: "remote.disconnected" });
    }));
    if (client.subscribeSubscriptionClosed) detachers.push(client.subscribeSubscriptionClosed(notice => {
      if (alive()) subscriptions.closed(notice.subscriptionId);
    }));
    const opened = enqueue(async () => {
      const sessions = await host();
      // Active sessions first, then recently updated idle sessions, within the
      // protocol's fixed subscription budget. All listed sessions are routable.
      sessions.sort((a, b) => Number(b.status !== "idle") - Number(a.status !== "idle") || b.updatedAt.localeCompare(a.updatedAt));
      for (const session of sessions.slice(0, limit)) { watched.add(session.id); await watch(session.id); }
      check();
      ready = true;
      for (const id of registered) router.registerBackend(makeRemoteSessionId(hostKey, id), backend);
    });
    return { opened, ensure, async close() {
      for (const detach of detachers.splice(0)) detach();
      for (const id of registered) router.unregisterBackend(makeRemoteSessionId(hostKey, id));
      registered.clear(); watched.clear(); recovering.clear();
      const state = client.state?.();
      await subscriptions.clear(state !== undefined && state !== "connected");
    } };
  }
  return {
    hostKey,
    async open() {
      if (!current) {
        const run = start();
        current = run;
      }
      const run = current;
      try { await run.opened; }
      catch (error) { if (current === run) { current = undefined; generation++; await run.close(); } throw error; }
    },
    ensureSession(id) { return current ? current.ensure(id) : Promise.reject(disconnected()); },
    async close() {
      const run = current;
      current = undefined; generation++;
      await run?.close();
    },
  };
}
