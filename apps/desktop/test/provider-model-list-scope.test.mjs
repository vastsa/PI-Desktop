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

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { ModelsDevCatalog } = await import("../electron/main/models-dev-catalog.ts");

const catalogPath = new URL("../resources/models.dev/api.json", import.meta.url).pathname;

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
