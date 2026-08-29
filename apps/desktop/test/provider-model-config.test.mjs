import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const cardSource = await readFile(
  new URL("../src/components/settings/ModelConfigCard.tsx", import.meta.url),
  "utf8",
);
const pickerSource = await readFile(
  new URL("../src/components/settings/ModelMultiSelect.tsx", import.meta.url),
  "utf8",
);
const hookSource = await readFile(
  new URL("../src/components/settings/useProviderModels.ts", import.meta.url),
  "utf8",
);
const formSource = await readFile(
  new URL("../src/components/settings/provider-form.ts", import.meta.url),
  "utf8",
);
const dialogSource = await readFile(
  new URL("../src/components/settings/ProviderDialog.tsx", import.meta.url),
  "utf8",
);
const vendorDialogSource = await readFile(
  new URL("../src/components/settings/VendorAccountDialog.tsx", import.meta.url),
  "utf8",
);
const vendorAccountsSource = await readFile(
  new URL("../src/components/settings/VendorAccountsSection.tsx", import.meta.url),
  "utf8",
);
const providersSource = await readFile(
  new URL("../src/components/settings/ProvidersSection.tsx", import.meta.url),
  "utf8",
);
const styles = await loadStyles();

test("model configuration surfaces models.dev metadata per model", () => {
  assert.match(cardSource, /metadata\?: ModelInfo \| null/);
  assert.match(cardSource, /metadata\?\.modalities/);
  assert.match(cardSource, /provider-model-modalities/);
  assert.match(cardSource, /capabilities\.includes\("vision"\)/);
  assert.match(cardSource, /visionLabel/);
  assert.match(cardSource, /reasoningLabel/);
  assert.match(pickerSource, /model\.modalities/);
  assert.match(pickerSource, /model\.capabilities\.includes\("vision"\)/);
  assert.match(pickerSource, /visionLabel/);
});

test("settings can refresh models.dev in memory without replacing the release snapshot", () => {
  assert.match(providersSource, /api\.refreshModelCatalog\(\)/);
  assert.match(providersSource, /refreshingCatalog/);
  assert.match(providersSource, /refreshModelCatalog/);
});

test("model discovery also probes no-auth and local endpoints", () => {
  assert.match(hookSource, /new URL\(baseUrl\.trim\(\)\)/);
  assert.match(hookSource, /Discovery is also useful for local\/no-auth gateways/);
  assert.doesNotMatch(hookSource, /apiKey\.trim\(\)\.length > 0/);
});

test("OpenCode Go keeps the provider identity fixed while accepting a key", () => {
  assert.match(formSource, /OPENCODE_GO_API_STYLE/);
  assert.match(formSource, /OPENCODE_GO_BASE_URL/);
  assert.match(formSource, /OPENCODE_GO_NAME/);
  assert.match(dialogSource, /readOnly=\{isOpenCodeGo\}/);
  assert.match(dialogSource, /apiStyleOpenCodeGoFixed/);
  assert.match(dialogSource, /autoFocus=\{isOpenCodeGo\}/);
});

test("model picker stays open while its option list scrolls", () => {
  assert.match(pickerSource, /const onScroll = \(event: Event\) =>/);
  assert.match(pickerSource, /menuRef\.current\?\.contains\(target\)\) return;/);
  assert.match(pickerSource, /addEventListener\("scroll", onScroll, true\)/);
  assert.doesNotMatch(pickerSource, /addEventListener\("scroll", close, true\)/);
});

test("model picker exposes a clear empty state and focusable list contract", () => {
  assert.match(pickerSource, /noMatchesHint: string/);
  assert.match(pickerSource, /aria-autocomplete="list"/);
  assert.match(pickerSource, /aria-controls=\{listId\}/);
  assert.match(pickerSource, /title=\{model\.modelId\}/);
  assert.match(styles, /\.provider-model-multi-option:focus-visible/);
  assert.match(styles, /overscroll-behavior: contain/);
});

test("vendor account settings expose and persist the full model configuration", () => {
  assert.match(vendorDialogSource, /ModelMultiSelect/);
  assert.match(vendorDialogSource, /ModelConfigCard/);
  assert.match(vendorDialogSource, /models: ProviderModelDraft\[\]/);
  assert.match(vendorAccountsSource, /models,\n      \}\);/);
});

test("model settings keep a compact, non-floating card treatment", () => {
  assert.match(cardSource, /initiallyExpanded\?: boolean/);
  assert.match(cardSource, /aria-expanded=\{expanded\}/);
  assert.match(cardSource, /hidden=\{!expanded\}/);
  assert.match(dialogSource, /initiallyExpanded=\{false\}/);
  assert.match(vendorDialogSource, /initiallyExpanded=\{false\}/);
  assert.doesNotMatch(dialogSource, /initiallyExpanded=\{index === 0\}/);
  assert.doesNotMatch(vendorDialogSource, /initiallyExpanded=\{index === 0\}/);
  assert.match(styles, /.provider-model-selection-grid\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /.provider-model-card-list\s*\{[\s\S]*?max-height: min\(320px, 36vh\);[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /.provider-model-card-list\s*\{[\s\S]*?border-radius: var\(--radius-md-plus\)/);
  assert.match(styles, /.provider-model-card-summary\s*\{/);
  assert.match(styles, /.provider-model-card-details\s*\{/);
  assert.match(styles, /.provider-model-capabilities\s*\{/);
  assert.match(styles, /.provider-thinking-chip\s*\{[\s\S]*?min-height: 24px/);
  assert.doesNotMatch(
    styles,
    /\.provider-model-card:hover\s*\{[^}]*transform:\s*translateY/,
  );
});
