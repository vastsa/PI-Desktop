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

test("Composer uses one model popover with a root and one in-place submenu", () => {
  assert.match(composerSource, /useState<ComposerMenuView>\("root"\)/);
  assert.match(composerSource, /showView\("model"\)/);
  // The reasoning level is the slider itself: no second submenu to enter.
  assert.doesNotMatch(composerSource, /showView\("thinking"\)/);
  assert.match(composerSource, /menuClassName="composer-model-menu composer-model-thinking-menu"/);
  assert.match(composerSource, /role="menuitem"[\s\S]*?aria-haspopup="menu"/);
  assert.match(composerSource, /className="composer-menu-back"/);
  assert.match(composerSource, /IconChevronLeft/);
  assert.doesNotMatch(composerSource, /className="composer-thinking"/);
  assert.doesNotMatch(composerSource, /className={`icon-btn mode-chip thinking-chip/);
});

test("model selection returns to the root without closing", () => {
  assert.match(composerSource, /await configureActiveSession\(\{[\s\S]*?thinkingLevel: nextThinkingLevel/);
  assert.match(composerSource, /setQuery\(""\);[\s\S]*?setView\("root"\)/);
  assert.match(composerSource, /const thinkingMenuLevels = sessionThinkingMenuLevels\(availableThinkingLevels\)/);
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

test("the reasoning slider aligns each track dot and label to the thumb", () => {
  // The dots row and the labels row are separate full-width n-column grids
  // keyed to --stop-count; the range input overlays the dots row at full
  // width and is inset by half a column minus the thumb radius, which moves
  // the native thumb's stops onto the same column centers for every n.
  assert.match(sliderSource, /className="composer-thinking-rail"/);
  assert.match(sliderSource, /className="composer-thinking-dots" aria-hidden="true"/);
  assert.match(sliderSource, /className="composer-thinking-ticks" aria-hidden="true"/);

  // Rail, dots and labels all key off --stop-count; the dots and labels are
  // full-width grids and the input carries the inset.
  assert.match(stylesSource, /--thinking-thumb-radius: 7px/);
  assert.match(stylesSource, /--thinking-inset: calc\(100% \/ \(2 \* var\(--stop-count, 1\)\) - var\(--thinking-thumb-radius\)\)/);
  assert.match(stylesSource, /\.composer-thinking-dots \{[\s\S]*?grid-template-columns: repeat\(var\(--stop-count, 1\), minmax\(0, 1fr\)\)/);
  assert.match(stylesSource, /\.composer-thinking-ticks \{[\s\S]*?grid-template-columns: repeat\(var\(--stop-count, 1\), minmax\(0, 1fr\)\)/);
  assert.match(stylesSource, /\.composer-thinking-range \{[\s\S]*?padding: 0 var\(--thinking-inset\)/);

  // Track dots sit on the rail (accent for the selected, muted for the rest)
  // and labels stay visible; the input's own track is transparent.
  assert.match(stylesSource, /\.composer-thinking-dot\.active/);
  assert.match(stylesSource, /\.composer-thinking-range::-webkit-slider-runnable-track \{\s*height: var\(--thinking-track-height\);\s*background: transparent;/);
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
  assert.match(composerSource, /event\.key === "ArrowLeft"/);
  assert.match(composerSource, /event\.key === "Escape"/);
  assert.match(stylesSource, /\.composer-model-thinking-menu\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(stylesSource, /\.composer-model-thinking-menu\s*\{[\s\S]*?top:\s*0;/);
  assert.match(stylesSource, /\.composer-model-thinking-menu\s*\{[\s\S]*?width:\s*min\(280px,\s*calc\(100vw - 24px\)\)/);
  assert.match(composerSource, /className="composer-model-thinking-icon"[\s\S]*?<IconBot size=\{14\} \/>/);
  assert.doesNotMatch(stylesSource, /\.composer-model-thinking-icon\.is-off/);
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

test("Composer uses alias labels while preserving the exact selected wire id", async () => {
  const chipSource = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  assert.match(chipSource, /composerModelDisplayName\(provider, modelId, selectedModelInfo\?\.displayName\)/);
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

test("a model row spends the panel's width instead of stacking at its left edge", () => {
  // The label and the capability icons share one line, with the icons pinned to
  // the trailing edge: stacking them in a column left the right half of the
  // menu empty next to every row.
  assert.match(
    stylesSource,
    /\.composer-model-option-main\s*\{[^}]*flex-direction:\s*row;/,
  );
  assert.match(
    stylesSource,
    /\.composer-model-option-main\s*\{[^}]*flex-wrap:\s*wrap;/,
  );
  assert.match(
    stylesSource,
    /\.composer-model-option-meta\s*\{[^}]*margin-left:\s*auto;/,
  );
  // One label per row, and a long name wraps in full rather than truncating.
  assert.doesNotMatch(stylesSource, /\.composer-model-full-id/);
  assert.doesNotMatch(stylesSource, /\.composer-model-display-name/);
  assert.match(
    stylesSource,
    /\.composer-model-label\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/,
  );
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
