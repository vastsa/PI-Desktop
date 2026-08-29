import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sidecarSource = await readFile(
  new URL("../electron/main/agent-sidecar.ts", import.meta.url),
  "utf8",
);
const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);
const appSource = await readFile(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);
const browserTabSource = await readFile(
  new URL("../src/components/workpanel/BrowserTab.tsx", import.meta.url),
  "utf8",
);
const apiSource = await readFile(
  new URL("../src/lib/api.ts", import.meta.url),
  "utf8",
);
const protocolSource = await readFile(
  new URL("../../../packages/shared/src/protocol.ts", import.meta.url),
  "utf8",
);
const runtimeSource = await readFile(
  new URL("../../../packages/agent-runtime/src/runtime.ts", import.meta.url),
  "utf8",
);

test("sidecar routes main-local tools before the host-core proxy", () => {
  // Local tools short-circuit tools.execute; other methods still proxy.
  assert.match(sidecarSource, /setLocalTool\(name: string, handler: LocalToolHandler\)/);
  assert.match(
    sidecarSource,
    /method === "tools\.execute"\s*\?\s*this\.localTools\.get/,
  );
  // Host availability is only required on the proxy path, after local
  // dispatch — a local tool must work even if host-core is restarting.
  const proxyBranch = sidecarSource.slice(
    sidecarSource.indexOf('msg.method === "host.proxy"'),
  );
  assert.ok(
    proxyBranch.indexOf("this.localTools.get") <
      proxyBranch.indexOf('throw new Error("host unavailable")'),
  );
});

test("main serves BrowserPreview from its originating session workspace", () => {
  assert.match(mainSource, /s\.setLocalTool\("BrowserPreview"/);
  // The local tool receives session identity from the sidecar and resolves the
  // workspace from that durable session, never from the visible shell project.
  const handler = mainSource.slice(
    mainSource.indexOf('s.setLocalTool("BrowserPreview"'),
    mainSource.indexOf("sidecar = s;"),
  );
  assert.match(handler, /async \(\{ args, sessionId \}\)/);
  assert.match(handler, /host\?\.call\("session\.get", \{ id: sessionId \}\)/);
  assert.match(handler, /res\?\.session\?\.projectPath/);
  assert.doesNotMatch(handler, /workspace\.get/);
  assert.ok(
    handler.indexOf("resolveLocalFile(raw, root)") <
      handler.indexOf("sendToRenderer(IPC.event.browserPreview"),
  );
  assert.doesNotMatch(handler, /browserPane\.navigate/);
  assert.match(
    handler,
    /sendToRenderer\(IPC\.event\.browserPreview, \{\s*sessionId,\s*path: raw,\s*\}\)/,
  );
  assert.match(protocolSource, /browserPreview: "pi-desktop\/browser\/event\/preview"/);
});

test("renderer routes browser preview events to the originating session", () => {
  assert.match(
    apiSource,
    /onBrowserPreview:[\s\S]*event: \{ sessionId: string; path: string \}/,
  );
  const previewHandler =
    appSource.match(/api\.onBrowserPreview\([\s\S]*?\n\s*\}\);/)?.[0] ?? "";
  assert.ok(previewHandler, "browser preview renderer handler exists");
  assert.match(
    previewHandler,
    /openWorkPanelTabForSession\((?:event\.)?sessionId,[\s\S]*toolWorkPanelTab\("browser"\)/,
  );
  assert.match(
    previewHandler,
    /resource:\s*(?:event\.)?path/,
  );
  assert.doesNotMatch(
    appSource,
    /api\.onBrowserPreview\(\(\) => \{\s*useAppStore\.getState\(\)\.openWorkPanelTab/,
  );
  assert.match(
    browserTabSource,
    /api\.browserNavigate\(initialUrl, sessionId\)/,
  );
  assert.doesNotMatch(browserTabSource, /workPanel\.browserUrl|LAST_URL_KEY/);
  assert.match(appSource, /offBrowserPreview\(\);/);
});

test("agent runtime exposes BrowserPreview in every mode and prompts for it", () => {
  // The complete registry includes BrowserPreview even though the active
  // provider context may defer its schema until ToolSearch activates it.
  const builderStart = runtimeSource.indexOf("const tools =");
  const builderEnd = runtimeSource.indexOf(
    "const builtins = tools.map(exec)",
    builderStart,
  );
  assert.ok(builderStart >= 0 && builderEnd > builderStart);
  assert.match(runtimeSource.slice(builderStart, builderEnd), /"BrowserPreview"/);
  // `path` carries an alias alongside it (D273), so assert the entry and its
  // canonical argument rather than one exact line of source.
  assert.match(
    runtimeSource,
    /BrowserPreview: \{\s*path: pathParam\([^)]*\),\s*file_path: aliasParam\("path"\),\s*\}/,
  );
  // Default system prompt limits preview calls to user-visible HTML work and
  // reuses the live-reloading surface while the page is being refined.
  assert.match(runtimeSource, /user-visible HTML pages/);
  assert.match(runtimeSource, /first meaningful visual edit/);
  assert.match(runtimeSource, /Reuse that preview while iterating/);
  assert.match(
    runtimeSource,
    /Skip generated, test-only, and non-visual HTML files/,
  );
  assert.match(runtimeSource, /live-reloads/);
});
