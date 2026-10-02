import assert from "node:assert/strict";
import test from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { IPC } from "@pi-desktop/shared";

const here = dirname(fileURLToPath(import.meta.url));

const askRequest = {
  requestId: "ask_1",
  sessionId: "s1",
  toolCallId: "c9",
  questions: [
    {
      question: "Which?",
      options: [
        { label: "a", description: "First choice" },
        { label: "b", description: "Second choice" },
      ],
    },
  ],
};

function ingestAsk(bridge) {
  bridge.ingest({ sessionId: "s1", turnId: "rt_1", ts: Date.now(), event: { type: "agent_start" } });
  bridge.ingest({
    sessionId: "s1",
    turnId: "rt_1",
    ts: Date.now(),
    event: { type: "asktool_request", request: askRequest },
  });
}

test("resolveAskByRequestId settles the Host input so the card does not come back", async (t) => {
  const server = await createServer({
    root: dirname(here),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { createAgentHostBridge } = await server.ssrLoadModule("/electron/main/agent-host-bridge.ts");
  const calls = [];
  const bridge = createAgentHostBridge({
    channels: IPC.invoke,
    getHost: () => null,
    log: () => undefined,
    async invoke(channel, args) {
      calls.push({ channel, args });
      return { ok: true };
    },
  });

  ingestAsk(bridge);
  assert.equal((await bridge.pendingInteractiveRequests("s1")).asks.length, 1);

  const settled = await bridge.resolveAskByRequestId({
    sessionId: "s1",
    requestId: "ask_1",
    answers: [["a"]],
  });
  assert.deepEqual(settled, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, IPC.invoke.askToolResolve);
  assert.equal(calls[0].args[0].requestId, "ask_1");
  assert.deepEqual(calls[0].args[0].answers, [["a"]]);
  assert.deepEqual((await bridge.pendingInteractiveRequests("s1")).asks, []);
});

test("resolveAskByRequestId returns null for unknown requests", async (t) => {
  const server = await createServer({
    root: dirname(here),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { createAgentHostBridge } = await server.ssrLoadModule("/electron/main/agent-host-bridge.ts");
  let invoked = 0;
  const bridge = createAgentHostBridge({
    channels: IPC.invoke,
    getHost: () => null,
    log: () => undefined,
    async invoke() {
      invoked += 1;
      return { ok: true };
    },
  });

  assert.equal(
    await bridge.resolveAskByRequestId({ sessionId: "s1", requestId: "missing", answers: [null] }),
    null,
  );
  assert.equal(
    await bridge.resolveAskByRequestId({ sessionId: "", requestId: "ask_1", answers: [null] }),
    null,
  );
  assert.equal(invoked, 0);
});
