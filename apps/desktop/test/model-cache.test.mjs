import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);
const storeSource = await readFile(
  new URL("../src/stores/app-store.ts", import.meta.url),
  "utf8",
);
const catalogBrowserSource = await readFile(
  new URL("../src/components/settings/ModelCatalogBrowser.tsx", import.meta.url),
  "utf8",
);

test("saved provider discovery persists models in the host catalog", () => {
  assert.match(mainSource, /req\.source === "cache"/);
  assert.match(mainSource, /"providers\.listModels"/);
  assert.match(mainSource, /"providers\.cacheModels"/);
  assert.match(mainSource, /catalogPath: app\.isPackaged/);
  assert.match(mainSource, /resources", "models\.dev", "api\.json"/);
  assert.match(mainSource, /modelsDevCatalog\.loadLocal\(\)/);
  assert.match(mainSource, /modelsDevCatalog\.refresh\(\)/);
  assert.match(mainSource, /const modelsDevModel = modelsDevCatalog\.findModel/);
  assert.match(mainSource, /modelConfigFromModelsDev/);
  assert.match(mainSource, /genericModelConfig/);
  assert.match(mainSource, /providersRefreshModelCatalog/);
  assert.doesNotMatch(mainSource, /modelsDevCatalog\.persist/);
  assert.match(mainSource, /usesSavedEndpoint/);
  assert.match(mainSource, /endpointStillCurrent/);
  assert.match(mainSource, /for \(const binding of provider\.models \?\? \[\]\)/);
  assert.match(mainSource, /models\.dev or generic[\s\S]*per-model state/);
});

test("renderer hydrates cached models before refreshing the provider", () => {
  assert.match(storeSource, /source: "cache"/);
  assert.match(storeSource, /source: "refresh"/);
  assert.match(storeSource, /cachedProviderModels/);
  assert.match(storeSource, /refreshedProviderModels/);
  assert.match(storeSource, /providerModelsGeneration/);
  assert.match(storeSource, /Keep the cached catalog/);
});

test("the catalog browser keeps the last result set while revalidating", () => {
  // Results are only replaced when the newest request commits, so typing does
  // not blank the list between keystrokes.
  assert.match(catalogBrowserSource, /if \(requestSeq\.current !== requestId\) return;/);
  assert.match(catalogBrowserSource, /loading && results\.length === 0/);
  assert.match(catalogBrowserSource, /setDegraded\(true\)/);
});
