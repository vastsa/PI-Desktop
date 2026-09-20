import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const source = (path) =>
  readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

const ui = await source("components/ui.tsx");
const primitives = await source("features/settings/primitives.tsx");
const settingsPage = await source("features/settings/SettingsPage.tsx");
const importPage = await source("features/settings/import-page.tsx");
const networkProxy = await source("components/settings/NetworkProxySection.tsx");
const styles = await loadStyles();

/** One rule body out of the composed stylesheet, by exact selector. */
function cssRule(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing CSS rule ${selector}`);
  return styles.slice(start, styles.indexOf("}", start));
}

/*
  A settings page is a list of decisions. Explanatory prose used to sit in a
  permanent second line under every title, which buried the decisions it was
  explaining; it now lives behind a question mark and shows up on hover or
  focus (D601).
*/
test("a settings row explains itself from a help icon, not a second line", () => {
  // The copy travels as a string, because that is what a tooltip can carry.
  assert.match(
    primitives,
    /\/\*\* Explanatory copy, revealed on demand from the help icon\. \*\/\n {2}description\?: string;/,
  );
  assert.match(primitives, /\{description \? <HelpIcon label=\{description\} \/> : null\}/);
  // A card heading follows the same rule as a row.
  assert.match(primitives, /export function SettingsCard\(\{/);
  assert.match(primitives, /\n {2}description\?: string;\n/);
  // The retired always-on line must not come back through the renderers.
  assert.doesNotMatch(primitives, /settings-row-desc">\{description\}/);
  // The heading's mark is a sibling, not a child: a nested button joins the
  // heading's accessible name, and a screen reader's heading list would then
  // read out the explanation instead of the title.
  assert.match(primitives, /<div className="settings-card-heading-help">/);
  assert.match(
    primitives,
    /<h3 className="settings-card-heading">\{title\}<\/h3>/,
  );
});

test("the help icon is a focusable button whose name is the sentence", () => {
  const start = ui.indexOf("export function HelpIcon(");
  assert.ok(start >= 0, "ui.tsx should export HelpIcon");
  const helpIcon = ui.slice(start, ui.indexOf("export function Button(", start));
  assert.match(helpIcon, /<TooltipButton/);
  assert.match(helpIcon, /className=\{cx\("ui-help-icon", className\)\}/);
  assert.match(helpIcon, /tooltip=\{label\}/);
  assert.match(helpIcon, /tooltipClassName="ui-tooltip-help"/);
  assert.match(helpIcon, /ariaLabel=\{label\}/);
  assert.match(helpIcon, /<IconHelp size=\{13\} \/>/);
});

test("the help tooltip wraps instead of running off its anchor", () => {
  const tooltip = cssRule(".ui-tooltip-help");
  assert.match(tooltip, /white-space:\s*normal/);
  assert.match(tooltip, /overflow-wrap:\s*anywhere/);

  const icon = cssRule(".ui-help-icon");
  assert.match(icon, /cursor:\s*help/);
  assert.match(icon, /color:\s*var\(--ds-text-muted\)/);
  // Hover and focus share one selector group, so the rule starts at the
  // first of them rather than at a selector of its own.
  const hover = styles.slice(styles.indexOf(".ui-help-icon:hover"));
  assert.ok(hover.length > 0, "missing the .ui-help-icon hover state");
  assert.match(
    hover.slice(0, hover.indexOf("}")),
    /color:\s*var\(--ds-text-secondary\)/,
  );
});

test("the row explanations survive the move into the tooltip", () => {
  for (const key of [
    "settings.permissionModeDesc",
    "settings.modeDesc",
    "settings.enterToSendDesc",
    "settings.feedbackDesc",
  ]) {
    assert.match(
      settingsPage,
      new RegExp(`description=\\{t\\("${key.replace(/\./g, "\\.")}"\\)\\}`),
      `${key} should still be the row's explanation`,
    );
  }
  assert.match(
    primitives,
    /description=\{t\("settings\.largePasteThresholdDesc"\)\}/,
  );
});

test("one settings row renderer owns the layout", () => {
  // The proxy section used to carry its own copy of the row skeleton, which
  // would have kept the retired second line alive.
  assert.doesNotMatch(networkProxy, /function SettingsRow\(/);
  assert.match(
    networkProxy,
    /import \{ SettingsRow \} from "\.\.\/\.\.\/features\/settings\/primitives";/,
  );
});

test("an import hint is reachable from the control it explains", () => {
  // The standalone hint line is gone; the toolbar and its option carry it.
  assert.doesNotMatch(importPage, /className="import-hint"/);
  assert.match(importPage, /hint\?: string;/);
  assert.match(importPage, /hint=\{t\("settings\.importAgentScanModeHint"\)\}/);
  assert.match(importPage, /hint=\{\n\s+codexCap != null/);
  assert.match(importPage, /\{hint \? <HelpIcon label=\{hint\} \/> : null\}/);
  assert.match(importPage, /\{help \? <HelpIcon label=\{help\} \/> : null\}/);
  // A hint rides beside the controls, so the toolbar must still render them:
  // a half-migrated prop list silently dropped the grouping and mode pickers
  // once already, and no source-level assertion caught it.
  assert.match(importPage, /\{options\}\n\s+\{hint \? <HelpIcon/);
});
