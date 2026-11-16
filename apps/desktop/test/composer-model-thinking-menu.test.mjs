import { readComposerModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const [modelMenuSource, pickerSource, sliderSource] = await Promise.all([
  readComposerModule("hooks/useComposerModelMenu.ts"),
  readComposerModule("ComposerModelPicker.tsx"),
  readComposerModule("ThinkingLevelSlider.tsx"),
]);
const listSource = await readComposerModule("ComposerModelList.tsx");
const composerSource = `${modelMenuSource}\n${pickerSource}\n${sliderSource}\n${listSource}`;
const stylesSource = await loadStyles();

test("Composer uses one searchable model menu with a source rail", () => {
  assert.doesNotMatch(composerSource, /ComposerMenuView|composer-menu-back|showView|otherModelsExpanded/);
  assert.match(pickerSource, /<ComposerModelList/);
  assert.match(pickerSource, /composer-model-menu composer-model-thinking-menu \$\{showSectionRail \? "has-rail" : ""\}/);
  // Every source is one click away: the rail lists recent + each provider,
  // its items are radios, and search spans every source at once.
  assert.match(listSource, /className="composer-model-rail" role="group" aria-label=\{t\("chat\.modelSources"\)\}/);
  assert.match(listSource, /aria-checked=\{current\}/);
  assert.match(listSource, /onClick=\{\(\) => selectSection\(section\.id\)\}/);
  assert.match(modelMenuSource, /showSectionRail: sections\.length > 1/);
  assert.match(modelMenuSource, /searching\s*\? filteredModelGroups/);
  assert.match(stylesSource, /\.composer-model-body\[data-rail\] \{[^}]*grid-template-columns: 116px minmax\(0, 1fr\)/);
  // Switching sources never resizes the menu under the pointer.
  assert.match(modelMenuSource, /const paneRows = Math\.max\(/);
  assert.match(stylesSource, /\.composer-model-body\[data-rail\] \.composer-model-list,[\s\S]*?height: min\(264px, calc\(var\(--model-pane-rows, 8\) \* 30px \+ 4px\)\)/);
});

test("the source rail and pane move with the selection instead of snapping", () => {
  // One marker travels between rail items; its step matches the 28px row
  // plus the 2px gap, and it fades out while search releases the rail.
  assert.match(listSource, /className="composer-model-rail-indicator"/);
  assert.match(listSource, /data-hidden=\{railIndex < 0 \? "true" : undefined\}/);
  assert.match(stylesSource, /\.composer-model-rail-item \{[^}]*height: 28px;/);
  assert.match(stylesSource, /\.composer-model-rail \{[^}]*gap: 2px;/);
  assert.match(stylesSource, /transform: translateY\(calc\(var\(--rail-index, 0\) \* 30px\)\)/);
  // The pane is keyed by source and slides in from the side the rail moved
  // toward; the first render after opening does not animate.
  assert.match(listSource, /key=\{activeSection \?\? "search"\}/);
  assert.match(listSource, /data-step=\{sectionStep === 0 \? undefined : sectionStep < 0 \? "back" : "forward"\}/);
  assert.match(modelMenuSource, /setSectionStep\(to < from \? -1 : 1\)/);
  assert.match(modelMenuSource, /setSectionStep\(0\)/);
  // A current row is marked by a drawn check, and every motion has a
  // reduced-motion opt-out.
  assert.match(stylesSource, /\.composer-model-check path \{[^}]*animation: composer-model-check-draw/);
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.composer-model-pane\[data-step\][\s\S]*?\.composer-model-rail-indicator/);
});

test("Escape clears a search before it closes the menu", () => {
  assert.match(
    modelMenuSource,
    /if \(event\.key === "Escape"\) \{\s*event\.preventDefault\(\);[\s\S]*?if \(query && event\.target instanceof HTMLInputElement\) \{\s*setQuery\(""\);[\s\S]*?return;\s*\}\s*setOpen\(false\);/,
  );
  assert.match(listSource, /className="composer-model-search-clear"/);
  assert.match(listSource, /aria-label=\{t\("settings\.clearSearch"\)\}/);
});

test("model selection does not itself record usage", () => {
  assert.doesNotMatch(modelMenuSource, /rememberModel/);
  assert.match(modelMenuSource, /setSection\(null\)/);
});
test("switching models adopts the target default without resetting same-model overrides", () => {
  assert.match(modelMenuSource, /const selectedSameModel =\s*activeSessionId &&\s*candidate\.id === provider\?\.id &&\s*sameComposerModelId\(modelId \?\? "", nextModelId\);/);
  assert.match(
    modelMenuSource,
    /const nextThinkingLevel = selectedSameModel\s*\?\s*thinkingLevelForProvider\(nextModelProvider, thinkingLevel\)[\s\S]*?initialThinkingLevelForBinding\(\s*nextBinding,\s*nextModelProvider\?\.supportedThinkingLevels,\s*\)[\s\S]*?initialThinkingLevelForUnmatchedModel\(\s*nextBinding,\s*nextModelProvider\?\.supportedThinkingLevels,\s*\)/,
  );
});
test("the menu root carries the reasoning slider itself", () => {
  // The root view renders the slider and nothing else for the level: there is
  // no reasoning entry left to open a list of levels.
  assert.match(composerSource, /\{thinkingMenuLevels\.length > 1 \? \(/);
  assert.match(composerSource, /className="composer-thinking-slider"/);
  assert.doesNotMatch(composerSource, /showView\("thinking"\)/);
  assert.doesNotMatch(composerSource, /composer-thinking-list/);
  assert.match(sliderSource, /"--stop-count": levels\.length/);
  assert.match(composerSource, /type="range"/);
  assert.match(composerSource, /className="composer-thinking-range"/);
  assert.match(sliderSource, /aria-label=\{label\}/);
  assert.match(sliderSource, /aria-valuetext=\{levels\[index\] \?\? level\}/);
  assert.match(composerSource, /const commitThinkingLevel = /);
  // The slider is the only path that writes a level, and its write is
  // latest-wins: the queue owns the ordering.
  assert.match(composerSource, /return queue\.commit\(level\)/);
  assert.match(pickerSource, /commit=\{commitThinkingLevel\}/);
  assert.match(composerSource, /if \(SLIDER_KEYS\.has\(event\.key\)\) event\.stopPropagation\(\);/);
  assert.match(composerSource, /composer-thinking-tick/);
  assert.match(composerSource, /createLatestCommitQueue/);
  assert.match(composerSource, /thinkingQueueRef\.current\?\.invalidate\(\)/);
  assert.match(sliderSource, /tabIndex=\{-1\}/);
  assert.match(sliderSource, /className="composer-thinking-ticks" aria-hidden="true"/);
  assert.doesNotMatch(pickerSource, /composer-thinking-tick[\s\S]{0,200}role="menuitemradio"/);
  assert.match(stylesSource, /\.composer-thinking-range::-webkit-slider-runnable-track/);
  assert.match(stylesSource, /\.composer-thinking-range::-webkit-slider-thumb/);
  assert.match(stylesSource, /\.composer-thinking-range::-moz-range-thumb/);
  assert.match(stylesSource, /\.composer-thinking-tick\.active\s*\{/);
  assert.doesNotMatch(composerSource, /thinkingMode|showThinkingMode|ThinkingSelectionMode|thinkingCommitChainRef/);
});

test("the reasoning control aligns each label under its pill column", () => {
  // The labels are a full-width n-column grid inside the track; the raised
  // pill is one column wide, offset by index/n, and the range overlays the
  // track inset by half a column minus its thumb radius, so pill i, label i
  // and native stop i share one column center for every stop count.
  assert.match(sliderSource, /className="composer-thinking-rail"/);
  assert.match(sliderSource, /className="composer-thinking-ticks" aria-hidden="true"/);
  assert.doesNotMatch(sliderSource, /composer-thinking-dot/);
  assert.match(stylesSource, /--thinking-thumb-radius: 7px/);
  assert.match(stylesSource, /--thinking-inset: calc\(100% \/ \(2 \* var\(--stop-count, 1\)\) - var\(--thinking-thumb-radius\)\)/);
  assert.match(stylesSource, /\.composer-thinking-ticks \{[\s\S]*?grid-template-columns: repeat\(var\(--stop-count, 1\), minmax\(0, 1fr\)\)/);
  assert.match(stylesSource, /\.composer-thinking-range \{[\s\S]*?padding: 0 var\(--thinking-inset\)/);
  assert.match(stylesSource, /\.composer-thinking-thumb \{[\s\S]*?left: calc\(var\(--composer-thinking-progress, 0%\) \+ var\(--thinking-gutter\)\);\s*width: calc\(100% \/ var\(--stop-count, 1\) - 2 \* var\(--thinking-gutter\)\);/);
  // The pill is the shared raised surface; dragging follows the pointer
  // without easing.
  assert.match(stylesSource, /\.composer-thinking-thumb \{[\s\S]*?background: var\(--ds-raised\);\s*box-shadow: var\(--ds-raised-shadow\);/);
  assert.match(stylesSource, /\.composer-thinking-slider\[data-dragging\] \.composer-thinking-thumb \{\s*transform: none;\s*transition: none;/);
  assert.match(stylesSource, /\.composer-thinking-range::-webkit-slider-runnable-track \{\s*height: 100%;\s*background: transparent;/);
});

test("opening the combined menu preloads model metadata before its submenu", () => {
  assert.match(
    composerSource,
    /useEffect\(\(\) => \{\n    if \(!open\) return;\n    for \(const candidate of providers\)\s*\{/,
  );
  assert.match(composerSource, /void loadProviderModels\(candidate\.id\);/);
  assert.match(composerSource, /\}, \[loadProviderModels, open, providers\]\);/);
});

test("the combined chip and menu meet the compact accessible visual contract", () => {
  assert.match(composerSource, /aria-haspopup="menu"/);
  assert.match(composerSource, /aria-expanded=\{open\}/);
  assert.match(composerSource, /role="menuitemradio"/);
  assert.match(composerSource, /aria-checked=\{active\}/);
  assert.doesNotMatch(composerSource, /aria-checked=\{thinkingLevel === level\}/);
  assert.doesNotMatch(modelMenuSource, /event\.key === "ArrowLeft"/);
  assert.match(composerSource, /event\.key === "Escape"/);
  assert.match(stylesSource, /\.composer-model-thinking-menu\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(stylesSource, /\.composer-model-thinking-menu\s*\{[\s\S]*?top:\s*0;/);
  assert.match(stylesSource, /\.composer-model-thinking-menu\s*\{[\s\S]*?width:\s*min\(320px,\s*calc\(100vw - 24px\)\)/);
  // The glyph is the collapsed-only form of the trigger: at full width the
  // model name already identifies the control.
  assert.match(stylesSource, /\.composer-model-thinking-icon\s*\{[\s\S]*?display:\s*none;/);
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)/);
});

test("model options share the compact provider heading inset", () => {
  assert.match(composerSource, /composer-plus-item composer-model-option/);
  assert.match(
    stylesSource,
    /\.composer-model-group \.composer-model-option\s*\{[\s\S]*?padding-left:\s*8px/,
  );
});

test("model groups use the account-aware display name", () => {
  assert.match(composerSource, /providerDisplayName: providerDisplayName\(candidate\)/);
  assert.match(composerSource, /providerSearchText: providerSearchText\(candidate\)/);
  assert.match(composerSource, /aria-label=\{group\.providerDisplayName\}/);
  assert.match(composerSource, /\{group\.providerDisplayName\}/);
});

test("provider headings establish a stronger type level than model rows", () => {
  assert.match(
    stylesSource,
    /\.composer-model-group-label\s*\{[^}]*font-size:\s*var\(--text-xs-plus\)[^}]*font-weight:\s*var\(--font-weight-strong\)/,
  );
  assert.match(
    stylesSource,
    /\.composer-model-group \.composer-model-option\s*\{[^}]*font-size:\s*var\(--text-sm\)[^}]*font-weight:\s*var\(--font-weight-normal\)/,
  );
  assert.match(
    stylesSource,
    /:lang\(zh-CN\) \.composer-model-group-label\s*\{[\s\S]*?text-transform:\s*none/,
  );
});

test("Composer preserves aliases but never shows a catalog friendly name for an unaliased model", async () => {
  const chipSource = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  assert.match(chipSource, /composerModelDisplayName\(provider, modelId\)/);
  assert.doesNotMatch(chipSource, /composerModelDisplayName\(provider, modelId, selectedModelInfo\?\.displayName\)/);
  assert.match(listSource, /const optionTitle = model\.modelId/);
  assert.match(listSource, /sameComposerModelId\(selectedModelId \?\? "", model\.modelId\)/);
  assert.match(modelMenuSource, /modelId: nextModelId/);
  assert.match(modelMenuSource, /sameComposerModelId\(entry\.id, nextModelId\)/);
  assert.match(modelMenuSource, /sameComposerModelId\(entry\.model\.modelId, modelId \?\? ""\)/);
});

test("reasoning projection uses the selected exact catalog row and binding", async () => {
  const source = await readComposerModule("model.ts");
  assert.match(source, /sameComposerModelId\(candidate\.modelId, modelId\)/);
  assert.match(source, /sameComposerModelId\(candidate\.id, modelId\)/);
});

test("a model row stays on one line and truncates a name that outgrows it", () => {
  // The label and the row's trailing markers (provider, capability icons,
  // context window) share one line, with the markers pinned to the trailing
  // edge. The row never wraps: a name longer than the space left for it is
  // truncated with an ellipsis, and its wire id stays the row's title.
  assert.match(
    stylesSource,
    /\.composer-model-option-main\s*\{[^}]*flex-direction:\s*row;/,
  );
  assert.match(
    stylesSource,
    /\.composer-model-option-main\s*\{[^}]*flex-wrap:\s*nowrap;/,
  );
  assert.match(
    stylesSource,
    /\.composer-model-option-meta\s*\{[^}]*margin-left:\s*auto;/,
  );
  assert.match(
    stylesSource,
    /\.composer-model-label\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/,
  );
  // The provider trailing a row yields width before the model name, so a long
  // name keeps its own space on the shared line.
  assert.match(
    stylesSource,
    /\.composer-model-option-meta\s*\{[^}]*flex:\s*0 1 auto;/,
  );
  assert.doesNotMatch(stylesSource, /\.composer-model-full-id/);
  assert.doesNotMatch(stylesSource, /\.composer-model-display-name/);
});

test("an alias is told apart from the catalog name, and capabilities are icons", () => {
  // A row shows one of the two names, never both: the alias the user set wins
  // over the catalog's, and it carries its own chip so which one is on screen
  // stays visible.
  assert.match(listSource, /\?\.alias\?\.trim\(\)/);
  assert.match(listSource, /\{alias \|\| optionDisplayName\}/);
  assert.match(listSource, /composer-model-label \$\{alias \? "is-alias" : ""\}/);
  assert.match(
    stylesSource,
    /\.composer-model-label\.is-alias\s*\{[^}]*background:\s*var\(--ds-tile-deep\);/,
  );
  // Capability markers are icons whose accessible name stays the translated
  // label, because the spelled-out badges were the widest thing in a row.
  assert.match(listSource, /IconSparkles size=\{12\}/);
  assert.match(listSource, /IconEye size=\{12\}/);
  assert.match(listSource, /chat\.modelBadgeReasoning/);
  assert.match(listSource, /chat\.modelBadgeVision/);
});

test("the Composer model menu links to Models settings and closes on the way out", async () => {
  const toolbarSource = await readComposerModule("ComposerToolbar.tsx");
  // Only the Composer passes the link; a picker hosted inside Settings omits it.
  assert.match(toolbarSource, /onOpenModelSettings=\{\(\) => useAppStore\.getState\(\)\.setSettingsTab\("agent"\)\}/);
  assert.match(pickerSource, /onOpenModelSettings \? \(\) => \{\s*setOpen\(false\);\s*onOpenModelSettings\(\);\s*\} : undefined/);
  assert.match(listSource, /\{onOpenModelSettings \? \(\s*<TooltipButton[\s\S]*?className="composer-model-settings"[\s\S]*?tooltip=\{t\("chat\.manageModels"\)\}[\s\S]*?ariaLabel=\{t\("chat\.manageModels"\)\}/);
});
