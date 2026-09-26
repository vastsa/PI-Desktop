import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createRacpRemoteHostClient } = await import(
  "../electron/main/remote/racp-remote-host-client.ts"
);
const { harness, OWNER_TOKEN, MemoryLink, flush } = await import("@pi-desktop/racp/test-harness");

/** Build a transport factory that authenticates OWNER_TOKEN and hands the
 * server the link's server side. Each call to the factory opens a fresh
 * `MemoryLink`, mirroring how the production ws factory opens a fresh socket
 * per (re)connect. */
function ownerTransport({ server, authenticator, links }) {
  return async () => {
    const auth = await authenticator.authenticate({
      authorization: `Bearer ${OWNER_TOKEN}`,
      urlHasToken: false,
      connectionId: `test-${Math.random()}`,
    });
    if (!auth) throw new Error("test authenticator refused OWNER_TOKEN");
    const link = new MemoryLink();
    links?.push(link);
    const accepted = server.accept(auth, link.serverSide());
    if (!accepted) throw new Error("test server refused connection");
    return link.clientSide();
  };
}

test("adapter connects, request delegates to RacpClient, close is clean", async () => {
  const h = await harness();
  const adapter = createRacpRemoteHostClient({
    transport: ownerTransport(h),
    clientInfo: { name: "test-desktop", version: "0.15.0" },
    requestTimeoutMs: 2_000,
  });
  assert.equal(adapter.state(), "disconnected");
  await adapter.connect();
  assert.equal(adapter.state(), "connected");
  const result = await adapter.client.request("session/list");
  assert.ok(Array.isArray(result.sessions));
  assert.ok(result.sessions.some((session) => session.id === "s1"));
  await adapter.close();
  assert.equal(adapter.state(), "disconnected");
});

test("subscribe fans out RACP events to every attached listener", async () => {
  const h = await harness();
  const adapter = createRacpRemoteHostClient({
    transport: ownerTransport(h),
    clientInfo: { name: "test-desktop", version: "0.15.0" },
    requestTimeoutMs: 2_000,
  });
  await adapter.connect();

  const a = [];
  const b = [];
  const detachA = adapter.client.subscribe((envelope) => a.push(envelope));
  const detachB = adapter.client.subscribe((envelope) => b.push(envelope));

  // Subscribe host scope so the following session/create surfaces as an event.
  await adapter.client.request("events/subscribe", { scope: "host" });
  await adapter.client.request("session/create", { title: "New" });
  // Let the socket flush the event notification.
  await new Promise((resolve) => setTimeout(resolve, 15));

  const kinds = a.map((envelope) => envelope.kind);
  assert.ok(kinds.includes("session.created"), "listener A should have seen session.created");
  assert.deepEqual(
    b.map((envelope) => envelope.kind),
    kinds,
    "both listeners must observe the same event stream",
  );

  detachA();
  a.length = 0;
  b.length = 0;
  await adapter.client.request("session/create", { title: "Another" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(a.length, 0, "detached listener must stop receiving events");
  assert.ok(b.length > 0, "still-attached listener continues to receive events");

  detachB();
  await adapter.close();
});

test("a listener that throws does not break the fan-out to the others", async () => {
  const h = await harness();
  const warnings = [];
  const adapter = createRacpRemoteHostClient({
    transport: ownerTransport(h),
    clientInfo: { name: "test-desktop", version: "0.15.0" },
    requestTimeoutMs: 2_000,
    log: (level, message, data) => {
      if (level === "warn") warnings.push({ message, data });
    },
  });
  await adapter.connect();

  adapter.client.subscribe(() => {
    throw new Error("bad listener");
  });
  const survivor = [];
  adapter.client.subscribe((envelope) => survivor.push(envelope));

  await adapter.client.request("events/subscribe", { scope: "host" });
  await adapter.client.request("session/create", { title: "New" });
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.ok(survivor.length > 0, "survivor must still receive events");
  assert.ok(
    warnings.some((entry) => /listener threw/.test(entry.message)),
    "adapter must log the failing listener",
  );

  await adapter.close();
});

test("request before connect rejects with HOST_DISCONNECTED", async () => {
  const h = await harness();
  const adapter = createRacpRemoteHostClient({
    transport: ownerTransport(h),
    clientInfo: { name: "test-desktop", version: "0.15.0" },
  });
  await assert.rejects(
    () => adapter.client.request("session/list"),
    (error) => error.code === "HOST_DISCONNECTED",
  );
});

test("adapter routes server requests, exposes cursors, and notifies state/reconnect listeners", async () => {
  const advertisements = [];
  const toolRelay = {
    advertise: (input) => advertisements.push(input),
    clearConnection: () => undefined,
    captureCatalog: () => ({ id: "catalog", tools: [] }),
    bindTurn: () => undefined,
    releaseCatalog: () => undefined,
    releaseTurn: () => undefined,
    async execute() {
      return { ok: false, errorCode: "TOOL_FAILED", content: { code: "TOOL_FAILED" } };
    },
  };
  const h = await harness({ toolRelay });
  const adapter = createRacpRemoteHostClient({
    transport: ownerTransport(h),
    clientInfo: { name: "test-desktop", version: "0.15.0" },
    requestTimeoutMs: 2_000,
    reconnect: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 2 },
  });
  const requests = [];
  const states = [];
  let reconnected = 0;
  let markReconnected;
  const reconnectSignal = new Promise((resolve) => { markReconnected = resolve; });
  const detachRequest = adapter.client.onServerRequest((method, params) => {
    requests.push({ method, params });
    return Promise.resolve({ result: { ok: true }, isError: false });
  });
  const detachState = adapter.client.onConnectionState((state) => states.push(state));
  const detachReconnect = adapter.client.onReconnected(() => {
    reconnected += 1;
    markReconnected();
  });
  await adapter.connect();
  await adapter.client.request("events/subscribe", { scope: "host" });
  await adapter.client.request("session/create", { title: "cursor" });
  assert.equal(adapter.client.initialized()?.principal.roles.includes("owner"), true);
  assert.ok(adapter.client.cursorForHost(), "the host cursor is exposed to subscription recovery");
  await adapter.client.request("events/subscribe", { scope: "session", sessionId: "s1" });
  h.host.ingest({
    sessionId: "s1",
    turnId: "rt_1",
    ts: Date.now(),
    event: {
      type: "message_end",
      message: {
        id: "cursor-item",
        role: "assistant",
        content: "cursor",
        createdAt: "2026-09-25T00:00:00.000Z",
        status: "complete",
      },
    },
  });
  await flush();
  assert.ok(adapter.client.cursorFor("s1"), "the session cursor is exposed to subscription recovery");

  await adapter.client.request("tools/advertise", {
    sessionId: "s1",
    tools: [{
      name: "mcp_global_lookup",
      description: "Look up a value",
      inputSchema: { type: "object", properties: {} },
      timeoutMs: 5_000,
      workspaceFree: true,
    }],
  });
  assert.equal(advertisements.length, 1);
  assert.deepEqual(
    await advertisements[0].request("tool/execute", { sessionId: "s1" }, 1_000),
    { result: { ok: true }, isError: false },
  );
  assert.deepEqual(requests, [{ method: "tool/execute", params: { sessionId: "s1" } }]);

  h.links[0].drop();
  await reconnectSignal;
  assert.ok(states.includes("reconnecting"));
  assert.ok(states.includes("connected"));
  assert.equal(reconnected, 1);

  detachRequest();
  detachState();
  detachReconnect();
  await adapter.close();
});
