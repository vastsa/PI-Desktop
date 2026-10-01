import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("Codex Live validates and bounds SDP negotiation payloads", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { extractCodexSdpAnswer, normalizeCodexSdp, readResponseTextBounded } = await server.ssrLoadModule("/electron/main/live-voice/codex-sdp.ts");
  const { responseCodeError } = await server.ssrLoadModule("/electron/main/live-voice/websocket-errors.ts");

  assert.equal(normalizeCodexSdp("v=0\r\n"), "v=0\r\n");
  assert.equal(extractCodexSdpAnswer('{"sdp":"v=0\\r\\n"}'), "v=0\r\n");
  assert.throws(() => normalizeCodexSdp("v=1\r\n"), { errorCode: "LIVE_PROTOCOL_ERROR" });
  assert.throws(() => normalizeCodexSdp("v=0\0\r\n"), { errorCode: "LIVE_PROTOCOL_ERROR" });
  assert.throws(() => extractCodexSdpAnswer('{"sdp":"v=0\\r\\n","debug":"no"}'), { errorCode: "LIVE_PROTOCOL_ERROR" });

  const bounded = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("v=0\r\n"));
      controller.enqueue(new TextEncoder().encode("x".repeat(8)));
      controller.close();
    },
  }));
  await assert.rejects(readResponseTextBounded(bounded, 8), { errorCode: "LIVE_PROTOCOL_ERROR" });
  assert.deepEqual(responseCodeError(401), { code: "LIVE_AUTH_REQUIRED", retriable: false });
  assert.deepEqual(responseCodeError(403), { code: "LIVE_ACCESS_DENIED", retriable: false });
  assert.deepEqual(responseCodeError(429), { code: "LIVE_RATE_LIMITED", retriable: true });
  assert.deepEqual(responseCodeError(503), { code: "LIVE_NETWORK_ERROR", retriable: true });
});

test("Codex Live does not POST when cancellation happens during endpoint validation", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { createCodexAdapter } = await server.ssrLoadModule("/electron/main/live-voice/codex-adapter.ts");
  let releaseEndpoint;
  let endpointStarted;
  const endpointGate = new Promise((resolve) => { releaseEndpoint = resolve; });
  const started = new Promise((resolve) => { endpointStarted = resolve; });
  const abort = new AbortController();
  let fetchCalls = 0;
  const adapter = createCodexAdapter({
    callId: "call-cancelled-during-endpoint-check",
    binding: { id: "codex", adapterId: "codex-live", providerId: "provider", voice: "cove" },
    provider: {},
    auth: { kind: "codex-oauth", accessToken: "fixture-token", accountId: "fixture-account" },
    signal: abort.signal,
    onEvent() {},
  }, {
    async assertEndpoint(url) {
      assert.match(url, /^https:\/\/chatgpt\.com\/backend-api\/codex\/realtime\/calls\?/);
      endpointStarted();
      await endpointGate;
    },
    async fetchImpl() {
      fetchCalls += 1;
      return new Response("v=0\r\n", { status: 201 });
    },
  });

  const connecting = adapter.connect({ offerSdp: "v=0\r\n" });
  await started;
  const rejected = assert.rejects(connecting, { errorCode: "LIVE_STALE_CALL" });
  abort.abort(new Error("call cancelled"));
  await adapter.close("user-cancelled-start");
  releaseEndpoint();
  await rejected;

  assert.equal(fetchCalls, 0, "endpoint validation completing late cannot start a provider POST");
});
