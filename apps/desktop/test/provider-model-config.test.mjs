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
const pickerSource = await read("../src/components/settings/ModelSelectionPanes.tsx");
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
  // Both dialogs adopt them through the one shared picker (D269).
  assert.match(pickerSource, /bindingFromModelInfo\(/);
  // Numeric overrides stay behind the per-row disclosure.
  assert.match(pickerSource, /expandedModelId/);
});

test("the API format stays derived rather than asked for", () => {
  // It is a plain field in the credential grid now, but it must still explain
  // that its value is derived, so nobody treats it as a required choice.
  assert.match(setupSource, /settings\.apiStyleDerived/);
  assert.match(setupSource, /API_STYLES/);
  assert.doesNotMatch(setupSource, /provider-advanced/);
});

test("both credential kinds share one live list and one binding shape", () => {
  assert.match(setupSource, /useProviderModels/);
  assert.match(vendorDialogSource, /useProviderModels/);
  assert.match(vendorDialogSource, /models: ModelBinding\[\]/);
  // The account's default model is still the head binding, taken from the
  // narrowed list the picker hands back rather than from raw state.
  assert.match(vendorDialogSource, /modelId: persisted\[0\]\.id/);
  assert.match(vendorAccountsSource, /models: form\.models/);
  assert.doesNotMatch(vendorAccountsSource, /source: _source/);
});

test("one picker component serves the service dialog and the account dialog", () => {
  // The two surfaces were copies, and the copy lost the advanced controls.
  // Neither dialog may grow its own picker back.
  for (const source of [setupSource, vendorDialogSource]) {
    assert.match(source, /ModelSelectionPanes/);
    assert.match(source, /useModelSelection\(/);
    assert.doesNotMatch(source, /provider-models-list/);
    assert.doesNotMatch(source, /provider-chosen-list/);
    assert.doesNotMatch(source, /visibleRows/);
    assert.doesNotMatch(source, /addCustomModel/);
    assert.doesNotMatch(source, /toggleModel/);
  }
  // Only the heading of the discovered list differs between them.
  assert.match(setupSource, /listTitle=\{t\("settings\.serviceModels"\)\}/);
  assert.match(vendorDialogSource, /listTitle=\{t\("settings\.accountModels"\)\}/);
});

test("the shared picker owns the advanced per-model controls for both kinds", () => {
  assert.match(pickerSource, /provider-chosen-advanced-toggle/);
  assert.match(pickerSource, /settings\.contextWindow/);
  assert.match(pickerSource, /settings\.maxOutput/);
  assert.match(pickerSource, /provider-chosen-thinking-chips/);
  assert.match(pickerSource, /publishedThinkingLevels/);
  assert.match(pickerSource, /bindingsToPersist/);
});

test("a vendor account saves explicit bindings, not raw state", () => {
  // The shared picker preserves explicit thinking levels, including a manual
  // override not present in the catalog.
  assert.match(vendorDialogSource, /selection\.bindingsToPersist/);
  assert.match(vendorDialogSource, /models: persisted/);
  assert.doesNotMatch(vendorDialogSource, /models: models \}/);
});

test("model ids are matched case-insensitively across picking and hand entry", () => {
  // One picker, so one matching rule for both credential kinds.
  assert.match(pickerSource, /toLowerCase\(\)/);
  assert.match(pickerSource, /bindingForCustomModel\(/);
  assert.match(pickerSource, /settings\.modelAlreadyAdded/);
});

test("default model selection saves the exact model and provider", () => {
  // The settings picker is model-level; provider rows still use their first
  // model as a convenience action.
  assert.match(pageSource, /const setDefaultModel = async \(provider: ProviderPublic, modelId: string\)/);
  assert.match(pageSource, /defaultProviderId: provider.id,[\s\S]*defaultModelId: modelId/);
  assert.match(pageSource, /onClick=\{\(\) => void setDefaultModel\(provider, modelId\)\}/);
  assert.match(pageSource, /visibleDefaultModelOptions\.map/);
  assert.match(pageSource, /provider\.id === settings\.defaultProviderId &&[\s\S]*modelIdsMatch/);
  assert.match(pageSource, /defaultModelId: firstModelId \?\? ""/);
  assert.match(
    pageSource,
    /settings\.defaultProviderId === saved\.id && firstModelId[\s\S]*defaultModelId: firstModelId/,
  );
  // The summary line must go through the ownership-aware resolver.
  assert.match(pageSource, /displayedDefaultModelId\(/);
  assert.doesNotMatch(pageSource, /\{settings\.defaultModelId \|\|/);
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
