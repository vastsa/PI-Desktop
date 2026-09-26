import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("@pi-desktop/shared");
const { createBackendRouter, makeRemoteApprovalRequestId, makeRemoteSessionId } = await import(
  "../electron/main/remote/backend-router.ts"
);
const { createRemoteHostConnection } = await import(
  "../electron/main/remote/remote-host-connection.ts"
);

const HOST_KEY = "hostA";

/** A minimal RacpClient/subscribe double. Records requests and lets tests
 * push envelopes back to whichever listener attached last. */
function fakeClient({ sessions = [], requestFailures = {}, responses = {}, hostCapabilities = {} } = {}) {
  const calls = [];
  let listener = null;
  let next = 0;
  const subscriptionCloseListeners = new Set();
  const serverRequestListeners = new Set();
  const stateListeners = new Set();
  const reconnectListeners = new Set();
  return {
    calls,
    hostCapabilities: () => hostCapabilities,
    initialized: () => ({ principal: { roles: ["owner"] } }),
    cursorFor: (sessionId) => ({ epoch: "epoch-1", sequence: sessionId === "s1" ? 8 : 0 }),
    cursorForHost: () => ({ epoch: "epoch-1", sequence: 4 }),
    request: async (method, params) => {
      calls.push({ method, params });
      if (requestFailures[method]) throw requestFailures[method];
      if (responses[method]) return responses[method](params);
      if (method === "session/list") return { sessions };
      if (method === "events/subscribe") return { subscriptionId: `sub-${++next}` };
      return { ok: true };
    },
    subscribe: (fn) => {
      listener = fn;
      return () => {
        if (listener === fn) listener = null;
      };
    },
    onSubscriptionClosed: (fn) => {
      subscriptionCloseListeners.add(fn);
      return () => subscriptionCloseListeners.delete(fn);
    },
    onServerRequest: (fn) => {
      serverRequestListeners.add(fn);
      return () => serverRequestListeners.delete(fn);
    },
    onConnectionState: (fn) => {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },
    onReconnected: (fn) => {
      reconnectListeners.add(fn);
      return () => reconnectListeners.delete(fn);
    },
    // Test-only escape hatch used to inject envelopes as if from the host.
    push(envelope) {
      if (!listener) throw new Error("no listener attached");
      listener(envelope);
    },
    hasListener: () => listener !== null,
    async recover() {
      for (const fn of reconnectListeners) await fn();
    },
    closeSubscription(notice) {
      for (const fn of subscriptionCloseListeners) fn(notice);
    },
    changeState(state, error) {
      for (const fn of stateListeners) fn(state, error);
    },
    async serverRequest(method, params) {
      const handlers = [...serverRequestListeners];
      if (handlers.length !== 1) throw new Error("no unique server request handler");
      return handlers[0](method, params);
    },
  };
}

