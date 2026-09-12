import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const composerSource = await readFile(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const stylesSource = await loadStyles();

test("Composer uses one model × reasoning popover with a root and in-place submenus", () => {
  assert.match(composerSource, /useState<ComposerMenuView>\("root"\)/);
  assert.match(composerSource, /showModelThinkingView\("model"\)/);
  assert.match(composerSource, /showModelThinkingView\("thinking"\)/);
  assert.match(composerSource, /menuClassName="composer-model-menu composer-model-thinking-menu"/);
  assert.match(composerSource, /role="menuitem"[\s\S]*?aria-haspopup="menu"/);
  assert.match(composerSource, /className="composer-menu-back"/);
  assert.match(composerSource, /IconChevronLeft/);
  assert.doesNotMatch(composerSource, /className="composer-thinking"/);
  assert.doesNotMatch(composerSource, /className={`icon-btn mode-chip thinking-chip/);
});

test("model and reasoning selection return to the root without closing", () => {
  assert.match(composerSource, /await configureActiveSession\(\{[\s\S]*?thinkingLevel: nextThinkingLevel/);
  assert.match(composerSource, /setModelQuery\(""\);[\s\S]*?setModelThinkingView\("root"\)/);
  assert.match(composerSource, /const selectThinkingLevel = async/);
  assert.match(composerSource, /setModelThinkingView\("root"\);[\s\S]*?setThinkingHighlight\(-1\)/);
  assert.match(composerSource, /const thinkingMenuLevels: ThinkingLevel\[\] = availableThinkingLevels\.length/);
});

test("opening the combined menu preloads model metadata before its submenu", () => {
  assert.match(
    composerSource,
    /useEffect\(\(\) => \{\n    if \(!modelThinkingOpen\) return;\n    for \(const candidate of providers\)\s*\{/,
  );
  assert.match(composerSource, /void loadProviderModels\(candidate\.id\);/);
  assert.match(composerSource, /\}, \[loadProviderModels, modelThinkingOpen, providers\]\);/);
});

test("the combined chip and menu meet the compact accessible visual contract", () => {
  assert.match(composerSource, /aria-haspopup="menu"/);
  assert.match(composerSource, /aria-expanded=\{modelThinkingOpen\}/);
  assert.match(composerSource, /role="menuitemradio"/);
  assert.match(composerSource, /aria-checked=\{active\}/);
  assert.match(composerSource, /aria-checked=\{thinkingLevel === level\}/);
  assert.match(composerSource, /e\.key === "ArrowLeft"/);
  assert.match(composerSource, /e\.key === "Escape"/);
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
