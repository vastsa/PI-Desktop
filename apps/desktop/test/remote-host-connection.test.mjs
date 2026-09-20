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
function fakeClient({ sessions = [], requestFailures = {} } = {}) {
  const calls = [];
  let listener = null;
  return {
    calls,
    request: async (method, params) => {
      calls.push({ method, params });
      if (requestFailures[method]) throw requestFailures[method];
      if (method === "session/list") return { sessions };
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
    mode: "chat",
    status: "idle",
    planningState: "inactive",
    permissionMode: "default",
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

function setup({ sessions = [], requestFailures = {} } = {}) {
  const events = [];
  const router = createBackendRouter();
  const client = fakeClient({ sessions, requestFailures });
  const conn = createRemoteHostConnection({
    hostKey: HOST_KEY,
    client,
    router,
    emit: (channel, payload) => events.push({ channel, payload }),
    newRequestId: () => "req-const",
  });
  return { conn, router, client, events };
}

test("open subscribes host scope, lists sessions, and registers a backend per session", async () => {
  const { conn, router, client } = setup({ sessions: [makeSession("s1"), makeSession("s2")] });
  await conn.open();
  const methods = client.calls.map((entry) => entry.method);
  // Host-scope subscribe fires BEFORE list; the create-race window is closed.
  assert.deepEqual(methods.slice(0, 3), ["events/subscribe", "session/list", "events/subscribe"]);
  assert.deepEqual(client.calls[0].params, { scope: "host" });
  const perSessionSubscribeParams = client.calls
    .filter((entry) => entry.method === "events/subscribe" && entry.params.scope === "session")
    .map((entry) => entry.params.sessionId)
    .sort();
  assert.deepEqual(perSessionSubscribeParams, ["s1", "s2"]);
  // The router now resolves both session ids to the remote backend.
  const backend = router.resolveBackend(IPC.invoke.sessionGet, [
    { id: makeRemoteSessionId(HOST_KEY, "s1") },
  ]);
  assert.ok(backend, "router must have a backend for s1");
  assert.ok(
    router.resolveBackend(IPC.invoke.sessionGet, [{ id: makeRemoteSessionId(HOST_KEY, "s2") }]),
  );
});

test("open is idempotent — a second call does not re-subscribe or re-register", async () => {
  const { conn, client } = setup({ sessions: [makeSession("s1")] });
  await conn.open();
  const first = client.calls.length;
  await conn.open();
  assert.equal(client.calls.length, first);
});

test("a session.created event registers a fresh backend and refreshes the sidebar", async () => {
  const { conn, router, client, events } = setup({ sessions: [] });
  await conn.open();
  const newRemoteId = makeRemoteSessionId(HOST_KEY, "s-new");
  client.push(
    makeEnvelope({
      scope: "host",
      kind: "session.created",
      payload: { session: { id: "s-new", title: "new" } },
    }),
  );
  assert.ok(
    router.resolveBackend(IPC.invoke.sessionGet, [{ id: newRemoteId }]),
    "s-new must have a registered backend after session.created",
  );
  const sidebarNotice = events.find(
    (event) => event.channel === IPC.event.sessionsChanged && event.payload.selectSessionId === newRemoteId,
  );
  assert.ok(sidebarNotice, "session.created must emit a sessionsChanged notice for the sidebar");
});

test("a session.archived event unregisters the backend and lets the id fall through", async () => {
  const s1 = makeSession("s1");
  const { conn, router, client } = setup({ sessions: [s1] });
  await conn.open();
  const remoteId = makeRemoteSessionId(HOST_KEY, "s1");
  assert.ok(router.resolveBackend(IPC.invoke.sessionGet, [{ id: remoteId }]));
  client.push(
    makeEnvelope({
      scope: "host",
      kind: "session.archived",
      payload: { session: { id: "s1" } },
    }),
  );
  assert.equal(router.resolveBackend(IPC.invoke.sessionGet, [{ id: remoteId }]), null);
});

test("close detaches the listener and unregisters every session", async () => {
  const { conn, router, client } = setup({ sessions: [makeSession("s1"), makeSession("s2")] });
  await conn.open();
  await conn.close();
  assert.equal(client.hasListener(), false);
  assert.equal(
    router.resolveBackend(IPC.invoke.sessionGet, [{ id: makeRemoteSessionId(HOST_KEY, "s1") }]),
    null,
  );
});

test("close is idempotent and safe to call before open", async () => {
  const { conn } = setup();
  await conn.close();
  await conn.open();
  await conn.close();
  await conn.close();
});

test("session/list failure leaves the connection registered for nothing but does not throw", async () => {
  const { conn, router, client } = setup({
    sessions: [makeSession("s1")],
    requestFailures: { "session/list": new Error("no route to host") },
  });
  await conn.open();
  assert.equal(
    router.resolveBackend(IPC.invoke.sessionGet, [{ id: makeRemoteSessionId(HOST_KEY, "s1") }]),
    null,
  );
  assert.equal(client.hasListener(), true);
});