function makeSession(id, overrides = {}) {
  return {
    id,
    title: id,
    mode: "agent",
    status: "idle",
    planningState: "inactive",
    permissionMode: "ask",
    queuedTurnIds: [],
    revision: 1,
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

function lifecycleEnvelope(kind, session) {
  return makeEnvelope({
    scope: "host",
    kind,
    payload: { session },
  });
}

function makeEnvelope(overrides = {}) {
  return {
    eventId: "e1",
    scope: "session",
    epoch: "epoch-1",
    revision: 1,
    kind: "item.started",
    occurredAt: "2026-09-18T10:00:00.000Z",
    payload: {},
    ...overrides,
  };
}

function setup({ sessions = [], requestFailures = {}, responses = {}, hostCapabilities = {}, toolRelay, onEmit } = {}) {
  const events = [];
  const router = createBackendRouter();
  const client = fakeClient({ sessions, requestFailures, responses, hostCapabilities });
  const conn = createRemoteHostConnection({
    hostKey: HOST_KEY,
    hostLabel: "Host A",
    client,
    router,
    emit: (channel, payload) => {
      events.push({ channel, payload });
      onEmit?.(channel, payload);
    },
    newRequestId: () => "req-const",
    ...(toolRelay ? { toolRelay } : {}),
  });
  return { conn, router, client, events };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail("condition did not become true");
}
const remote = (id) => makeRemoteSessionId(HOST_KEY, id);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("open registers the host, subscribes host scope before listing, and subscribes no session", async () => {
  const { conn, router, client } = setup({ sessions: [makeSession("s1"), makeSession("s2")] });
  await conn.open();
  const methods = client.calls.map((entry) => entry.method);
  // Host-scope subscribe fires BEFORE list; the create-race window is closed.
  assert.deepEqual(methods, ["events/subscribe", "session/list"]);
  assert.deepEqual(client.calls[0].params, { scope: "host" });
  // One registration covers every session of the host.
  assert.ok(router.backendForHost(HOST_KEY));
});

test("listSessions returns cached summaries newest first", async () => {
  const { conn } = setup({
    sessions: [
      makeSession("old", { updatedAt: "2026-09-18T10:00:00.000Z" }),
      makeSession("new", { updatedAt: "2026-09-19T10:00:00.000Z", workspaceLabel: "repo" }),
    ],
  });
  assert.deepEqual(conn.listSessions(), []);
  await conn.open();
  const listed = conn.listSessions();
  assert.deepEqual(listed.map((s) => s.id), [remote("new"), remote("old")]);
  assert.equal(listed[0].source, "remote");
  assert.deepEqual(listed[0].remote, { hostKey: HOST_KEY, hostLabel: "Host A", workspaceLabel: "repo" });
  const noted = conn.noteSession(makeSession("fresh", { updatedAt: "2026-09-20T10:00:00.000Z" }));
  assert.equal(noted.id, remote("fresh"));
  assert.equal(conn.listSessions()[0].id, remote("fresh"));
});

test("a remote session exposes the terminal surface only when its Host advertises it", async () => {
  const available = setup({
    sessions: [makeSession("s-terminal")],
    hostCapabilities: { terminal: true },
  });
  await available.conn.open();
  assert.equal(available.conn.listSessions()[0].capabilities.canTerminal, true);

  const unavailable = setup({ sessions: [makeSession("s-no-terminal")] });
  await unavailable.conn.open();
  assert.equal(unavailable.conn.listSessions()[0].capabilities.canTerminal, false);
});

test("open is idempotent — a second call does not re-subscribe or re-register", async () => {
  const { conn, client } = setup({ sessions: [makeSession("s1")] });
  await conn.open();
  const first = client.calls.length;
  await conn.open();
  assert.equal(client.calls.length, first);
});

test("session.created / changed / archived events keep the cache current without stealing focus", async () => {
  const { conn, client, events } = setup({ sessions: [makeSession("s1")] });
  await conn.open();
  client.push(
    makeEnvelope({
      scope: "host",
      kind: "session.created",
      payload: {
        session: {
          id: "s-new",
          title: "new",
          mode: "agent",
          permissionMode: "ask",
          planningState: "inactive",
          revision: 1,
          createdAt: "2026-09-19T10:00:00.000Z",
          updatedAt: "2026-09-19T10:00:00.000Z",
        },
      },
    }),
  );
  assert.deepEqual(conn.listSessions().map((s) => s.id), [remote("s-new"), remote("s1")]);
  const notice = events.find((event) => event.channel === IPC.event.sessionsChanged);
  assert.ok(notice, "session.created must emit a sessionsChanged notice for the sidebar");
  assert.equal(notice.payload.selectSessionId, undefined);

  client.push(
    makeEnvelope({
      scope: "host",
      kind: "session.changed",
      payload: { session: { id: "s1", title: "renamed", updatedAt: "2026-09-20T10:00:00.000Z" } },
    }),
  );
  assert.equal(conn.listSessions()[0].title, "renamed");

  // A status-only change for an unknown session waits for the next list.
  client.push(
    makeEnvelope({ scope: "host", kind: "session.changed", payload: { sessionId: "ghost", status: "running" } }),
  );
  assert.equal(conn.listSessions().length, 2);

  client.push(
    makeEnvelope({ scope: "host", kind: "session.archived", payload: { session: { id: "s1" } } }),
  );
  assert.deepEqual(conn.listSessions().map((s) => s.id), [remote("s-new")]);
});

test("a sessionGet tail read subscribes that session's scope on demand, after the attach cursor", async () => {
  const cursor = { epoch: "epoch-1", sequence: 42 };
  const { conn, router, client } = setup({
    sessions: [makeSession("s1"), makeSession("s2")],
    responses: {
      "session/attach": () => ({
        session: makeSession("s1"),
        snapshot: {
          session: makeSession("s1"),
          items: [],
          activeItems: [],
          hasMoreHistory: false,
          cursor,
        },
      }),
    },
  });
  await conn.open();
  const outcome = await router.route(IPC.invoke.sessionGet, [{ id: remote("s1"), messageLimit: 50 }]);
  assert.equal(outcome.remote, true);
  assert.equal(outcome.value.session.id, remote("s1"));
  await flush();
  const sessionSubscribes = client.calls.filter(
    (entry) => entry.method === "events/subscribe" && entry.params.scope === "session",
  );
  assert.deepEqual(sessionSubscribes.map((entry) => entry.params), [
    { scope: "session", sessionId: "s1", after: cursor },
  ]);
});

test("close detaches the listener and unregisters the host; remote calls then fail closed", async () => {
  const { conn, router, client } = setup({ sessions: [makeSession("s1"), makeSession("s2")] });
  await conn.open();
  await conn.close();
  assert.equal(client.hasListener(), false);
  assert.equal(router.backendForHost(HOST_KEY), null);
  assert.deepEqual(conn.listSessions(), []);
  await assert.rejects(
    router.route(IPC.invoke.sessionGet, [{ id: remote("s1") }]),
    (error) => error.errorCode === "HOST_UNAVAILABLE",
  );
});

test("close does not drop a replacement connection's registration", async () => {
  const { conn, router } = setup();
  await conn.open();
  const replacement = { handles: () => true, invoke: async () => null };
  router.registerHost(HOST_KEY, replacement);
  await conn.close();
  assert.equal(router.backendForHost(HOST_KEY), replacement);
});

test("close is idempotent and safe to call before open", async () => {
  const { conn } = setup();
  await conn.close();
  await conn.open();
  await conn.close();
  await conn.close();
});

test("session/list failure keeps the host registered with an empty list and does not throw", async () => {
  const { conn, router, client } = setup({
    sessions: [makeSession("s1")],
    requestFailures: { "session/list": new Error("no route to host") },
  });
  await conn.open();
  assert.deepEqual(conn.listSessions(), []);
  assert.ok(router.backendForHost(HOST_KEY));
  assert.equal(client.hasListener(), true);
});

test("reconnect restores cursors, overlays ordered lifecycle events on the snapshot, then re-advertises", async () => {
  const snapshot = deferred();
  let listCalls = 0;
  const capabilities = { terminal: true };
  const relayCalls = [];
  const order = [];
  const toolRelay = {
    addSession: async (sessionId) => { relayCalls.push(["add", sessionId]); order.push(`add:${sessionId}`); },
    removeSession: (sessionId) => { relayCalls.push(["remove", sessionId]); order.push(`remove:${sessionId}`); },
    handleServerRequest: async () => ({ result: "ok", isError: false }),
    disconnected: () => relayCalls.push(["disconnected"]),
    reconnected: async () => { relayCalls.push(["reconnected"]); order.push("relay-reconnected"); },
    close: () => relayCalls.push(["close"]),
  };
  const { conn, client, router, events } = setup({
    sessions: [makeSession("s1"), makeSession("s3")],
    hostCapabilities: capabilities,
    toolRelay,
    onEmit: (_channel, payload) => {
      if (payload.reason === "remote.host.reconnected") order.push("host-reconnected-event");
    },
    responses: {
      "session/list": () => {
        listCalls += 1;
        if (listCalls === 1) return { sessions: [makeSession("s1"), makeSession("s3")] };
        return snapshot.promise;
      },
      "session/attach": () => ({
        session: makeSession("s1"),
        snapshot: { session: makeSession("s1"), items: [], activeItems: [], hasMoreHistory: false, cursor: { epoch: "epoch-1", sequence: 8 } },
      }),
    },
  });
  await conn.open();
  await router.route(IPC.invoke.sessionGet, [{ id: remote("s1"), messageLimit: 10 }]);
  client.changeState("reconnecting");
  capabilities.terminal = false;

  const restoring = client.recover();
  await waitFor(() => listCalls === 2);
  assert.ok(client.calls.some((call) => call.method === "events/subscribe" &&
    call.params.scope === "host" && call.params.after?.sequence === 4));
  assert.ok(client.calls.some((call) => call.method === "events/subscribe" &&
    call.params.scope === "session" && call.params.sessionId === "s1" && call.params.after?.sequence === 8));

  client.push(lifecycleEnvelope("session.changed", {
    id: "s1",
    title: "renamed during refresh",
    updatedAt: "2026-09-21T10:00:00.000Z",
  }));
  client.push(lifecycleEnvelope("session.created", makeSession("s2")));
  client.push(lifecycleEnvelope("session.archived", { id: "s3" }));
  snapshot.resolve({ sessions: [makeSession("s1", { title: "stale snapshot" }), makeSession("s3")] });
  await restoring;

  const listed = conn.listSessions();
  assert.equal(listed.find((session) => session.id === remote("s1")).title, "renamed during refresh");
  assert.ok(listed.some((session) => session.id === remote("s2")));
  assert.equal(listed.some((session) => session.id === remote("s3")), false);
  assert.equal(listed.find((session) => session.id === remote("s1")).capabilities.canTerminal, false);
  assert.deepEqual(relayCalls.filter(([kind]) => kind === "remove"), [["remove", "s3"]]);
  const recoveryRelayIndex = relayCalls.findIndex(([kind]) => kind === "reconnected");
  const lastRestoredSessionIndex = Math.max(
    relayCalls.findIndex(([kind, sessionId]) => kind === "add" && sessionId === "s1"),
    relayCalls.findIndex(([kind, sessionId]) => kind === "add" && sessionId === "s2"),
  );
  assert.ok(recoveryRelayIndex > lastRestoredSessionIndex);
  assert.ok(order.indexOf("host-reconnected-event") > order.indexOf("relay-reconnected"));
  assert.ok(events.some(({ payload }) => payload.reason === "remote.host.reconnecting" && payload.hostKey === HOST_KEY));
  assert.ok(events.some(({ payload }) => payload.reason === "remote.host.reconnected" && payload.hostKey === HOST_KEY));
});

test("an epoch resync reattaches the session and restores its pending approval and queue", async () => {
  let hostSubscribes = 0;
  let sessionSubscribes = 0;
  let attaches = 0;
  const pendingApproval = {
    id: "approval-1",
    sessionId: "s1",
    turnId: "turn-1",
    kind: "tool",
    summary: "write a file",
    expiresAt: "2026-09-18T10:05:00.000Z",
    revision: 4,
    toolName: "write",
    risk: "high",
    allowedDecisions: ["allow-once", "deny"],
  };
  const { conn, router, client, events } = setup({
    sessions: [makeSession("s1")],
    responses: {
      "events/subscribe": (params) => {
        if (params.scope === "host") {
          hostSubscribes += 1;
          return {
            subscriptionId: `host-${hostSubscribes}`,
            starting: { epoch: "host-epoch", sequence: 5 },
            replayComplete: true,
          };
        }
        sessionSubscribes += 1;
        return sessionSubscribes === 1
          ? {
              subscriptionId: "session-1",
              starting: { epoch: "session-old", sequence: 9 },
              replayComplete: true,
            }
          : {
              subscriptionId: "session-2",
              starting: { epoch: "session-new", sequence: 1 },
              replayComplete: false,
              resyncReason: "epoch",
            };
      },
      "session/attach": () => {
        attaches += 1;
        const snapshot = {
          session: makeSession("s1", { status: "waiting_permission" }),
          queuedTurns: [],
          items: [],
          activeItems: [],
          pendingApprovals: attaches === 1 ? [] : [pendingApproval],
          pendingInputs: [],
          hasMoreHistory: false,
          cursor: attaches === 1
            ? { epoch: "session-old", sequence: 8 }
            : { epoch: "session-new", sequence: 2 },
          revision: 4,
          generatedAt: "2026-09-18T10:01:00.000Z",
        };
        return { session: snapshot.session, snapshot };
      },
      "session/get": () => ({
        session: makeSession("s1", { queuedTurnIds: ["queued-1"] }),
      }),
    },
  });

  await conn.open();
  await router.route(IPC.invoke.sessionGet, [{ id: remote("s1"), messageLimit: 10 }]);
  client.changeState("reconnecting");
  await client.recover();
  await waitFor(() => events.some(({ channel }) => channel === IPC.event.agentQueueChanged));

  assert.equal(attaches, 2, "reconnect must attach after subscribe reports an epoch gap");
  const reconnectSubscribe = client.calls.filter((call) => call.method === "events/subscribe" && call.params.scope === "session")[1];
  assert.deepEqual(reconnectSubscribe.params.after, { epoch: "session-old", sequence: 8 });
  const approvalEvent = events.find(({ channel, payload }) =>
    channel === IPC.event.agentMessage && payload.event.type === "tool_permission_request",
  );
  assert.equal(
    approvalEvent.payload.event.request.requestId,
    makeRemoteApprovalRequestId(remote("s1"), "approval-1"),
  );
  const queueEvent = events.find(({ channel }) => channel === IPC.event.agentQueueChanged);
  assert.equal(queueEvent.payload.sessionId, remote("s1"));
  assert.equal(queueEvent.payload.entries[0].content, "");
  const reconnected = events.find(({ payload }) => payload.reason === "remote.host.reconnected");
  assert.deepEqual(reconnected.payload.sessionResyncIds, [remote("s1")]);
});

test("a closed session subscription with an incomplete replay reattaches and refreshes the session", async () => {
  let sessionSubscribes = 0;
  let attaches = 0;
  const { conn, router, client, events } = setup({
    sessions: [makeSession("s1")],
    responses: {
      "events/subscribe": (params) => {
        if (params.scope === "host") return { subscriptionId: "host-1", replayComplete: true };
        sessionSubscribes += 1;
        return sessionSubscribes === 1
          ? { subscriptionId: "session-1", replayComplete: true }
          : {
              subscriptionId: "session-2",
              replayComplete: false,
              resyncReason: "evicted",
            };
      },
      "session/attach": () => {
        attaches += 1;
        const session = makeSession("s1");
        return {
          session,
          snapshot: {
            session,
            queuedTurns: [],
            items: [],
            activeItems: [],
            pendingApprovals: [],
            pendingInputs: [],
            hasMoreHistory: false,
            cursor: { epoch: "epoch-new", sequence: 3 },
            revision: 3,
            generatedAt: "2026-09-18T10:01:00.000Z",
          },
        };
      },
    },
  });

  await conn.open();
  await router.route(IPC.invoke.sessionGet, [{ id: remote("s1"), messageLimit: 10 }]);
  client.closeSubscription({
    subscriptionId: "session-1",
    error: { code: "EVENTS_CLOSED", message: "replay window expired" },
    lastSafeCursor: { epoch: "epoch-old", sequence: 9 },
  });
  await waitFor(() => attaches === 2);

  const notice = events.find(({ channel, payload }) =>
    channel === IPC.event.sessionsChanged && payload.reason === "remote.session.resynced",
  );
  assert.deepEqual(notice.payload.sessionResyncIds, [remote("s1")]);
  await conn.close();
});

test("a closed host subscription with an incomplete replay refreshes the session list", async () => {
  let hostSubscribes = 0;
  let listCalls = 0;
  const { conn, client, events } = setup({
    responses: {
      "events/subscribe": (params) => {
        if (params.scope !== "host") return { subscriptionId: "session-1", replayComplete: true };
        hostSubscribes += 1;
        return hostSubscribes === 1
          ? { subscriptionId: "host-1", replayComplete: true }
          : {
              subscriptionId: "host-2",
              replayComplete: false,
              resyncReason: "epoch",
            };
      },
      "session/list": () => {
        listCalls += 1;
        return { sessions: [makeSession("s1", { title: listCalls === 1 ? "old" : "new" })] };
      },
    },
  });

  await conn.open();
  assert.equal(conn.listSessions()[0].title, "old");
  client.closeSubscription({
    subscriptionId: "host-1",
    error: { code: "EVENTS_CLOSED", message: "replay window expired" },
    lastSafeCursor: { epoch: "host-old", sequence: 8 },
  });
  await waitFor(() => listCalls === 2);

  assert.equal(conn.listSessions()[0].title, "new");
  assert.ok(events.some(({ channel, payload }) =>
    channel === IPC.event.sessionsChanged && payload.reason === "remote.host.resynced",
  ));
  await conn.close();
});

test("closing during reconnect prevents a late snapshot from restoring sessions or relay state", async () => {
  const snapshot = deferred();
  let listCalls = 0;
  const relayCalls = [];
  const toolRelay = {
    addSession: async (sessionId) => relayCalls.push(["add", sessionId]),
    removeSession: (sessionId) => relayCalls.push(["remove", sessionId]),
    handleServerRequest: async () => ({ result: "ok", isError: false }),
    disconnected: () => relayCalls.push(["disconnected"]),
    reconnected: async () => relayCalls.push(["reconnected"]),
    close: () => relayCalls.push(["close"]),
  };
  const { conn, client, events } = setup({
    sessions: [makeSession("s1")],
    toolRelay,
    responses: {
      "session/list": () => {
        listCalls += 1;
        return listCalls === 1 ? { sessions: [makeSession("s1")] } : snapshot.promise;
      },
    },
  });
  await conn.open();
  const restoring = client.recover();
  await waitFor(() => listCalls === 2);
  await conn.close();
  snapshot.resolve({ sessions: [makeSession("late")] });
  await restoring;

  assert.deepEqual(conn.listSessions(), []);
  assert.equal(relayCalls.some(([kind]) => kind === "reconnected"), false);
  assert.equal(events.some(({ payload }) => payload.reason === "remote.host.reconnected"), false);
  assert.ok(relayCalls.some(([kind]) => kind === "close"));
});

test("connection status and tool request listeners are detached on close", async () => {
  const relayCalls = [];
  const toolRelay = {
    addSession: async () => undefined,
    removeSession: () => undefined,
    handleServerRequest: async (method, params) => {
      relayCalls.push([method, params]);
      return { result: "ok", isError: false };
    },
    disconnected: () => relayCalls.push(["disconnected"]),
    reconnected: async () => undefined,
    close: () => undefined,
  };
  const { conn, client, events } = setup({ toolRelay });
  await conn.open();
  assert.deepEqual(await client.serverRequest("tool/execute", { sessionId: "s1" }), { result: "ok", isError: false });
  client.changeState("reconnecting");
  client.changeState("error");
  assert.ok(events.some(({ payload }) => payload.reason === "remote.host.reconnecting"));
  assert.ok(events.some(({ payload }) => payload.reason === "remote.host.error"));
  await conn.close();
  await assert.rejects(client.serverRequest("tool/execute", {}), /handler/i);
});

test("a burst of queue-affecting session events emits agentQueueChanged once", async () => {
  const { conn, client, events } = setup({
    sessions: [makeSession("s1")],
    responses: {
      "session/get": () => ({ session: makeSession("s1", { queuedTurnIds: ["t2"] }) }),
    },
  });
  await conn.open();
  for (const kind of ["turn.completed", "turn.started", "turn.queued"]) {
    client.push(makeEnvelope({ sessionId: "s1", kind }));
  }
  // A non-queue kind does not trigger a sync.
  client.push(makeEnvelope({ sessionId: "s1", kind: "item.delta" }));
  await flush();
  const queueEvents = events.filter((event) => event.channel === IPC.event.agentQueueChanged);
  assert.equal(queueEvents.length, 1);
  assert.equal(queueEvents[0].payload.sessionId, remote("s1"));
  assert.deepEqual(
    queueEvents[0].payload.entries.map((entry) => entry.id),
    [`${remote("s1")}#racp-turn:t2`],
  );
  assert.equal(client.calls.filter((entry) => entry.method === "session/get").length, 1);

  // A later burst syncs again; after close nothing more is emitted.
  client.push(makeEnvelope({ sessionId: "s1", kind: "turn.canceled" }));
  await conn.close();
  await flush();
  assert.equal(events.filter((event) => event.channel === IPC.event.agentQueueChanged).length, 1);
});

test("queue sync discards an in-flight result when another queue event makes it dirty", async () => {
  const oldRead = deferred();
  const newRead = deferred();
  let sessionGets = 0;
  const { conn, router, client, events } = setup({
    sessions: [makeSession("s1")],
    responses: {
      "session/attach": () => ({
        session: makeSession("s1"),
        snapshot: {
          session: makeSession("s1"),
          queuedTurns: [],
          items: [],
          activeItems: [],
          pendingApprovals: [],
          pendingInputs: [],
          hasMoreHistory: false,
          cursor: { epoch: "epoch-1", sequence: 8 },
          revision: 1,
          generatedAt: "2026-09-18T10:01:00.000Z",
        },
      }),
      "session/get": () => {
        sessionGets += 1;
        if (sessionGets === 1) return oldRead.promise;
        return newRead.promise;
      },
    },
  });
  await conn.open();
  await router.route(IPC.invoke.sessionGet, [{ id: remote("s1"), messageLimit: 10 }]);
  client.push(makeEnvelope({ sessionId: "s1", kind: "turn.completed" }));
  await waitFor(() => sessionGets === 1);
  client.push(makeEnvelope({ sessionId: "s1", kind: "turn.queued" }));
  oldRead.resolve({ session: makeSession("s1", { queuedTurnIds: ["old"] }) });
  await flush();
  assert.equal(events.filter(({ channel }) => channel === IPC.event.agentQueueChanged).length, 0);
  await waitFor(() => sessionGets === 2);
  newRead.resolve({ session: makeSession("s1", { queuedTurnIds: ["t2", "t1"] }) });
  await waitFor(() => events.filter(({ channel }) => channel === IPC.event.agentQueueChanged).length === 1);
  const queueEvent = events.find(({ channel }) => channel === IPC.event.agentQueueChanged);
  assert.deepEqual(
    queueEvent.payload.entries.map((entry) => entry.id),
    [`${remote("s1")}#racp-turn:t2`, `${remote("s1")}#racp-turn:t1`],
  );
  await conn.close();
});

test("queue sync drops an in-flight result after the host connection closes", async () => {
  const read = deferred();
  const { conn, client, events } = setup({
    sessions: [makeSession("s1")],
    responses: {
      "session/get": () => read.promise,
    },
  });
  await conn.open();
  client.push(makeEnvelope({ sessionId: "s1", kind: "turn.completed" }));
  await waitFor(() => client.calls.some((call) => call.method === "session/get"));

  await conn.close();
  read.resolve({ session: makeSession("s1", { queuedTurnIds: ["stale"] }) });
  await flush();
  assert.equal(events.filter(({ channel }) => channel === IPC.event.agentQueueChanged).length, 0);
});

test("session attach applies its snapshot before cursor-ordered in-flight events", async () => {
  let sessionSubscribes = 0;
  let attaches = 0;
  const attach = deferred();
  const approval = {
    id: "approval-1",
    sessionId: "s1",
    turnId: "turn-1",
    kind: "tool",
    summary: "write a file",
    expiresAt: "2026-09-18T10:05:00.000Z",
    revision: 4,
    toolName: "write",
    risk: "high",
    allowedDecisions: ["allow-once", "deny"],
  };
  const session = makeSession("s1", {
    status: "waiting_permission",
    activeTurnId: "turn-1",
  });
  const { conn, router, client, events } = setup({
    sessions: [makeSession("s1")],
    responses: {
      "events/subscribe": (params) => {
        if (params.scope === "host") return { subscriptionId: "host-1", replayComplete: true };
        sessionSubscribes += 1;
        return sessionSubscribes === 1
          ? { subscriptionId: "session-1", replayComplete: true }
          : { subscriptionId: "session-2", replayComplete: false, resyncReason: "epoch" };
      },
      "session/get": () => ({ session }),
      "session/attach": () => {
        attaches += 1;
        if (attaches === 1) {
          return {
            session,
            snapshot: {
              session,
              queuedTurns: [],
              items: [],
              activeItems: [],
              pendingApprovals: [],
              pendingInputs: [],
              hasMoreHistory: false,
              cursor: { epoch: "epoch-1", sequence: 8 },
              revision: 1,
              generatedAt: "2026-09-18T10:00:00.000Z",
            },
          };
        }
        return attach.promise;
      },
    },
  });
  await conn.open();
  await router.route(IPC.invoke.sessionGet, [{ id: remote("s1"), messageLimit: 10 }]);
  client.closeSubscription({
    subscriptionId: "session-1",
    error: { code: "EVENTS_CLOSED", message: "replay window expired" },
    lastSafeCursor: { epoch: "epoch-1", sequence: 8 },
  });
  await waitFor(() => client.calls.filter((call) => call.method === "session/attach").length === 2);

  client.push(makeEnvelope({
    eventId: "approval-requested",
    epoch: "epoch-2",
    sequence: 10,
    kind: "approval.requested",
    sessionId: "s1",
    turnId: "turn-1",
    payload: approval,
  }));
  client.push(makeEnvelope({
    eventId: "approval-resolved",
    epoch: "epoch-2",
    sequence: 11,
    kind: "approval.resolved",
    sessionId: "s1",
    turnId: "turn-1",
    payload: { approvalId: "approval-1", status: "resolved" },
  }));
  client.push(makeEnvelope({
    eventId: "input-requested",
    epoch: "epoch-2",
    sequence: 12,
    kind: "input.requested",
    sessionId: "s1",
    turnId: "turn-1",
    payload: {
      id: "input-1",
      sessionId: "s1",
      turnId: "turn-1",
      expiresAt: "2026-09-18T10:05:00.000Z",
      questions: [{ id: "q1", question: "continue?", options: ["yes"], multiSelect: false }],
    },
  }));
  client.push(makeEnvelope({
    eventId: "session-idle",
    epoch: "epoch-2",
    sequence: 13,
    kind: "session.changed",
    sessionId: "s1",
    payload: { sessionId: "s1", status: "idle" },
  }));

  attach.resolve({
    session,
    snapshot: {
      session,
      activeTurn: { id: "turn-1", sessionId: "s1", status: "waiting_approval" },
      queuedTurns: [],
      items: [],
      activeItems: [],
      pendingApprovals: [approval],
      pendingInputs: [],
      hasMoreHistory: false,
      cursor: { epoch: "epoch-2", sequence: 10 },
      revision: 4,
      generatedAt: "2026-09-18T10:01:00.000Z",
    },
  });
  await waitFor(() => events.some(({ channel, payload }) =>
    channel === IPC.event.agentMessage && payload.event.type === "asktool_request",
  ));

  const agentEvents = events
    .filter(({ channel }) => channel === IPC.event.agentMessage)
    .map(({ payload }) => payload.event.type);
  assert.deepEqual(agentEvents, [
    "remote_snapshot_state",
    "tool_permission_request",
    "remote_approval_resolved",
    "asktool_request",
  ]);
  await conn.close();
});
