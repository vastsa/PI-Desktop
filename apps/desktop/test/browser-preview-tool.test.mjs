import { readAppSource, readMainSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sidecarSource = await readFile(
  new URL("../../../packages/host-runtime/src/agent-sidecar.ts", import.meta.url),
  "utf8",
);
const mainSource = await readMainSource();
const appSource = await readAppSource();
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
const pluginRuntimeSource = await readFile(
  new URL("../electron/main/plugin-runtime.ts", import.meta.url),
  "utf8",
);
const browserPluginSource = await readFile(
  new URL("../resources/plugins/pi.browser/main.js", import.meta.url),
  "utf8",
);
const pluginServicesSource = await readFile(
  new URL("../electron/main/services/plugin-services.ts", import.meta.url),
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

test("main serves BrowserPreview from its originating session workspace", async () => {
  assert.match(mainSource, /s\.setLocalTool\("BrowserPreview"/);
  // The local tool receives session identity from the sidecar and resolves the
  // workspace from that durable session, never from the visible shell project.
  const handler = mainSource.slice(
    mainSource.indexOf('s.setLocalTool("BrowserPreview"'),
    mainSource.indexOf("sidecar = s;"),
  );
  assert.match(handler, /async \(\{ args, sessionId \}\)/);
  assert.match(handler, /browserHost\.getFileRoots\(sessionId\)/);
  assert.doesNotMatch(handler, /workspace\.get/);
  assert.match(handler, /browserHost\.previewFile\(\)/);
  const services = await readFile(new URL("../electron/main/services/plugin-services.ts", import.meta.url), "utf8");
  const roots = services.slice(services.indexOf("getFileRoots: async"), services.indexOf("getScratchDir:"));
  assert.match(roots, /"session\.get", \{ id: sessionId \}/);
  assert.match(roots, /res\.session\.worktree/);
  assert.match(roots, /"worktree\.location", \{ sessionId \}/);
  assert.match(roots, /return \[path, join\(dataDir, "scratch", sessionId\)\]/);
  assert.ok(
    handler.indexOf("resolveLocalFile(raw, root)") <
      handler.indexOf("sendToRenderer(IPC.event.browserPreview"),
  );
  assert.doesNotMatch(handler, /browserPane\.navigate/);
  assert.match(
    handler,
    /sendToRenderer\(IPC\.event\.browserPreview, \{\s*sessionId,\s*path: file,\s*\}\)/,
  );
  assert.match(protocolSource, /browserPreview: "pi-desktop\/browser\/event\/preview"/);
});

test("renderer routes browser preview events to the originating session", () => {
  assert.match(
    apiSource,
    /onBrowserPreview:[\s\S]*event: \{[\s\S]*sessionId: string;[\s\S]*tabId\?: string;[\s\S]*revealOnly\?: boolean/,
  );
  const previewHandler =
    appSource.match(/api\.onBrowserPreview\([\s\S]*?\n\s*\}\);/)?.[0] ?? "";
  assert.ok(previewHandler, "browser preview renderer handler exists");
  assert.match(
    previewHandler,
    /openWorkPanelTabForSession\(\s*event\.sessionId,[\s\S]*browserPluginTabForReveal/,
  );
  assert.doesNotMatch(
    appSource,
    /api\.onBrowserPreview\(\(\) => \{\s*useAppStore\.getState\(\)\.openWorkPanelTab/,
  );
  assert.match(appSource, /event\.revealOnly/);
  assert.match(appSource, /offBrowserPreview\(\);/);
});

test("plugin HTML open routes through the active session without Browser CDP", () => {
  assert.match(apiSource, /onBrowserOpenFile:[\s\S]*IPC\.event\.browserOpenFile/);
  const hostOpen = pluginServicesSource.match(/openInBrowser: async \(fullPath\) => \{[\s\S]*?\n    \},/)?.[0] ?? "";
  assert.ok(hostOpen, "host filesystem service dispatches Browser-open events");
  assert.match(hostOpen, /browserHost\.previewFile\(\)/);
  assert.match(hostOpen, /IPC\.event\.browserOpenFile, \{ path: fullPath \}/);
  const rendererHandler =
    appSource.match(/api\.onBrowserOpenFile\([\s\S]*?\n    \}\);/)?.[0] ?? "";
  assert.ok(rendererHandler, "renderer Browser-open event handler exists");
  assert.match(rendererHandler, /state\.activeSessionId/);
  assert.match(rendererHandler, /openWorkPanelTabForSession\([\s\S]*browserPluginTab\(path\)/);
  assert.match(protocolSource, /browserOpenFile: "pi-desktop\/browser\/event\/openFile"/);
  assert.match(pluginRuntimeSource, /openInBrowser: async \(pathFromRoot: string\) =>/);
  assert.match(pluginRuntimeSource, /api: "fs\.openInBrowser"/);
  assert.doesNotMatch(hostOpen, /browser\.cdp|invokeBrowser/);
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
  // BrowserPreview tool description mentions live-reload behaviour.
  assert.match(runtimeSource, /live-reloads/);
});

test("Browser tool automatically reveals its view before browser operations", async () => {
  assert.match(browserPluginSource, /Browser operations automatically reveal the work-panel view/);
  assert.match(browserPluginSource, /Do not ask the user to open Browser manually/);
  assert.match(browserPluginSource, /await pi\.browser\.reveal\(\)/);

  let registeredTool;
  const calls = [];
  const previousPi = globalThis.pi;
  globalThis.pi = {
    agent: {
      registerTool: async (tool) => { registeredTool = tool; },
      unregisterTool: async () => {},
    },
    browser: {
      reveal: async () => { calls.push("reveal"); },
      snapshot: async () => {
        calls.push("snapshot");
        return { tree: "- e1 WebArea", url: "https://fixture.invalid", title: "Fixture" };
      },
    },
  };
  try {
    const plugin = await import("../resources/plugins/pi.browser/main.js");
    await plugin.onLoad();
    const result = await registeredTool.execute({ action: "snapshot" });
    assert.deepEqual(calls, ["reveal", "snapshot"]);
    assert.deepEqual(result, {
      ok: true,
      action: "snapshot",
      tree: "- e1 WebArea",
      url: "https://fixture.invalid",
      title: "Fixture",
    });
    await plugin.onUnload();
  } finally {
    if (previousPi === undefined) delete globalThis.pi;
    else globalThis.pi = previousPi;
  }
});
