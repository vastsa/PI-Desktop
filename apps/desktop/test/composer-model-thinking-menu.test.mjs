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
const composerSource = `${modelMenuSource}\n${pickerSource}\n${sliderSource}`;
const stylesSource = await loadStyles();

test("Composer uses one model × reasoning popover with a root and in-place submenus", () => {
  assert.match(composerSource, /useState<ComposerMenuView>\("root"\)/);
  assert.match(composerSource, /showView\("model"\)/);
  assert.match(composerSource, /showView\("thinking"\)/);
  assert.match(composerSource, /menuClassName="composer-model-menu composer-model-thinking-menu"/);
  assert.match(composerSource, /role="menuitem"[\s\S]*?aria-haspopup="menu"/);
  assert.match(composerSource, /className="composer-menu-back"/);
  assert.match(composerSource, /IconChevronLeft/);
  assert.doesNotMatch(composerSource, /className="composer-thinking"/);
  assert.doesNotMatch(composerSource, /className={`icon-btn mode-chip thinking-chip/);
});

test("model and reasoning selection return to the root without closing", () => {
  assert.match(composerSource, /await configureActiveSession\(\{[\s\S]*?thinkingLevel: nextThinkingLevel/);
  assert.match(composerSource, /setQuery\(""\);[\s\S]*?setView\("root"\)/);
  assert.match(composerSource, /const selectThinkingLevel = async/);
  assert.match(composerSource, /setView\("root"\);[\s\S]*?setThinkingHighlight\(-1\)/);
  assert.match(composerSource, /const thinkingMenuLevels = sessionThinkingMenuLevels\(availableThinkingLevels\)/);
});
test("the menu root carries the reasoning slider under the reasoning entry", () => {
  // The root view renders the slider directly beneath the Reasoning level
  // entry; the entry itself still opens the classic radio-list submenu.
  assert.match(composerSource, /onClick=\{\(\) => showView\("thinking"\)\}[\s\S]*?className="composer-thinking-slider"/);
  assert.match(composerSource, /\{thinkingMenuLevels\.length > 1 \? \(/);
  assert.match(composerSource, /className="composer-thinking-slider"/);
  assert.match(sliderSource, /"--stop-count": levels\.length/);
  assert.match(composerSource, /type="range"/);
  assert.match(composerSource, /className="composer-thinking-range"/);
  assert.match(sliderSource, /aria-label=\{label\}/);
  assert.match(sliderSource, /aria-valuetext=\{levels\[index\] \?\? level\}/);
  assert.match(composerSource, /const commitThinkingLevel = /);
  assert.match(composerSource, /if \(!\(await commitThinkingLevel\(level\)\)\) return;/);
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
  assert.match(composerSource, /aria-checked=\{thinkingLevel === level\}/);
  assert.match(composerSource, /event\.key === "ArrowLeft"/);
  assert.match(composerSource, /event\.key === "Escape"/);
  assert.match(stylesSource, /\.composer-model-thinking-menu\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(stylesSource, /\.composer-model-thinking-menu\s*\{[\s\S]*?top:\s*0;/);
  assert.match(stylesSource, /\.composer-model-thinking-menu\s*\{[\s\S]*?width:\s*min\(300px,\s*calc\(100vw - 24px\)\)/);
  assert.match(composerSource, /className="composer-model-thinking-icon"[\s\S]*?<IconBot size=\{14\} \/>/);
  assert.doesNotMatch(stylesSource, /\.composer-model-thinking-icon\.is-off/);
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)/);
});

test("model options are visually nested under their provider heading", () => {
  assert.match(composerSource, /composer-plus-item composer-model-option/);
  assert.match(
    stylesSource,
    /\.composer-model-group \.composer-model-option\s*\{[\s\S]*?padding-left:\s*22px/,
  );
});

test("model groups use the account-aware display name", () => {
  assert.match(composerSource, /composerProviderDisplayName\(candidate\)/);
  assert.match(composerSource, /composerProviderSearchText\(candidate\)/);
  assert.match(composerSource, /aria-label=\{group\.providerDisplayName\}/);
  assert.match(composerSource, /\{group\.providerDisplayName\}/);
});

test("provider headings establish a stronger type level than model rows", () => {
  assert.match(
    stylesSource,
    /\.composer-model-group-label\s*\{[\s\S]*?font-size:\s*var\(--text-md\)/,
  );
  assert.match(
    stylesSource,
    /\.composer-model-group \.composer-model-option\s*\{[\s\S]*?font-size:\s*var\(--text-sm\)[\s\S]*?font-weight:\s*var\(--font-weight-normal\)/,
  );
  assert.match(
    stylesSource,
    /:lang\(zh-CN\) \.composer-model-group-label\s*\{[\s\S]*?text-transform:\s*none/,
  );
});
