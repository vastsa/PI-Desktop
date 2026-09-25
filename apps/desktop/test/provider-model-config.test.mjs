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
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { normalizeApiStyle } = await import("@pi-desktop/shared");
const { normalizeBaseUrlInput } = await import("../src/components/settings/provider-endpoint-guidance.ts");

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const setupSource = await read("../src/components/settings/ProviderSetupDialog.tsx");
const hookSource = await read("../src/components/settings/useProviderModels.ts");
const pageSource = await read("../src/components/settings/ModelConfigPage.tsx");
const vendorDialogSource = await read("../src/components/settings/VendorAccountDialog.tsx");
const pickerSource = await read("../src/components/settings/ModelSelectionPanes.tsx");
const filterSource = await read("../src/components/settings/model-chosen-filter.ts");
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

test("custom API format is a common-path choice, named services skip it", () => {
  assert.match(setupSource, /settings\.apiStyle/);
  assert.match(setupSource, /API_STYLES/);
  assert.match(setupSource, /custom \? \(/);
  assert.match(setupSource, /provider-advanced-dialog/);
  assert.doesNotMatch(setupSource, /provider-setup-advanced-toggle/);
});

test("editing a provider with an unknown persisted API style stays renderable", () => {
  assert.match(setupSource, /normalizeApiStyle\(provider\?\.apiStyle\)/);
  const style = normalizeApiStyle("future_api_format");
  assert.equal(style, "chat_completions");
  assert.equal(
    normalizeBaseUrlInput("https://relay.example/v1/chat/completions", style),
    "https://relay.example/v1",
  );
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
    assert.doesNotMatch(source, /applyVisibleModelSelection/);
    assert.doesNotMatch(source, /selectAllVisibleModels/);
    assert.doesNotMatch(source, /fetchModelList/);
    assert.match(source, /onReload=\{discovery\.reload\}/);
  }
  // Only the heading of the discovered list differs between them.
  assert.match(setupSource, /listTitle=\{t\("settings\.serviceModels"\)\}/);
  assert.match(vendorDialogSource, /listTitle=\{t\("settings\.accountModels"\)\}/);
});

test("a header action probes the live list without waiting for debounce", () => {
  assert.match(hookSource, /reload: \(\) => void/);
  assert.match(hookSource, /skipCache: true/);
  assert.match(hookSource, /skipCache \? modelsRef\.current/);
  assert.match(hookSource, /canReload/);
  // Idle-with-a-valid-URL (the edit debounce) must still be reloadable.
  assert.match(hookSource, /status !== "loading"/);
  assert.match(pickerSource, /disabled=\{busy \|\| !discovery\.canReload\}/);
  assert.doesNotMatch(
    pickerSource,
    /discovery\.status === "idle" \|\| discovery\.status === "loading"/,
  );
  // The automatic path still waits; only the header action skips the window.
  assert.match(hookSource, /FETCH_DEBOUNCE_MS/);
  assert.match(pickerSource, /settings\.fetchModelList/);
  assert.match(pickerSource, /provider-models-reload/);
  assert.match(pickerSource, /onReload/);
  assert.doesNotMatch(pickerSource, /provider-models-state/);
});

test("the shared picker can select or clear every visible model at once", () => {
  assert.match(pickerSource, /export function applyVisibleModelSelection/);
  assert.match(pickerSource, /provider-models-select-all/);
  assert.match(pickerSource, /toggleVisibleModels/);
  assert.match(pickerSource, /settings\.selectAllVisibleModels/);
  assert.match(pickerSource, /settings\.deselectAllVisibleModels/);
  assert.match(pickerSource, /el\.indeterminate/);
  // A filtered select-all must not drop models the filter is hiding.
  assert.match(pickerSource, /a filtered select-all does not touch hidden matches/);
  assert.match(pickerSource, /visibleRows\.length > 0/);
});

