import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { harness, OWNER_TOKEN, MemoryLink } = await import("@pi-desktop/racp/test-harness");
const { IPC } = await import("@pi-desktop/shared");
const { createRacpRemoteHostClient } = await import("../electron/main/remote/racp-remote-host-client.ts");
const { createRemoteHostConnection } = await import("../electron/main/remote/remote-host-connection.ts");
const { createBackendRouter } = await import("../electron/main/remote/backend-router.ts");

async function fixture() {
  const h = await harness();
  const links = [];
  const reconnectStarted = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const recovered = Promise.withResolvers();
  let attempts = 0;
  const adapter = createRacpRemoteHostClient({
    clientInfo: { name: "offline-fixture", version: "1" },
    reconnect: { enabled: true, baseDelayMs: 0, maxAttempts: 2 }, requestTimeoutMs: 500,
    onReconnected: async () => { recovered.resolve(); },
    transport: async () => {
      if (++attempts > 1) { reconnectStarted.resolve(); await gate.promise; }
      const auth = await h.authenticator.authenticate({ authorization: `Bearer ${OWNER_TOKEN}`, urlHasToken: false, connectionId: `test-${attempts}` });
      const link = new MemoryLink();
      links.push(link);
      h.server.accept(auth, link.serverSide());
      return link.clientSide();
    },
  });
  return { h, adapter, links, gate, reconnectStarted, recovered };
}

test("real adapter reconnect restores an offline approval once and keeps other event subscribers", { timeout: 5000 }, async t => {
  const f = await fixture();
  const events = [], raw = [];
  const router = createBackendRouter();
  const conn = createRemoteHostConnection({ hostKey: "h", client: f.adapter.client, router, emit: (channel, payload) => events.push({ channel, payload }) });
  t.after(async () => { await conn.close(); await f.adapter.close(); });
  await f.adapter.connect();
  f.adapter.client.subscribe(e => raw.push(e));
  await conn.open();
  await f.adapter.client.request("turn/start", { sessionId: "s1", input: { text: "offline test" }, context: { requestId: "start" } });
  f.h.host.ingest({ sessionId: "s1", turnId: "rt_1", ts: 1, event: { type: "agent_start" } });
  f.links[0].drop();
  await f.reconnectStarted.promise;
  assert.equal(router.resolveBackend(IPC.invoke.sessionGet, [{ id: "remote:h:s1" }]), null);
  f.h.host.ingest({ sessionId: "s1", turnId: "rt_1", ts: 2, event: { type: "tool_permission_request", request: { requestId: "permission", sessionId: "s1", toolCallId: "tc", toolName: "Read", argsPreview: "file", risk: "low", reason: "fixture" } } });
  f.gate.resolve();
  await f.recovered.promise;
  const backend = router.resolveBackend(IPC.invoke.sessionGet, [{ id: "remote:h:s1" }]);
  assert.ok(backend);
  await backend.invoke(IPC.invoke.sessionGet, [{ id: "remote:h:s1" }]);
  await backend.invoke(IPC.invoke.sessionGet, [{ id: "remote:h:s1" }]);
  assert.equal(events.filter(e => e.payload.event?.type === "tool_permission_request").length, 1);
  assert.ok(events.some(e => e.payload.reason === "remote.reconnected"));
  assert.equal(f.h.runtime.prompts.length, 1, "recovery must not replay the turn mutation");
  await f.adapter.client.request("approval/respond", { approvalId: "permission", decision: "deny", context: { requestId: "resolve" } });
  await f.adapter.client.request("session/list"); // Protocol round-trip flushes prior notifications.
  assert.ok(raw.some(e => e.kind === "approval.resolved"));
  assert.ok(f.links[1].toServer.map(JSON.parse).some(m => m.method === "events/ack"));
});

test("close during automatic transport reconnect closes the late transport without callbacks", { timeout: 5000 }, async () => {
  const f = await fixture();
  await f.adapter.connect();
  f.links[0].drop();
  await f.reconnectStarted.promise;
  await f.adapter.close();
  f.gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.adapter.state(), "disconnected");
  assert.equal(f.links[1].isOpen, false);
  await assert.rejects(f.adapter.client.request("session/list"), error => error.code === "HOST_DISCONNECTED");
});

test("failed reconnect recovery closes each transport and exhausts the attempt budget", { timeout: 5000 }, async t => {
  const f = await fixture();
  t.after(() => f.adapter.close());
  const exhausted = Promise.withResolvers();
  f.adapter.client.subscribeState(state => { if (state === "error") exhausted.resolve(); });
  f.adapter.client.subscribeReconnect(async () => { throw new Error("snapshot refused"); });
  await f.adapter.connect();
  f.links[0].drop();
  f.gate.resolve();
  await exhausted.promise;
  assert.equal(f.adapter.state(), "error");
  assert.equal(f.links.length, 3);
  assert.ok(f.links.every(link => !link.isOpen));
});

test("adapter stays reconnecting until all subscription recovery listeners finish", { timeout: 5000 }, async t => {
  const f = await fixture();
  t.after(() => f.adapter.close());
  const started = Promise.withResolvers(), finish = Promise.withResolvers(), online = Promise.withResolvers();
  f.adapter.client.subscribeReconnect(async () => { started.resolve(); await finish.promise; });
  await f.adapter.connect();
  f.adapter.client.subscribeState(state => { if (state === "connected") online.resolve(); });
  f.links[0].drop();
  f.gate.resolve();
  await started.promise;
  assert.equal(f.adapter.state(), "reconnecting");
  assert.equal(f.adapter.client.state(), "reconnecting");
  finish.resolve();
  await online.promise;
  assert.equal(f.adapter.state(), "connected");
});
