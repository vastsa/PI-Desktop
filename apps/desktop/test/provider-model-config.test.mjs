/**
 * Contract tests for the redesigned model configuration surfaces.
 *
 * The old dense provider form (ProviderDialog + ModelMultiSelect +
 * ModelConfigCard + useProviderModels) was replaced by a catalog-first flow:
 * ProviderSetupDialog stages the setup, ModelCatalogBrowser is the single model
 * picker for both the API-key and the OAuth path, and ModelConfigPage hosts
 * them. These assertions pin the behaviour that redesign is meant to
 * guarantee, not the markup it happens to use.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const browserSource = await read("../src/components/settings/ModelCatalogBrowser.tsx");
const setupSource = await read("../src/components/settings/ProviderSetupDialog.tsx");
const pageSource = await read("../src/components/settings/ModelConfigPage.tsx");
const vendorDialogSource = await read("../src/components/settings/VendorAccountDialog.tsx");
const vendorAccountsSource = await read("../src/components/settings/VendorAccountsSection.tsx");
const catalogContractSource = await read("../../../packages/shared/src/model-catalog.ts");
const styles = await loadStyles();

test("the catalog browser searches models.dev in the host, not in the renderer", () => {
  assert.match(browserSource, /api\.searchCatalogModels/);
  assert.match(browserSource, /SEARCH_DEBOUNCE_MS/);
  // A stale reply must never overwrite a newer one.
  assert.match(browserSource, /requestSeq/);
  assert.match(browserSource, /if \(requestSeq\.current !== requestId\) return;/);
  assert.match(browserSource, /degraded/);
  // No client-side scan of the whole catalog.
  assert.doesNotMatch(browserSource, /listModels\(/);
});

test("the catalog browser exposes capability filters and published metadata", () => {
  assert.match(browserSource, /MODEL_FILTERS\.map/);
  for (const filter of ["reasoning", "vision", "tools", "attachments"]) {
    assert.match(browserSource, new RegExp(`${filter}: t\\("settings\\.modelFilter`, "i"));
  }
  assert.match(browserSource, /formatTokenCount/);
  assert.match(browserSource, /formatModelPrice/);
  assert.match(browserSource, /sortThinkingLevels/);
  // The detail pane is a labelled definition list, not a JSON dump.
  assert.match(browserSource, /<dl className="model-catalog-detail-grid">/);
  assert.match(browserSource, /<dt>\{label\}<\/dt>/);
  assert.doesNotMatch(browserSource, /JSON\.stringify/);
});

test("the catalog browser is a keyboard-operable multi-select listbox", () => {
  assert.match(browserSource, /role="listbox"/);
  assert.match(browserSource, /aria-multiselectable="true"/);
  assert.match(browserSource, /aria-activedescendant/);
  assert.match(browserSource, /role="option"/);
  assert.match(browserSource, /aria-selected=\{isSelected\}/);
  assert.match(browserSource, /"ArrowDown"/);
  assert.match(browserSource, /"ArrowUp"/);
  assert.match(browserSource, /"Enter"/);
  assert.match(browserSource, /"Escape"/);
  assert.match(browserSource, /aria-autocomplete="list"/);
  assert.match(browserSource, /title=\{model\.modelId\}/);
});

test("token limits are adopted from the published record, never typed by default", () => {
  assert.match(catalogContractSource, /export function bindingFromModelInfo/);
  assert.match(catalogContractSource, /CATALOG_DEFAULT_CONTEXT_WINDOW/);
  assert.match(catalogContractSource, /CATALOG_DEFAULT_MAX_TOKENS/);
  assert.match(setupSource, /bindingFromModelInfo\(model\)/);
  assert.match(vendorDialogSource, /bindingFromModelInfo\(model\)/);
  // The numeric overrides exist, but only behind a per-row disclosure.
  assert.match(setupSource, /expandedModelId/);
  assert.match(setupSource, /hidden=\{expandedModelId !== binding\.id\}/);
});

test("model ids are matched case-insensitively across picking and hand entry", () => {
  // A hand-typed "GPT-5" and the published "gpt-5" are the same model, so the
  // check mark, the toggle and the duplicate guard must all agree.
  assert.match(browserSource, /selectedIds\.map\(\(id\) => id\.toLowerCase\(\)\)/);
  assert.match(browserSource, /selected\.has\(model\.modelId\.toLowerCase\(\)\)/);
  for (const source of [setupSource, vendorDialogSource]) {
    assert.match(source, /const wanted = model\.modelId\.toLowerCase\(\);/);
    assert.match(source, /binding\.id\.toLowerCase\(\) === wanted/);
    assert.match(source, /binding\.id\.toLowerCase\(\) !== wanted/);
    assert.match(source, /binding\.id\.toLowerCase\(\) === id\.toLowerCase\(\)/);
  }
});

test("a failed catalog load still leaves a way to add a model by hand", () => {
  // The preset grid degrades to the custom-endpoint card, and the chosen-models
  // section always offers manual entry.
  assert.match(setupSource, /setPresets\(\[\]\);/);
  assert.match(setupSource, /if \(provider\) setCustom\(true\)/);
  assert.match(setupSource, /bindingForCustomModel\(id\)/);
  assert.match(vendorDialogSource, /bindingForCustomModel\(/);
  assert.match(browserSource, /settings\.modelCatalogDegraded/);
});

test("provider setup is staged and derives the wire API from the preset", () => {
  assert.match(setupSource, /const STAGES = \["provider", "credential", "models"\] as const/);
  assert.match(setupSource, /aria-current=\{entry === stage \? "step" : undefined\}/);
  assert.match(setupSource, /entry\.apiStyle/);
  // The API format is not a required user choice; it sits under Advanced.
  assert.match(setupSource, /<details\s*\n?\s*className="provider-advanced"/);
  assert.match(setupSource, /settings\.apiStyleDerived/);
  assert.match(setupSource, /CUSTOM_PRESET_KEY/);
});

test("presets come from the catalog rather than a hardcoded provider table", () => {
  assert.match(setupSource, /loadPresets = api\.catalogPresets/);
  assert.match(setupSource, /setPresets\(result\.presets\)/);
  assert.match(setupSource, /entry\.configuredProviderId/);
  assert.match(setupSource, /preset\.envVars/);
  assert.match(setupSource, /preset\.doc/);
});

test("both credential kinds share one model picker and one binding shape", () => {
  assert.match(setupSource, /<ModelCatalogBrowser/);
  assert.match(vendorDialogSource, /<ModelCatalogBrowser/);
  assert.match(vendorDialogSource, /models: ModelBinding\[\]/);
  // The account default model is always the head of the binding list.
  assert.match(vendorDialogSource, /modelId: models\[0\]\.id/);
  assert.match(vendorAccountsSource, /models: form\.models/);
  assert.doesNotMatch(vendorAccountsSource, /source: _source/);
});

test("editing the default provider re-syncs the default model id", () => {
  assert.match(pageSource, /defaultModelId: defaultModelIdOf\(provider\) \|\| settings\.defaultModelId/);
  assert.match(
    pageSource,
    /settings\.defaultProviderId === saved\.id && firstModelId[\s\S]*defaultModelId: firstModelId/,
  );
  assert.match(pageSource, /provider\.models\?\.\[0\]\?\.id/);
});

test("settings can refresh models.dev in memory without replacing the snapshot", () => {
  assert.match(pageSource, /api\.refreshModelCatalog\(\)/);
  assert.match(pageSource, /refreshingCatalog/);
  assert.match(pageSource, /catalogStatus/);
});

test("the catalog browser is a two-pane layout that scrolls internally", () => {
  assert.match(
    styles,
    /\.model-catalog-panes\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1\.15fr\) minmax\(0, 1fr\)/,
  );
  assert.match(styles, /\.model-catalog-list\s*\{[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.model-catalog-list\s*\{[\s\S]*?overscroll-behavior: contain;/);
  assert.match(styles, /\.model-catalog-group-head\s*\{[\s\S]*?position: sticky;/);
  assert.match(styles, /\.model-catalog-detail-pane\s*\{[\s\S]*?overflow-y: auto;/);
  // Only the dialog body scrolls, so the stepper and actions stay put.
  assert.match(styles, /\.provider-setup-body\s*\{[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.provider-setup-dialog\s*\{[\s\S]*?max-height: min\(760px, calc\(100vh - 64px\)\)/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.model-catalog-panes\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
});

test("interactive catalog controls keep visible focus and a stable check slot", () => {
  assert.match(styles, /\.model-catalog-filter:focus-visible\s*\{/);
  assert.match(styles, /\.provider-preset-card:focus-visible\s*\{/);
  assert.match(styles, /\.model-default-option:focus-visible\s*\{/);
  assert.match(styles, /\.provider-thinking-chip\s*\{[\s\S]*?min-height: 24px/);
  // The check reserves its box so selection does not reflow the row.
  assert.match(styles, /\.model-catalog-check\s*\{[\s\S]*?width: 16px;[\s\S]*?height: 16px;/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});