test("the shared picker owns the advanced per-model controls for both kinds", () => {
  assert.match(pickerSource, /provider-chosen-advanced-toggle/);
  assert.match(pickerSource, /settings\.contextWindow/);
  assert.match(pickerSource, /settings\.maxOutput/);
  assert.match(pickerSource, /provider-chosen-thinking-chips/);
  assert.match(pickerSource, /publishedThinkingLevels/);
  assert.match(pickerSource, /bindingsToPersist/);
});

test("fetched model selections stay collapsed until Advanced is requested", () => {
  assert.match(
    pickerSource,
    /const \[expandedModelId, setExpandedModelId\] = useState<string \| null>\(null\)/,
  );
  assert.doesNotMatch(
    pickerSource,
    /setExpandedModelId\(\(open\) => open \?\? (?:row\.id|visibleRows\[0\])/,
  );
  assert.match(pickerSource, /current === binding\.id \? null : binding\.id/);
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
  assert.match(pageSource, /provider\.id === settings\.defaultProviderId &&[\s\S]*sameWireId/);
  assert.match(pageSource, /defaultModelId: firstModelId \?\? ""/);
  assert.match(
    pageSource,
    /settings\.defaultProviderId === saved\.id && firstModelId[\s\S]*defaultModelId: firstModelId/,
  );
  // The summary line must resolve a configured complete wire id.
  assert.match(pageSource, /displayedChatModelId\(/);
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

test("model ids are copyable and a configured model can carry an alias", () => {
  // The shell is non-selectable, so the id/name text opts back in.
  assert.match(pickerSource, /provider-models-row-copy selectable/);
  assert.match(pickerSource, /provider-chosen-row-id font-mono selectable/);
  // A drag-selection inside the row is a copy gesture, not a checkbox toggle.
  // The guard is row-scoped, so a stale selection elsewhere on the page cannot
  // cancel a plain click or the Space key's synthetic click.
  assert.match(pickerSource, /selection\.isCollapsed/);
  assert.match(pickerSource, /row\.contains\(selection\.anchorNode\)/);
  assert.match(pickerSource, /row\.contains\(selection\.focusNode\)/);
  // Keyboard activation reports detail 0 and must still toggle.
  assert.match(pickerSource, /event\.detail === 0/);
  // A selection left behind by copying must not block an explicit checkbox click.
  assert.match(pickerSource, /event\.target instanceof HTMLInputElement/);
  assert.match(pickerSource, /event\.preventDefault\(\)/);
  assert.doesNotMatch(pickerSource, /window\.getSelection\(\)\?\.toString\(\)/);
  // The alias is edited in the Advanced body and shown beside the id.
  assert.match(pickerSource, /settings\.modelAlias/);
  assert.match(pickerSource, /updateBinding\(binding\.id, \{/);
  // The 60-character cap counts Unicode scalars, matching host-core.
  assert.match(pickerSource, /\[\.\.\.event\.target\.value\]\.slice\(0, 60\)/);
  assert.match(pickerSource, /provider-chosen-row-alias/);
  assert.match(styles, /\.provider-chosen-row-alias\s*\{/);
});

test("the chosen pane narrows a long configured list with its own search", () => {
  // Both panes of the shared picker own a search field, so finding one model
  // inside fifty configured rows does not mean scrolling.
  assert.match(pickerSource, /provider-chosen-search-wrap/);
  assert.match(pickerSource, /provider-chosen-search"/);
  assert.match(pickerSource, /settings\.searchChosenModels/);
  assert.match(pickerSource, /visibleChosen\.map\(/);
  // The filter is a view: the badge beside the title still reports every
  // configured model, and removing a filtered row still removes the binding.
  assert.match(pickerSource, /provider-chosen-count">\{models\.length\}/);
  // The rule itself is executed by model-chosen-filter.test.mjs; here the pane
  // only has to delegate to it for the view and for every add path.
  assert.match(filterSource, /export function filterChosenModels/);
  assert.match(filterSource, /export function hidesAddedBinding/);
  assert.match(pickerSource, /filterChosenModels\(models, chosenQuery, rows\)/);
  // "Nothing matches" is a different message from "nothing chosen yet".
  assert.match(pickerSource, /models\.length === 0 \? \(/);
  assert.match(pickerSource, /visibleChosen\.length === 0 \? \(/);
  assert.match(pickerSource, /settings\.noModelsChosen/);
  assert.match(pickerSource, /settings\.noChosenModelMatches/);
  // Every add path — checkbox, select-all, hand-typed — asks that same rule
  // whether the new model would land behind the filter typed earlier, and an
  // emptied list drops the filter instead of stranding it in a disabled field.
  assert.equal([...pickerSource.matchAll(/keepAddedModelVisible\(/g)].length, 3);
  assert.match(pickerSource, /if \(models\.length === 0\) setChosenQuery\(""\)/);
  // No dead control: the field is off while saving or with nothing to search.
  assert.match(pickerSource, /disabled=\{busy \|\| models\.length === 0\}/);
  // One control, one rule: the two searches share declarations rather than
  // drifting apart as two copies of the same box.
  assert.match(
    styles,
    /\.provider-models-search-wrap,\s*\.provider-chosen-search-wrap\s*\{/,
  );
  assert.match(styles, /\.provider-models-search,\s*\.provider-chosen-search\s*\{/);
  // Narrow panes give the field its own row instead of squeezing the header.
  assert.match(styles, /\.provider-chosen-head\s*\{[\s\S]*?flex-wrap: wrap;/);
  assert.match(
    styles,
    /@media \(max-width: 720px\)\s*\{[\s\S]*?\.provider-chosen-search-wrap/,
  );
});

test("selected models reorder from a dedicated handle, not the copyable id", () => {
  // The handle is the only drag source so selecting an id still copies it.
  assert.match(pickerSource, /useModelReorder\(visibleChosen, setModels, busy\)/);
  assert.match(pickerSource, /provider-chosen-reorder/);
  assert.match(pickerSource, /IconGripVertical/);
  assert.match(pickerSource, /settings\.reorderModel/);
  assert.match(pickerSource, /\{\.\.\.reorder\.handleEvents\(binding\.id\)\}/);
  assert.match(pickerSource, /\{\.\.\.reorder\.rowEvents\(binding\.id\)\}/);
  assert.doesNotMatch(pickerSource, /provider-chosen-row-id[\s\S]*draggable/);
  assert.match(styles, /\.provider-chosen-reorder\s*\{/);
  assert.match(styles, /\.provider-chosen-row\.is-dragging\s*\{/);
  assert.match(styles, /\.provider-chosen-row\[data-drop-placement\]::after/);
});

test("adding a service only claims the app default while none resolves", () => {
  // The add branch used to write defaultProviderId/defaultModelId
  // unconditionally, so configuring a second service silently moved the app
  // default away from the one the user was already running.
  const branch = pageSource.match(
    /\} else if \(!editingProvider\) \{([\s\S]*?)\n      \} else \{/,
  );
  assert.ok(branch, "the add-provider branch moved");
  const guard = branch[1].indexOf("const keepsCurrentDefault =");
  const write = branch[1].indexOf("api.setSettings(");
  assert.ok(guard >= 0, "the add branch must ask whether a default already resolves");
  assert.ok(write > guard, "the default write must sit inside that guard");
  // Which provider wins is decided by the shared resolver, whose behaviour is
  // pinned by default-model-display.test.mjs. That resolver also requires the
  // default provider to be runnable (enabled, credentialed, a chat model
  // configured), so a keyless default row cannot block the new provider.
  // Provider readiness and default selection use the same exact chat choices.
  assert.match(pageSource, /chatModelOptions\(\[currentProvider\], imageGenerationCandidates\)/);
  assert.match(pageSource, /providerServesChatModels\(provider, imageGenerationCandidates\)/);
});

test("a saved image selection never takes the app's image default", () => {
  // The image default follows the same rule: the candidate list grows, the
  // default moves only when the stored binding stops resolving. The decision
  // itself is pinned by image-generation-default.test.mjs.
  assert.match(pageSource, /planImageGenerationDefaults\(\n\s+current,\n\s+saved\.id,/);
  assert.doesNotMatch(pageSource, /nextActive/);
});

test("a hand-typed id is seeded from the model library, not only from generic defaults", () => {
  // The row is inserted immediately and upgraded in place when the snapshot
  // answers, so a slow or offline catalog never leaves the list without it. The
  // rule itself is pinned by model-custom-lookup.test.mjs, and the channel
  // contract by provider-lookup-model-handler.test.mjs.
  assert.match(pickerSource, /bindingForCustomModelInfo\(id, discovered\.info\)/);
  assert.match(pickerSource, /applyCustomModelLookup\(current, seed, info\)/);
  assert.match(pickerSource, /api\.lookupProviderModel\(/);
  // An id the current discovery already described needs no round trip.
  assert.match(pickerSource, /if \(!discovered\?\.info\) void enrichCustomModel\(binding\)/);
});

test("settings match complete case-normalized wire ids, not proxy suffixes", () => {
  const identity = pageSource.match(/const sameWireId = \(left: string, right: string\) => ([^;]+);/);
  assert.ok(identity);
  const sameWireId = new Function("left", "right", `return ${identity[1]}`);
  assert.equal(sameWireId("PROXY/model", "proxy/MODEL"), true);
  assert.equal(sameWireId("proxy/model", "model"), false);
  assert.match(pageSource, /isImageCandidate\(imageModels, provider\.id, id\)/);
  assert.match(pageSource, /sameWireId\(settings\.defaultModelId \?\? "", modelId\)/);
  assert.match(pageSource, /!models\.some\(\(model\) => sameWireId\(model\.id, settings\.defaultModelId/);
  assert.doesNotMatch(pageSource, /modelIdsMatch|isImageGenerationModel/);
  assert.doesNotMatch(setupSource, /modelIdsMatch/);
  assert.doesNotMatch(pickerSource, /modelIdsMatch/);
  assert.match(pickerSource, /info\.modelId\.toLowerCase\(\) !== seed\.id\.toLowerCase\(\)/);
  assert.match(pickerSource, /bindingForCustomModelInfo\(row\.id, row\.info\)/);
  assert.match(setupSource, /model\.id\.toLowerCase\(\) === imageModelId\.toLowerCase\(\)/);
  assert.match(setupSource, /entry\.toLowerCase\(\) !== id\.toLowerCase\(\)/);
});

test("new chat default skips an image-only first model", () => {
  assert.match(pageSource, /const firstModelId = models\.find\(\(model\) =>\s*!selectedImageIds\.some\(\(id\) => sameWireId\(id, model\.id\)\)/);
  assert.match(pageSource, /if \(!keepsCurrentDefault && firstModelId\)/);
});

test("stale image-valued chat default remains visible but is not marked ready", () => {
  assert.match(pageSource, /const defaultProviderReady = defaultProvider !== null && providerReady\(defaultProvider\) &&[\s\S]*?chatModelOptions\(\[defaultProvider\], imageGenerationCandidates\)\.some/);
  assert.match(pageSource, /const effectiveDefaultModelId = settings\.defaultModelId\?\.trim\(\) \|\|\s*defaultProvider\?\.models\?\.\[0\]\?\.id \|\| defaultProvider\?\.defaultModelId/);
  assert.match(pageSource, /sameWireId\(modelId, effectiveDefaultModelId \?\? ""\)/);
  assert.match(pageSource, /return selected\?\.trim\(\) \|\| configured\[0\]/);
  assert.match(pageSource, /className="model-default-model font-mono" title=\{t\("settings\.noDefaultProvider"\)\}/);
  assert.match(pageSource, /\{settings\.defaultModelId\}/);
});
