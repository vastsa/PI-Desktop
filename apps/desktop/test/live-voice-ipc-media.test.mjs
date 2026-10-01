import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("Live prepare IPC keeps the Composer target and context consent as separate inputs", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { parsePrepare, parseWorkOperationControl } = await server.ssrLoadModule("/electron/main/ipc/live-voice-ipc.ts");
  const request = {
    requestId: "00000000-0000-4000-8000-000000000001",
    bindingId: "binding-a",
    expectedSettingsRevision: 1,
    initialMuted: true,
    workTarget: { workSessionId: "session-a" },
    shareSelectedSessionContext: true,
  };
  assert.deepEqual(parsePrepare(request), request);
  assert.throws(() => parsePrepare({
    ...request,
    workTarget: { workSessionId: "session-a", contextEnabled: true },
  }), { errorCode: "LIVE_PROTOCOL_ERROR" });
  assert.throws(() => parsePrepare({ ...request, shareSelectedSessionContext: "true" }), { errorCode: "LIVE_PROTOCOL_ERROR" });
  assert.deepEqual(parseWorkOperationControl({ callId: "call-a", operationId: "operation-a" }), { callId: "call-a", operationId: "operation-a" });
  assert.throws(() => parseWorkOperationControl({ callId: "call-a", operationId: "operation-a", workSessionId: "session-b" }), { errorCode: "LIVE_PROTOCOL_ERROR" });
  assert.throws(() => parseWorkOperationControl({ callId: "call-a", operationId: "operation-a", turnId: "turn-b" }), { errorCode: "LIVE_PROTOCOL_ERROR" });
});

test("Live playback activity IPC accepts only the bounded monitor state", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { parseMedia } = await server.ssrLoadModule("/electron/main/ipc/live-voice-ipc.ts");

  assert.deepEqual(parseMedia({
    callId: "call-a",
    kind: "playback-activity",
    active: true,
    ready: true,
  }), {
    callId: "call-a",
    kind: "playback-activity",
    active: true,
    ready: true,
  });
  assert.throws(() => parseMedia({
    callId: "call-a",
    kind: "playback-activity",
    active: false,
    ready: true,
    sessionId: "untrusted",
  }), { errorCode: "LIVE_PROTOCOL_ERROR" });
  assert.throws(() => parseMedia({
    callId: "call-a",
    kind: "playback-activity",
    active: "false",
    ready: true,
  }), { errorCode: "LIVE_PROTOCOL_ERROR" });
});
