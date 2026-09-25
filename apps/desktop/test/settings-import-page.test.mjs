/**
 * Settings ▸ Import page contract.
 *
 * Source-oriented like the neighboring settings suites: the import destination
 * is one workbench per kind (sessions, model configuration, skills, MCP), and
 * the regressions this guards are structural — four stacked scan cards coming
 * back, a hidden tab panel that the author's own `display: flex` keeps laid
 * out, rows losing their tile/typography tokens, or a kind losing the scan that
 * belongs to it.
 */
import { readSettingsSourceSync } from "./helpers/source-contracts.mjs";
import { loadStylesSync } from "./helpers/styles.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const settings = readSettingsSourceSync();
const styles = loadStylesSync();

const start = settings.indexOf(" * Settings ▸ Import.");
assert.ok(start > 0, "import page module missing from the settings domain");
const end = settings.indexOf("\n/* features/settings/", start);
const page = settings.slice(start, end === -1 ? undefined : end);

function cssRule(selector) {
  const from = styles.indexOf(`\n${selector} {`);
  assert.ok(from >= 0, `${selector} rule missing`);
  return styles.slice(from, styles.indexOf("}", from));
}

test("import is one workbench per kind instead of four stacked scan cards", () => {
  // One tab strip owns the four kinds; each kind gets one panel behind it.
  assert.match(page, /role="tablist"/);
  assert.match(page, /id: `import-tab-\$\{entry\.id\}`/);
  assert.match(page, /controls: `import-panel-\$\{entry\.id\}`/);
  assert.match(page, /aria-labelledby={`import-tab-\$\{entry\.id\}`}/);

  // One toolbar and one idle state per kind — not per section or per step.
  assert.equal((page.match(/<ImportToolbar/g) ?? []).length, 4);
  assert.equal((page.match(/<ImportIdle/g) ?? []).length, 4);

  // The retired anatomy: a lone Scan card per kind, a bare empty div, a tinted
  // group strip, and a second copy of the settings row scaffold.
  assert.doesNotMatch(page, /settings-empty/);
  assert.doesNotMatch(page, /<SettingsCard/);
  assert.doesNotMatch(page, /import-group-title/);
  assert.doesNotMatch(page, /settings-description/);
});

test("every kind keeps its own scan and its state across a tab switch", () => {
  for (const call of [
    "scanImportSessions",
    "scanImportModelConfigs",
    "scanExternalSkills",
    "scanExternalMcp",
  ]) {
    assert.match(page, new RegExp(`api\\.${call}\\(`), `${call} missing`);
  }
  // No kind may start another kind's scan.
  assert.match(page, /api\.scanImportSessions\(\)/);
  assert.match(page, /settings\.importCodexCapped/);
  assert.match(page, /api\.scanExternalMcp\(\)/);


  // Panels stay mounted and only `hidden` takes the inactive one out of view.
  assert.match(page, /hidden={kind !== entry\.id}/);
  assert.match(cssRule(".import-view[hidden]"), /display:\s*none/);
});

test("import rows are tiles with token typography and quiet group labels", () => {
  assert.match(cssRule(".import-row"), /background:\s*var\(--ds-tile\)/);
  assert.match(cssRule(".import-row:hover"), /var\(--ds-tile-hover\)/);
  assert.match(
    cssRule(".import-row:has(input:checked)"),
    /var\(--ds-tile-deep\)/,
    "selection must stay tonal",
  );
  assert.match(cssRule(".import-row-title"), /font-size:\s*var\(--text-md\)/);
  assert.match(cssRule(".import-row-meta"), /font-size:\s*var\(--text-2xs\)/);

  // The group header is a quiet label line, not a tinted 13.5px band.
  const label = cssRule(".import-group-name");
  assert.match(label, /font-size:\s*var\(--text-2xs\)/);
  assert.match(label, /text-transform:\s*uppercase/);
  assert.doesNotMatch(cssRule(".import-group-header"), /background:/);

  // Latin micro-style relaxes where CJK has no case and wide tracking.
  assert.match(styles, /:lang\(zh-CN\) \.import-group-name/);
  assert.match(styles, /:lang\(zh-TW\) \.import-group-name/);

  // The list dissolves so each row is its own tile (D297).
  const panel = cssRule(".settings-panel.import-panel");
  assert.match(panel, /background:\s*transparent/);
  assert.match(cssRule(".import-idle"), /background:\s*var\(--ds-tile\)/);
  assert.match(cssRule(".import-empty"), /background:\s*var\(--ds-tile\)/);
});

test("the toolbar is one dense row: counts left, options and actions right", () => {
  assert.match(page, /className="import-select-all"/);
  assert.match(page, /className="import-count"/);
  assert.match(page, /import-count-selected/);
  assert.match(cssRule(".import-toolbar-actions"), /margin-left:\s*auto/);
  assert.match(cssRule(".import-toolbar-actions > .btn"), /min-height:\s*28px/);
  assert.match(cssRule(".import-option-select .settings-menu-select-trigger"), /height:\s*28px/);
  // The kind options stay real menu selects, never platform-drawn selectors.
  assert.match(page, /<SettingsMenuSelect/);
  assert.doesNotMatch(page, /<select/);
});

test("every kind's group label line discloses its own rows", () => {
  // One shared hook and four kinds: a group header may not become a label with
  // no disclosure, and no kind may keep a private copy of the state.
  assert.equal((page.match(/useGroupDisclosure\(\)/g) ?? []).length, 5);
  assert.equal(
    (page.match(/onToggle=\{\(\) => disclosure\.toggle\(/g) ?? []).length,
    4,
  );
  assert.doesNotMatch(page, /onToggle=\{\(\) => undefined\}/);
  assert.doesNotMatch(page, /collapsedGroups/);
});
