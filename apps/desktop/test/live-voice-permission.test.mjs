import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("Live Voice media permission requires the trusted main frame and an active microphone lease", async (t) => {
  const previousRendererUrl = process.env.ELECTRON_RENDERER_URL;
  process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
  t.after(() => {
    if (previousRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL;
    else process.env.ELECTRON_RENDERER_URL = previousRendererUrl;
  });
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { installLiveMicrophonePermissionHandlers } = await server.ssrLoadModule("/electron/main/live-voice/microphone-permissions.ts");

  const trustedUrl = "http://localhost:5173/";
  const contents = {
    id: 4,
    isDestroyed: () => false,
    getURL: () => trustedUrl,
    mainFrame: { url: trustedUrl, processId: 5, routingId: 6 },
  };
  const window = { isDestroyed: () => false, webContents: contents };
  const handlers = {};
  let leaseActive = true;
  installLiveMicrophonePermissionHandlers({
    targetSession: {
      setPermissionRequestHandler: (handler) => { handlers.request = handler; },
      setPermissionCheckHandler: (handler) => { handlers.check = handler; },
    },
    getMainWindow: () => window,
    hasReservation: () => leaseActive,
  });

  const requestDecision = (details, permission = "media", requester = contents) => {
    let decision = false;
    handlers.request(requester, permission, (value) => { decision = value; }, details);
    return decision;
  };
  const checkDecision = (details, origin = "http://localhost:5173", permission = "media", requester = contents) =>
    handlers.check(requester, permission, origin, details);

  assert.equal(requestDecision({ requestingUrl: trustedUrl, isMainFrame: true, mediaTypes: ["audio"] }), true);
  assert.equal(checkDecision({ mediaType: "unknown" }), true);
  assert.equal(checkDecision({ mediaType: "audio" }), true);
  assert.equal(requestDecision({ requestingUrl: trustedUrl, isMainFrame: true, mediaTypes: ["audio", "video"] }), false);
  assert.equal(requestDecision({ requestingUrl: trustedUrl, isMainFrame: false, mediaTypes: ["audio"] }), false);
  assert.equal(requestDecision({ requestingUrl: "https://outside.example", isMainFrame: true, mediaTypes: ["audio"] }), false);
  assert.equal(checkDecision({ mediaType: "audio" }, "https://outside.example"), false);
  assert.equal(requestDecision({ requestingUrl: trustedUrl, isMainFrame: true, mediaTypes: ["audio"] }, "notifications"), false);
  assert.equal(requestDecision({ requestingUrl: trustedUrl, isMainFrame: true, mediaTypes: ["audio"] }, "media", {}), false);
  leaseActive = false;
  assert.equal(requestDecision({ requestingUrl: trustedUrl, isMainFrame: true, mediaTypes: ["audio"] }), false);
  assert.equal(checkDecision({ mediaType: "audio" }), false);
});
