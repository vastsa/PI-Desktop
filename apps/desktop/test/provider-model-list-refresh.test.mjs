import assert from "node:assert/strict";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer } from "vite";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerProviderIpc } = await import("../electron/main/ipc/provider-ipc.ts");
const { ModelsDevCatalog } = await import("../electron/main/models-dev-catalog.ts");
const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");
const { bindingForCustomModel, formatTokenCount, IPC } = await import("@pi-desktop/shared");

// Run the real IPC discovery and settings picker; mock only HTTP and host persistence.
test("refresh removes revoked service rows and preserves configured chat bindings", async (t) => {
  const row = {
    id: "relay", name: "Relay", vendorKey: "custom", enabled: true,
    authKind: "none", hasSecret: false, apiStyle: "chat_completions",
    baseUrl: "https://relay.example/v1",
    models: ["gpt-6-sol", "claude-sonnet-4-5"].map(bindingForCustomModel),
  };
  row.models[1] = { ...row.models[1], alias: "Saved alias", contextWindow: 190_000, contextWindowSource: "user" };
  row.models.push({
    ...bindingForCustomModel("gpt-6-astra"),
    contextWindow: 1_000_000,
    contextWindowSource: "user",
  });
  let served = ["claude-sonnet-4-5", "gpt-6-sol", "gpt-6-astra"];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: served.map((id) => ({ id })),
  }), { headers: { "content-type": "application/json" } });
  t.after(() => { globalThis.fetch = originalFetch; });
  const catalog = new ModelsDevCatalog({
    catalogPath: fileURLToPath(new URL("../resources/models.dev/api.json", import.meta.url)),
  });
  assert.equal(await catalog.ensureLoaded(), true);
  const runtime = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: catalog });
  const handlers = new Map();
  let cachedModels = [];
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({ call: async (method, input) => {
      if (method === "providers.list") return { providers: [row] };
      if (method === "providers.get") return { provider: row };
      if (method === "providers.cacheModels") {
        cachedModels = input?.models ?? [];
        return {};
      }
      return {};
    } }),
    modelsDevCatalog: catalog, vendorOAuth: {}, logger: { app() {} },
    enrichProvider: runtime.enrichProvider,
    listRuntimeProviders: async () => [runtime.enrichProvider(row)],
    enrichProviderList: runtime.enrichProviderList,
    bindingForModel: () => undefined,
  });
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    logLevel: "silent", server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { ModelSelectionPanes, useModelSelection } = await server.ssrLoadModule(
    "/src/components/settings/ModelSelectionPanes.tsx",
  );
  const { composerModelsForProvider } = await server.ssrLoadModule("/src/lib/composer-models.ts");
  const { resolveContextWindow } = await server.ssrLoadModule("/src/lib/context-usage.ts");
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } });
  let discovery;
  let persisted;
  let selectionSnapshot;
  function Picker() {
    const selection = useModelSelection(discovery, row.models, () => {});
    persisted = selection.bindingsToPersist;
    selectionSnapshot = selection;
    return createElement(ModelSelectionPanes, { discovery, selection, listTitle: "Service models" });
  }
  const render = () => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(Picker)));
  const ids = (html, className) => [...html.matchAll(new RegExp(`<span class="${className}[^"]*">([^<]*)</span>`, "g"))].map((match) => match[1]);
  const limitsFor = (html, idClass, limitClass, modelId) => {
    const row = [...html.matchAll(/<li\b[\s\S]*?<\/li>/g)]
      .map((match) => match[0])
      .find((item) =>
        item.includes(`class="${idClass}`) && item.includes(`>${modelId}</span>`),
      );
    return row?.match(new RegExp(`class="${limitClass}">([^<]*)`))?.[1];
  };
  const refresh = async () => {
    const result = await handlers.get(IPC.invoke.providersListModels)({ providerId: row.id, source: "refresh" });
    discovery = { status: "ready", ...result };
    return render();
  };
  const initialHtml = await refresh();
  assert.deepEqual(ids(initialHtml, "provider-models-row-id").sort(), [...served].sort());
  assert.ok(initialHtml.includes(`${formatTokenCount(1_050_000)} · ${formatTokenCount(128_000)}`),
    "the discovery pane presents the models.dev baseline");
  assert.ok(initialHtml.includes(`${formatTokenCount(1_000_000)} · ${formatTokenCount(row.models[2].maxTokens)}`),
    "the chosen-model pane presents the pinned user value");
  const catalogAstra = discovery.models.find((model) => model.modelId === "gpt-6-astra");
  assert.equal(catalogAstra.contextWindow, 1_050_000, "discovery exposes the models.dev value");
  const cachedAstra = cachedModels.find((model) => model.modelId === "gpt-6-astra");
  assert.ok(cachedAstra, "the endpoint metadata cache includes the served model");
  assert.equal(cachedAstra.contextWindow, 1_050_000, "the endpoint metadata cache stores the raw catalog value");
  const enrichedAstra = runtime.enrichProvider(row).models.find((model) => model.id === "gpt-6-astra");
  assert.equal(enrichedAstra.contextWindow, 1_000_000, "runtime keeps the explicit user binding");
  assert.equal(enrichedAstra.contextWindowSource, "user");
  assert.equal(selectionSnapshot.rows.find((model) => model.id === "gpt-6-astra").binding.contextWindow, 1_000_000,
    "the selected settings row keeps the user's effective value");
  assert.equal(resolveContextWindow(
    row.id,
    "gpt-6-astra",
    { [row.id]: discovery.models },
    [runtime.enrichProvider(row)],
  ), 1_000_000, "context usage follows the selected account binding");
  served = ["gpt-6-sol", "new-model"];
  row.models.push(bindingForCustomModel("new-model"));
  const html = await refresh();
  assert.deepEqual(ids(html, "provider-models-row-id"), served);
  assert.deepEqual(persisted, row.models);
  assert.deepEqual(ids(html, "provider-chosen-row-id"), [
    "gpt-6-sol", "claude-sonnet-4-5", "gpt-6-astra", "new-model",
  ]);
  assert.deepEqual(
    composerModelsForProvider(row, discovery.models).map((model) => model.modelId),
    ["gpt-6-sol", "claude-sonnet-4-5", "gpt-6-astra", "new-model"],
  );
  assert.equal(
    limitsFor(html, "provider-models-row-id", "provider-models-row-limits", "new-model"),
    "— · —",
    "an undiscovered model does not present generic runtime defaults as catalog limits",
  );
  assert.equal(
    limitsFor(html, "provider-chosen-row-id", "provider-chosen-row-limits", "new-model"),
    "— · —",
    "an unknown configured model is labeled unknown until its limits are published or overridden",
  );
  // Offline/manual fallbacks must still expose configured entries for editing.
  discovery = { ...discovery, source: "fallback", models: [] };
  assert.deepEqual(ids(render(), "provider-models-row-id"), [
    "gpt-6-sol", "claude-sonnet-4-5", "gpt-6-astra", "new-model",
  ]);
});
