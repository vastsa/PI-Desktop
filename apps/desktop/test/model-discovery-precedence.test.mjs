/**
 * The AI service is the authority on which models it serves.
 *
 * `providersListModels` used to answer from the bundled models.dev snapshot
 * before it ever contacted the endpoint, which offered every model a vendor
 * publishes — including ones a given deployment does not host and ones the key
 * is not entitled to. These tests pin the corrected order: probe the service,
 * enrich what it returned with models.dev, and only fall back to the catalog
 * when the endpoint publishes nothing usable.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);

/** Body of the providersListModels handler, so offsets are local to it. */
const handler = (() => {
  const start = mainSource.indexOf("IPC.invoke.providersListModels");
  assert.notEqual(start, -1, "providersListModels handler not found");
  // The handler ends at its own fallback return; the next `handle(` registration
  // is not guaranteed to be the create one.
  const end = mainSource.indexOf('source: "fallback", error: discoveryError', start);
  assert.notEqual(end, -1, "could not bound the handler body");
  return mainSource.slice(start, end);
})();

test("the live endpoint is probed before the bundled catalog is consulted", () => {
  const discovery = handler.indexOf("await discoverProviderModels(");
  const catalog = handler.indexOf("modelsDevCatalog.modelsForProvider(");
  assert.notEqual(discovery, -1, "live discovery call missing");
  assert.notEqual(catalog, -1, "catalog fallback missing");
  assert.ok(
    discovery < catalog,
    "models.dev must not short-circuit ahead of the service's own /models",
  );
});

test("a catalog-derived list is reported as such, not as the service's answer", () => {
  // The renderer has to be able to tell the user the service published no list.
  assert.match(handler, /source: "catalog" as const/);
  const catalogReturn = handler.slice(handler.indexOf('source: "catalog" as const'));
  assert.match(catalogReturn.slice(0, 200), /discoveryError \? \{ error: discoveryError \}/);
  // The live branch keeps its own distinct source value.
  assert.match(handler, /await cacheForCurrentProvider\(models\);\s*\n\s*return \{ models, source: "remote" as const \}/);
});

test("only a live answer is written back to the model cache", () => {
  // Caching a catalog guess would make it indistinguishable from a real probe
  // on the next cold start.
  const cacheCall = handler.indexOf("await cacheForCurrentProvider(");
  const catalog = handler.indexOf("modelsDevCatalog.modelsForProvider(");
  assert.ok(cacheCall < catalog, "the cache write must belong to the live branch");
  assert.match(handler, /if \(!provider \|\| req\.source === "cache"\) return;/);
});

test("every returned model is enriched through models.dev regardless of origin", () => {
  // `decorate` is what attaches published limits, modalities and thinking
  // levels, so all three branches must route through it.
  assert.match(handler, /const modelsDevModel = modelsDevCatalog\.findModel\(/);
  assert.match(handler, /discovered\.map\(\(model\) => decorate\(model\)\)/);
  assert.match(handler, /catalogModels\.map\(\(model\) => decorate\(model\)\)/);
});

test("the stored secret is resolved before probing, so edits need no retyped key", () => {
  const secret = handler.indexOf('"providers.getSecret"');
  const discovery = handler.indexOf("await discoverProviderModels(");
  assert.notEqual(secret, -1, "stored secret lookup missing");
  assert.ok(secret < discovery, "the key must be resolved before the probe");
});
