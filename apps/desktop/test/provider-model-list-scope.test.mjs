/**
 * What the settings picker's catalog fallback lists.
 *
 * The picker renders what the credential can call, so when a service publishes
 * no model list of its own the catalog stands in for it: the vendor's published
 * set as a whole, chat models next to the embedding, speech and image endpoints
 * the same key can reach. Preselection stays chat-only (`recommendModels`), and
 * the session and agent paths keep asking for text models only, so the wider
 * list is a settings surface rather than a new default everywhere.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { ModelsDevCatalog } = await import("../electron/main/models-dev-catalog.ts");
const { registerProviderIpc } = await import("../electron/main/ipc/provider-ipc.ts");
const { bindingForCustomModel, IPC } = await import("@pi-desktop/shared");

const catalogPath = fileURLToPath(new URL("../resources/models.dev/api.json", import.meta.url));

async function loadedCatalog() {
  const catalog = new ModelsDevCatalog({ catalogPath });
  assert.equal(await catalog.ensureLoaded(), true);
  return catalog;
}

/** A model whose published modalities are text in and text out. */
const isTextModel = (model) =>
  model.modalities.input.includes("text") && model.modalities.output.includes("text");

test("the settings list can ask for every model a provider publishes", async () => {
  const catalog = await loadedCatalog();
  const input = { vendorKey: "openai", providerId: "row" };
  const textOnly = catalog.modelsForProvider(input);

  assert.ok(textOnly.length > 0, "the bundled snapshot publishes openai text models");
  assert.ok(textOnly.every(isTextModel), "the default list stays what a session can run");

  const all = catalog.modelsForProvider({ ...input, includeNonChat: true });
  // Nothing is dropped when the list widens: it is the same set plus the
  // endpoints a text-only filter hides.
  for (const model of textOnly) {
    assert.ok(
      all.some((entry) => entry.modelId === model.modelId),
      `${model.modelId} disappeared from the wider list`,
    );
  }
  assert.ok(all.length > textOnly.length, "some published model is not a text model");
  assert.ok(
    all.some((model) => !isTextModel(model)),
    "the extra rows are the non-text endpoints the picker has to show",
  );
});

test("the wider list keeps one record per id and stays attributed to the provider", async () => {
  const catalog = await loadedCatalog();
  const models = catalog.modelsForProvider({
    vendorKey: "openai",
    providerId: "row-wide",
    includeNonChat: true,
  });
  const ids = models.map((model) => model.modelId.toLowerCase());
  assert.equal(new Set(ids).size, ids.length, "an id is listed once");
  assert.ok(models.every((model) => model.providerId === "row-wide"));
});

async function unavailableModelList(t, providers = []) {
  const catalog = await loadedCatalog();
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  const handlers = new Map();
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({ call: async () => ({}) }),
    listRuntimeProviders: async () => providers,
    modelsDevCatalog: catalog,
    logger: { app() {} },
  });
  return handlers.get(IPC.invoke.providersListModels);
}

test("a newly selected named preset keeps its catalog fallback on 404", async (t) => {
  const list = await unavailableModelList(t);
  const result = await list({
    presetId: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiStyle: "anthropic_messages",
  });
  assert.equal(result.source, "catalog");
  assert.ok(result.models.some(({ modelId }) => modelId === "claude-sonnet-4-5"));
  assert.match(result.error, /404/);
});

test("a custom draft never offers catalog models, even at an address the catalog knows", async (t) => {
  const list = await unavailableModelList(t);
  for (const input of [
    { baseUrl: "http://127.0.0.1:1234/v1" },
    { baseUrl: "https://api.anthropic.com", apiStyle: "anthropic_messages" },
    { presetId: "anthropic", baseUrl: "https://api.anthropic.com", apiStyle: "responses" },
  ]) {
    const result = await list(input);
    assert.equal(result.source, "fallback");
    assert.deepEqual(result.models, []);
  }
});

test("a named row switched to an unlisted local endpoint offers only configured models", async (t) => {
  const list = await unavailableModelList(t, [{
    id: "named",
    vendorKey: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiStyle: "anthropic_messages",
    models: [bindingForCustomModel("manual-id")],
  }]);
  for (const presetId of [undefined, "anthropic"]) {
    const result = await list({
      providerId: "named",
      presetId,
      baseUrl: "http://127.0.0.1:1234/v1",
      apiStyle: "anthropic_messages",
    });
    assert.equal(result.source, "fallback");
    assert.deepEqual(result.models.map(({ modelId }) => modelId), ["manual-id"]);
  }
  const saved = await list({ providerId: "named", source: "refresh" });
  assert.equal(saved.source, "catalog");
  assert.ok(saved.models.some(({ modelId }) => modelId === "claude-sonnet-4-5"));
});
