/** Add a Host-owned plugin provider from its custom category in Add Service. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixtureSource = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { ProviderSetupDialog } from "../../apps/desktop/src/components/settings/ProviderSetupDialog";
import { isPluginCatalogSetupForProvider } from "../../apps/desktop/src/components/settings/provider-setup-mode";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const calls = [];
window.addEventListener("error", (event) => {
  console.error("PLUGIN_PROVIDER_CATALOG_WINDOW_ERROR", event.error?.stack ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("PLUGIN_PROVIDER_CATALOG_REJECTION", event.reason?.stack ?? event.reason);
});
const providerId = "plugin:community.ai-sites:demo";
const remainingProviderId = "plugin:community.ai-sites:second";
let saved = false;
let providers = [{
  id: providerId,
  name: "Community Demo",
  vendorKey: "custom",
  type: "openai_compatible",
  protocol: "openai_compatible",
  enabled: true,
  baseUrl: "https://api.example.org/v1",
  authKind: "api_key",
  hasSecret: false,
  models: [],
  supportsReasoning: false,
  supportedThinkingLevels: [],
  ownerPluginId: "community.ai-sites",
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
}];
providers.push({
  ...providers[0],
  id: remainingProviderId,
  name: "Community Second",
  baseUrl: "https://second.example.org/v1",
  models: [],
});

window.piDesktop = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, ...args) {
    const input = args[0];
    calls.push({ channel, input });
    if (channel === "pi-desktop/plugin/providerCatalog") {
      return { ok: true, data: [{
        pluginId: "community.ai-sites",
        providerId,
        pluginName: "PI Community AI Sites",
        category: "公益 AI 站",
        description: "通过签到获取额度的公益 API 服务。",
      }, {
        pluginId: "community.ai-sites",
        providerId: remainingProviderId,
        pluginName: "PI Community AI Sites",
        category: "公益 AI 站",
        description: "面向社区用户开放的模型 API 服务。",
      }] };
    }
    if (channel === "pi-desktop/providers/setSecret") {
      if (input.id !== providerId) throw new Error("wrong provider row");
      providers = providers.map((provider) => provider.id === providerId
        ? { ...provider, hasSecret: true }
        : provider);
      useAppStore.setState({ providers });
      return { ok: true, data: { provider: providers[0] } };
    }
    if (channel === "pi-desktop/providers/listModels") {
      if (input.providerId !== providerId || input.source !== "refresh") {
        throw new Error("model discovery must follow saving the selected key");
      }
      return { ok: true, data: { models: [{
        modelId: "demo-chat",
        displayName: "Demo Chat",
        providerId,
        capabilities: ["text"],
        contextWindow: 128000,
        maxTokens: 8192,
        source: "discovered",
      }], source: "remote" } };
    }
    throw new Error("Unexpected fixture IPC: " + channel);
  },
};

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
useAppStore.setState({ providers });

const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await settle();
    const value = predicate();
    if (value) return value;
  }
  throw new Error(message);
}
function setValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const rootNode = createRoot(document.getElementById("root"));
function mount(element) { flushSync(() => rootNode.render(element)); }

function PluginCatalogSurface() {
  const [selected, setSelected] = React.useState(null);
  const provider = selected ? providers.find((row) => row.id === selected.providerId) ?? null : null;
  return React.createElement(ProviderSetupDialog, {
    key: selected?.providerId ?? "add",
    provider,
    pluginCatalogSetup: isPluginCatalogSetupForProvider(selected, provider),
    pluginCatalogPluginName: selected?.pluginName,
    onClose: () => mount(null),
    onSaved: () => { saved = true; mount(null); },
    onPickPluginProvider: (providerId, pluginName) => setSelected({ providerId, pluginName }),
  });
}

function BuiltInServiceSurface() {
  return React.createElement(ProviderSetupDialog, {
    provider: null,
    pluginCatalogSetup: isPluginCatalogSetupForProvider(null, null),
    onClose: () => mount(null),
    onSaved: () => {},
  });
}

window.pluginProviderCatalogProbe = async () => {
  // The empty add state has no selected provider. Choosing a built-in service
  // must reach the ordinary key form instead of the plugin-only empty state.
  mount(React.createElement(BuiltInServiceSurface));
  const builtInTile = await waitFor(
    () => document.querySelector('[data-service-id="openai"]'),
    "the built-in service tile was not shown",
  );
  flushSync(() => builtInTile.click());
  const builtInKeyField = await waitFor(
    () => document.querySelector('input[type="password"]'),
    "selecting a built-in provider did not open its API key form",
  );
  const builtInServiceOpensKeyForm = !!builtInKeyField &&
    !document.documentElement.innerText.includes("The selected provider is no longer available.");

  mount(React.createElement(PluginCatalogSurface));
  const category = await waitFor(
    () => document.querySelector('[data-plugin-provider-category="公益 AI 站"]'),
    "the plugin's declared category was not shown",
  );
  const tile = document.querySelector('[data-plugin-provider-id="' + providerId + '"]');
  if (!tile) throw new Error("the declared API-key provider tile was not shown");
  const publisherShown = tile.textContent.includes("PI Community AI Sites");
  const tileEndpointShown = tile.textContent.includes("api.example.org/v1");
  const access = tile.getAttribute("aria-label");
  tile.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
  const tooltip = await waitFor(
    () => document.querySelector('[role="tooltip"]'),
    "hovering a station did not show its introduction",
  );
  const introductionShown = tooltip.textContent === "通过签到获取额度的公益 API 服务。";
  flushSync(() => tile.click());

  const input = await waitFor(
    () => document.querySelector('input[type="password"]'),
    "selecting a plugin provider did not open its key form",
  );
  const endpointShown = document.documentElement.innerText.includes("api.example.org/v1");
  setValue(input, "community-key-fixture");
  await settle();
  const saveButton = [...document.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "Save provider");
  if (!saveButton) throw new Error("the key form save action was missing");
  flushSync(() => saveButton.click());
  await waitFor(() => saved, "the provider key was not saved through the Host API");

  const secretCall = calls.find((call) => call.channel === "pi-desktop/providers/setSecret");
  const modelCall = calls.find((call) => call.channel === "pi-desktop/providers/listModels");
  mount(React.createElement(PluginCatalogSurface));
  const remainingTile = await waitFor(
    () => document.querySelector('[data-plugin-provider-id="' + remainingProviderId + '"]'),
    "saving one key hid another unconfigured provider",
  );
  return {
    builtInServiceOpensKeyForm,
    categoryShown: !!category,
    publisherShown,
    tileEndpointShown,
    introductionShown,
    tileAccessibleName: access,
    endpointShown,
    saved,
    modelsDiscoveredAfterSavingKey: !!modelCall && secretCall && calls.indexOf(secretCall) < calls.indexOf(modelCall),
    secretStayedOnHostPath: secretCall?.input.id === providerId
      && secretCall?.input.secretValue === "community-key-fixture",
    configuredTileHidden: !document.querySelector('[data-plugin-provider-id="' + providerId + '"]'),
    remainingTileShown: !!remainingTile,
    dialogClosed: !document.querySelector('input[type="password"]'),
  };
};
`;

test("Add Service shows a plugin category and saves the chosen provider key through Host IPC", {
  timeout: 60_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.plugin-provider-catalog-ui-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "plugin-provider-catalog.jsx"),
        loader: "tsx",
      },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><body><div id="root"></div><script type="module" src="renderer.js"></script>',
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.pluginProviderCatalogProbe()");
    console.log("PLUGIN_PROVIDER_CATALOG_PROBE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});
`,
    );

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("PLUGIN_PROVIDER_CATALOG_PROBE "));
    assert(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("PLUGIN_PROVIDER_CATALOG_PROBE ".length)), {
      builtInServiceOpensKeyForm: true,
      categoryShown: true,
      publisherShown: false,
      tileEndpointShown: false,
      introductionShown: true,
      tileAccessibleName: "Community Demo",
      endpointShown: true,
      saved: true,
      modelsDiscoveredAfterSavingKey: true,
      secretStayedOnHostPath: true,
      configuredTileHidden: true,
      remainingTileShown: true,
      dialogClosed: true,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
