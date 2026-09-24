import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("@pi-desktop/shared");
const { createBackendRouter, makeRemoteSessionId } = await import(
  "../electron/main/remote/backend-router.ts"
);
const { createRemoteHostConnection } = await import(
  "../electron/main/remote/remote-host-connection.ts"
);

const HOST_KEY = "hostA";

/** A minimal RacpClient/subscribe double. Records requests and lets tests
 * push envelopes back to whichever listener attached last. */
function fakeClient({ sessions = [], requestFailures = {}, responses = {} } = {}) {
  const calls = [];
  let listener = null;
  let next = 0;
  return {
    calls,
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
    // Test-only escape hatch used to inject envelopes as if from the host.
    push(envelope) {
      if (!listener) throw new Error("no listener attached");
      listener(envelope);
    },
    hasListener: () => listener !== null,
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

function setup({ sessions = [], requestFailures = {}, responses = {} } = {}) {
  const events = [];
  const router = createBackendRouter();
  const client = fakeClient({ sessions, requestFailures, responses });
  const conn = createRemoteHostConnection({
    hostKey: HOST_KEY,
    hostLabel: "Host A",
    client,
    router,
    emit: (channel, payload) => events.push({ channel, payload }),
    newRequestId: () => "req-const",
  });
  return { conn, router, client, events };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const remote = (id) => makeRemoteSessionId(HOST_KEY, id);

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
