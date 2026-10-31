import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("visualization frames get no permission from the default-session handlers", async (t) => {
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
  const { installLiveMicrophonePermissionHandlers, isGenUiPermissionRequester } = await server.ssrLoadModule(
    "/electron/main/live-voice/microphone-permissions.ts",
  );

  const trustedUrl = "http://localhost:5173/";
  const contents = {
    id: 4,
    isDestroyed: () => false,
    getURL: () => trustedUrl,
    mainFrame: { url: trustedUrl, processId: 5, routingId: 6 },
  };
  const window = { isDestroyed: () => false, webContents: contents };
  const handlers = {};
  installLiveMicrophonePermissionHandlers({
    targetSession: {
      setPermissionRequestHandler: (handler) => { handlers.request = handler; },
      setPermissionCheckHandler: (handler) => { handlers.check = handler; },
    },
    getMainWindow: () => window,
    hasReservation: () => true,
  });
  const request = (permission, details) => {
    let decision = null;
    handlers.request(contents, permission, (value) => { decision = value; }, details);
    return decision;
  };

  const genUiUrl = "pi-genui://session/sess_1/chart.html";
  for (const permission of ["clipboard-sanitized-write", "notifications", "fullscreen", "media"]) {
    assert.equal(request(permission, { requestingUrl: genUiUrl, isMainFrame: false, mediaTypes: ["audio"] }), false, permission);
    // Sandboxed opaque origin: origin reads "null", the frame URL still names the scheme.
    assert.equal(handlers.check(contents, permission, "null", { requestingUrl: genUiUrl, mediaType: "audio" }), false, permission);
    assert.equal(handlers.check(contents, permission, "pi-genui://session", { mediaType: "audio" }), false, permission);
  }
  assert.equal(isGenUiPermissionRequester("PI-GENUI://session/x/y.html"), true);
  assert.equal(isGenUiPermissionRequester(undefined, "http://localhost:5173/"), false);

  // Existing behavior for the app itself is unchanged.
  assert.equal(request("clipboard-sanitized-write", { requestingUrl: trustedUrl, isMainFrame: true }), true);
  assert.equal(handlers.check(contents, "clipboard-sanitized-write", "http://localhost:5173", {}), true);
  assert.equal(request("media", { requestingUrl: trustedUrl, isMainFrame: true, mediaTypes: ["audio"] }), true);
});
