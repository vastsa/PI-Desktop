import assert from "node:assert/strict";
import test from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { IPC } from "@pi-desktop/shared";

const here = dirname(fileURLToPath(import.meta.url));

test("AgentHost work controls require explicit structured acknowledgements", async (t) => {
  const server = await createServer({
    root: dirname(here),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { createAgentHostBridge } = await server.ssrLoadModule("/electron/main/agent-host-bridge.ts");
  let response;
  const bridge = createAgentHostBridge({
    channels: IPC.invoke,
    getHost: () => null,
    log: () => undefined,
    async invoke() { return response; },
  });

  const steer = { sessionId: "session-a", expectedTurnId: "turn-1", content: "Add a check", userMessageId: "message-1", voiceOrigin: { callId: "call-1", operationId: "op-1" } };
  response = undefined;
  assert.equal(await bridge.steerWorkSession(steer), false);
  response = {};
  assert.equal(await bridge.steerWorkSession(steer), false);
  response = { accepted: false };
  assert.equal(await bridge.steerWorkSession(steer), false);
  response = { accepted: true };
  assert.equal(await bridge.steerWorkSession(steer), true);

  response = undefined;
  assert.deepEqual(await bridge.stopWorkSession({ sessionId: "session-a", expectedTurnId: "turn-1", urgency: "graceful" }), { status: "stale-target" });
  response = {};
  assert.deepEqual(await bridge.stopWorkSession({ sessionId: "session-a", expectedTurnId: "turn-1", urgency: "graceful" }), { status: "stale-target" });
  response = { requested: true };
  assert.deepEqual(await bridge.stopWorkSession({ sessionId: "session-a", expectedTurnId: "turn-1", urgency: "graceful" }), { status: "requested" });

  response = {};
  assert.deepEqual(await bridge.stopWorkSession({ sessionId: "session-a", expectedTurnId: "turn-1", urgency: "immediate" }), { status: "stale-target" });
  response = { aborted: true };
  assert.deepEqual(await bridge.stopWorkSession({ sessionId: "session-a", expectedTurnId: "turn-1", urgency: "immediate" }), { status: "requested" });
});
