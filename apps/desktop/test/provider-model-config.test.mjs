/**
 * Contract tests for discovery-first model configuration.
 *
 * The catalog-browsing redesign was rejected: a bundled list of thousands of
 * models is not a useful entry point, and a three-stage wizard is too many
 * clicks. The flow these tests pin is: one form takes the base URL and key, the
 * AI service is asked which models it serves, models.dev only enriches what
 * came back, and the user picks from that live list.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const setupSource = await read("../src/components/settings/ProviderSetupDialog.tsx");
const hookSource = await read("../src/components/settings/useProviderModels.ts");
const pageSource = await read("../src/components/settings/ModelConfigPage.tsx");
const vendorDialogSource = await read("../src/components/settings/VendorAccountDialog.tsx");
const vendorAccountsSource = await read("../src/components/settings/VendorAccountsSection.tsx");
const apiSource = await read("../src/lib/api.ts");
const catalogContractSource = await read("../../../packages/shared/src/model-catalog.ts");
const styles = await loadStyles();

test("the model list comes from the AI service, not from a browsable catalog", () => {
  assert.match(hookSource, /api\.listProviderModels\(/);
  // The rejected surface and its host-side search must be gone.
  assert.doesNotMatch(setupSource, /ModelCatalogBrowser/);
  assert.doesNotMatch(vendorDialogSource, /ModelCatalogBrowser/);
  assert.doesNotMatch(apiSource, /searchCatalogModels/);
  assert.doesNotMatch(setupSource, /searchCatalogModels/);
});

test("adding an AI service is a single form, not a staged wizard", () => {
  assert.doesNotMatch(setupSource, /STAGES/);
  assert.doesNotMatch(setupSource, /provider-setup-stepper/);
  assert.doesNotMatch(setupSource, /provider-preset-grid/);
  assert.doesNotMatch(setupSource, /settings\.setupStage/);
  assert.doesNotMatch(setupSource, /settings\.next"/);
  // Name, base URL and key are all reachable without navigating a step.
  assert.match(setupSource, /settings\.name/);
  assert.match(setupSource, /settings\.baseUrl/);
  assert.match(setupSource, /settings\.apiKey/);
  assert.match(setupSource, /settings\.saveProvider/);
});

test("discovery is debounced, race-guarded and survives a bad URL", () => {
  assert.match(hookSource, /FETCH_DEBOUNCE_MS/);
  assert.match(hookSource, /requestSeq/);
  assert.match(hookSource, /new URL\(/);
  assert.match(hookSource, /clearTimeout/);
  // A local or no-auth gateway must still be probed, so a key is not required.
  assert.doesNotMatch(hookSource, /apiKey\.trim\(\)\.length > 0/);
});

test("an unsaved provider can be probed before it is persisted", () => {
  // baseUrl + apiKey with no providerId is what the host treats as a raw probe.
  assert.match(hookSource, /baseUrl/);
  assert.match(hookSource, /apiKey/);
  assert.match(
    apiSource,
    /listProviderModels: \(input: \{[\s\S]*?providerId\?: string;[\s\S]*?baseUrl\?: string;[\s\S]*?apiKey\?: string;/,
  );
});

test("editing paints the cached list first, then replaces it with a live answer", () => {
  assert.match(hookSource, /source: "cache"/);
  // The live call omits `source` entirely; that is what selects the live branch.
  assert.match(hookSource, /status: "error"/);
  assert.match(hookSource, /cachedModels/);
});

test("the renderer can tell a catalog fallback from the service's own answer", () => {
  assert.match(apiSource, /"cache" \| "remote" \| "catalog" \| "fallback"/);
  assert.match(hookSource, /source/);
});

test("token limits are adopted from the published record, never typed by default", () => {
  assert.match(catalogContractSource, /export function bindingFromModelInfo/);
  assert.match(catalogContractSource, /CATALOG_DEFAULT_CONTEXT_WINDOW/);
  assert.match(catalogContractSource, /CATALOG_DEFAULT_MAX_TOKENS/);
  assert.match(setupSource, /bindingFromModelInfo\(/);
  assert.match(vendorDialogSource, /bindingFromModelInfo\(/);
  // Numeric overrides stay behind the per-row disclosure.
  assert.match(setupSource, /expandedModelId/);
});

test("the API format stays derived and out of the main path", () => {
  assert.match(setupSource, /provider-advanced/);
  assert.match(setupSource, /settings\.apiStyleDerived/);
  assert.match(setupSource, /API_STYLES/);
});

test("both credential kinds share one live list and one binding shape", () => {
  assert.match(setupSource, /useProviderModels/);
  assert.match(vendorDialogSource, /useProviderModels/);
  assert.match(vendorDialogSource, /models: ModelBinding\[\]/);
  assert.match(vendorDialogSource, /modelId: models\[0\]\.id/);
  assert.match(vendorAccountsSource, /models: form\.models/);
  assert.doesNotMatch(vendorAccountsSource, /source: _source/);
});

test("model ids are matched case-insensitively across picking and hand entry", () => {
  for (const source of [setupSource, vendorDialogSource]) {
    assert.match(source, /toLowerCase\(\)/);
    assert.match(source, /bindingForCustomModel\(/);
    assert.match(source, /settings\.modelAlreadyAdded/);
  }
});

test("editing the default provider re-syncs the default model id", () => {
  assert.match(
    pageSource,
    /defaultModelId: defaultModelIdOf\(provider\) \|\| settings\.defaultModelId/,
  );
  assert.match(
    pageSource,
    /settings\.defaultProviderId === saved\.id && firstModelId[\s\S]*defaultModelId: firstModelId/,
  );
  assert.match(pageSource, /provider\.models\?\.\[0\]\?\.id/);
});

test("the rejected catalog-browser styles are gone from the cascade", () => {
  assert.doesNotMatch(styles, /\.model-catalog-panes\s*\{/);
  assert.doesNotMatch(styles, /\.model-catalog-filter\s*\{/);
  assert.doesNotMatch(styles, /\.provider-setup-stepper\s*\{/);
  assert.doesNotMatch(styles, /\.provider-preset-card\s*\{/);
  // Only the dialog body scrolls, so the action bar stays reachable.
  assert.match(styles, /\.provider-setup-body\s*\{[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});
