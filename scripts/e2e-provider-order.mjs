#!/usr/bin/env node
/** Provider drag/drop through the settings UI, production IPC and an isolated Rust host. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const binary = resolveHostBinary();
const temp = await mkdtemp(join(tmpdir(), "pi-provider-order-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/provider-order.tsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await build({
    entryPoints: [join(root, "apps/desktop/electron/main/ipc/provider-ipc.ts")],
    outfile: join(temp, "provider-ipc.cjs"), bundle: true, platform: "node", format: "cjs",
    external: ["electron"],
  });
  await writeFile(join(temp, "tokens.css"), (await readFile(join(root, "apps/desktop/src/styles/tokens.css"), "utf8")).replace(/@theme(?: inline)?/g, ":root"));
  await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'"><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="renderer.css"><body><script src="renderer.js"></script>`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { registerProviderIpc } = require("./provider-ipc.cjs");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const { Host } = await import(${JSON.stringify(pathToFileURL(join(root, "scripts/e2e/host.mjs")).href)});
  const { IPC } = await import(${JSON.stringify(pathToFileURL(join(root, "packages/shared/dist/protocol.js")).href)});
  const host = new Host(${JSON.stringify(binary)}, path.join(__dirname, "data"));
  let window;
  let failure;
  try {
    await host.start();
    const fixtures = [];
    for (const name of ["A", "B", "C"]) {
      const { provider } = await host.call("providers.create", {
        name, authKind: "none", baseUrl: "http://127.0.0.1:9/v1",
        apiStyle: "chat_completions", defaultModelId: "model-" + name,
        models: name === "A" ? ["deepseek-chat", "deepseek-reasoner"].map(id => ({
          id, contextWindow: 128000, maxTokens: 8192,
          thinkingLevels: ["off"], defaultThinkingLevel: "off",
        })) : undefined,
      });
      fixtures.push(provider);
    }
    await host.call("settings.set", { defaultProviderId: fixtures[0].id, defaultModelId: fixtures[0].defaultModelId });
    for (const input of [
      { id: fixtures[0].id, targetId: fixtures[1].id, placement: "invalid" },
      { id: "missing", targetId: fixtures[1].id, placement: "before" },
      { id: fixtures[0].id, targetId: "missing", placement: "after" },
    ]) {
      let code;
      try { await host.call("providers.reorder", input); }
      catch (error) { code = error.errorCode; }
      if (code !== "INVALID_PARAMS") throw new Error("invalid reorder must be rejected without writing");
    }

    const registrar = { handle(channel, handler) {
      ipcMain.handle(channel, async (_event, input) => {
        try { return { ok: true, data: await handler(input) }; }
        catch (error) { return { ok: false, error: { code: error.errorCode || "INTERNAL", message: error.message } }; }
      });
    } };
    const enrich = (provider) => ({ ...provider, supportsReasoning: false, supportedThinkingLevels: ["off"] });
    registerProviderIpc({
      registrar, getHost: () => host,
      modelsDevCatalog: {
        ensureLoaded: async () => {}, loadLocal: async () => {}, findModel: () => undefined,
        modelsForProvider: () => [], getStatus: () => ({ loaded: true, source: "empty", modelCount: 0, providerCount: 0 }),
      },
      vendorOAuth: { listVendors: async () => [] }, logger: { app() {} },
      enrichProvider: enrich,
      enrichProviderList: async (result) => ({ providers: result.providers.map(enrich) }),
      listRuntimeProviders: async () => (await host.call("providers.list")).providers,
      bindingForModel: (provider, modelId) => provider.models?.find((model) => model.id === modelId),
    });
    registrar.handle(IPC.invoke.settingsGet, () => host.call("settings.get"));
    registrar.handle(IPC.invoke.settingsSet, (settings) => host.call("settings.set", settings));
    registrar.handle(IPC.invoke.sessionList, () => host.call("session.list"));
    registrar.handle(IPC.invoke.appGetOnboarding, async () => ({ dismissed: true }));
    window = new BrowserWindow({ show: false, width: 1000, height: 1000, webPreferences: {
      preload: ${JSON.stringify(join(root, "apps/desktop/out/preload/index.cjs"))},
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    window.webContents.on("console-message", (event) => console.error(event.message));
    await window.loadFile(path.join(__dirname, "index.html"));
    const interactions = await window.webContents.executeJavaScript("globalThis.providerOrderProbe()");
    const performance = await window.webContents.executeJavaScript("globalThis.cardReorderPerformance()");
    await host.restart();
    await window.loadFile(path.join(__dirname, "index.html"));
    const restart = await window.webContents.executeJavaScript("globalThis.providerOrderProbe(true)");
    console.log("PROVIDER_ORDER_PROBE " + JSON.stringify({ ...interactions, restart: restart.ok, performance }));
  } catch (error) {
    failure = error;
    console.error("PROVIDER_ORDER_PROBE " + JSON.stringify({ ok: false, error: String(error) }));
  } finally {
    window?.destroy();
    await host.stop();
    app.exit(failure ? 1 : 0);
  }
});
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  } finally { clearTimeout(timer); }
  const line = output.split(/\r?\n/).find((line) => line.startsWith("PROVIDER_ORDER_PROBE "));
  assert(line, `no result (exit=${code}): ${output.slice(-4000)}`);
  console.log(line);
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(JSON.parse(line.slice("PROVIDER_ORDER_PROBE ".length)).ok, true);
} finally { await rm(temp, { recursive: true, force: true }); }
