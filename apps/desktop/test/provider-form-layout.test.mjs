/**
 * Layout contract for the provider setup dialog.
 *
 * The first single-form version stacked credentials, the discovered models, the
 * chosen models and the custom-model row into one tall column, which read as an
 * undifferentiated list. These assertions pin the two-pane arrangement that
 * replaced it: credentials as one compact band, then picking on the left and
 * reviewing on the right, each scrolling inside a fixed-height dialog.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const setupSource = await readFile(
  new URL("../src/components/settings/ProviderSetupDialog.tsx", import.meta.url),
  "utf8",
);
const styles = await loadStyles();

/** Declaration block for exactly one selector, so matches cannot span rules. */
function block(selector) {
  const at = styles.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `${selector} is not defined`);
  return styles.slice(at, styles.indexOf("}", at));
}

test("the dialog is a fixed-height shell so it cannot grow with the model count", () => {
  const dialog = block(".provider-setup-dialog");
  assert.match(dialog, /height: min\(720px, calc\(100vh - 64px\)\)/);
  assert.match(dialog, /width: min\(1040px, calc\(100vw - 48px\)\)/);
});

test("credentials are a 2x2 grid of four peer fields", () => {
  assert.match(setupSource, /className="provider-setup-credentials"/);
  assert.match(setupSource, /className="provider-setup-fields"/);
  const fields = block(".provider-setup-fields");
  assert.match(fields, /display: grid/);
  assert.match(fields, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  // The old single-column wrapper is gone.
  assert.doesNotMatch(setupSource, /className="provider-setup-form"/);
  assert.doesNotMatch(styles, /\.provider-setup-form\s*\{/);
});

test("the API format is the fourth field, not a disclosure of its own", () => {
  // One select did not justify a whole collapsible section.
  assert.doesNotMatch(setupSource, /<details/);
  assert.doesNotMatch(setupSource, /provider-advanced/);
  assert.doesNotMatch(setupSource, /advancedOpen/);
  const fieldsBlock = setupSource.slice(
    setupSource.indexOf('className="provider-setup-fields"'),
    setupSource.indexOf('className="provider-setup-panes"'),
  );
  assert.match(fieldsBlock, /settings\.apiStyle"/);
  assert.match(fieldsBlock, /settings\.apiStyleDerived/);
  assert.match(fieldsBlock, /API_STYLES\.map/);
  // The per-model Advanced disclosure is a different control and stays.
  assert.match(setupSource, /provider-chosen-advanced-toggle/);
});

test("list rows carry no box of their own inside a bordered pane", () => {
  // Double borders were what made the dialog look coarse.
  const row = block(".provider-models-row");
  assert.doesNotMatch(row, /border: 1px solid/);
  assert.match(styles, /\.provider-models-row \+ \.provider-models-row\s*\{\s*border-top: 1px solid/);
  const chosen = block(".provider-chosen-row");
  assert.doesNotMatch(chosen, /border: 1px solid/);
  // The panes themselves read as wells, not as raised cards.
  for (const selector of [".provider-models", ".provider-chosen"]) {
    assert.match(block(selector), /background: var\(--ds-bg-inset\)/);
  }
});

test("pane titles are section labels, not competing headings", () => {
  for (const selector of [".provider-models-title", ".provider-chosen-title"]) {
    const title = block(selector);
    assert.match(title, /font-size: var\(--text-2xs\)/);
    assert.match(title, /text-transform: uppercase/);
    assert.match(title, /color: var\(--ds-text-secondary\)/);
  }
  // The dialog title stays the one prominent heading.
  assert.match(block(".provider-setup-title"), /font-size: var\(--text-base-plus\)/);
});

test("the dialog's actions live in the header, not in a footer bar", () => {
  assert.match(setupSource, /className="provider-setup-head-actions"/);
  // The bare X is replaced by a labelled Cancel.
  assert.doesNotMatch(setupSource, /className="provider-setup-close"/);
  assert.doesNotMatch(styles, /\.provider-setup-close\b/);
  assert.doesNotMatch(setupSource, /className="provider-setup-actions"/);
  assert.doesNotMatch(styles, /\.provider-setup-actions\b/);

  const head = setupSource.slice(
    setupSource.indexOf('className="provider-setup-head-actions"'),
    setupSource.indexOf('className="provider-setup-body"'),
  );
  // Test connection only applies to a provider that already exists.
  assert.match(head, /provider \? \(/);
  assert.match(head, /settings\.testConnection/);
  assert.match(head, /settings\.cancel/);
  assert.match(head, /settings\.saveProvider/);
  // Cancel precedes Save, so the corner-most control is not the destructive one.
  assert.ok(
    head.indexOf('settings.cancel') < head.indexOf('settings.saveProvider'),
    "Cancel should sit before Save in the header group",
  );
  // Save stays gated on a valid form.
  assert.match(head, /disabled=\{!canSave\}/);
});

test("the connection test reports its result next to the fields", () => {
  // The button moved to the header; its outcome stays where the inputs are.
  const body = setupSource.slice(setupSource.indexOf('className="provider-setup-body"'));
  assert.match(body, /provider-credential-test-result/);
  assert.doesNotMatch(body, /settings\.testConnection/);
});

test("a save error appears next to the fields it refers to", () => {
  const bodyStart = setupSource.indexOf('className="provider-setup-body"');
  const credentials = setupSource.indexOf('className="provider-setup-credentials"');
  const errorLine = setupSource.indexOf('className="provider-setup-error"');
  assert.ok(errorLine > bodyStart && errorLine < credentials,
    "the error line should open the body, above the credential grid");
});

test("picking and reviewing models are two side-by-side panes", () => {
  assert.match(setupSource, /className="provider-setup-panes"/);
  const panes = block(".provider-setup-panes");
  assert.match(panes, /display: grid/);
  assert.match(panes, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(panes, /min-height: 0/);
  // The available list must come before the chosen list in reading order.
  assert.ok(
    setupSource.indexOf('className="provider-models"') <
      setupSource.indexOf('className="provider-chosen"'),
    "the service's list should precede the chosen list",
  );
});

test("each pane is a self-contained panel that scrolls its own list", () => {
  for (const selector of [".provider-models", ".provider-chosen"]) {
    const pane = block(selector);
    assert.match(pane, /min-height: 0/);
    assert.match(pane, /border: 1px solid var\(--ds-border-subtle\)/);
    assert.match(pane, /border-radius: var\(--radius-sm\)/);
    // The divider that separated the old stacked sections would now cut across
    // the grid, so it must be gone.
    assert.doesNotMatch(pane, /border-top: 1px solid/);
  }
  for (const selector of [".provider-models-list", ".provider-chosen-list"]) {
    const list = block(selector);
    assert.match(list, /flex: 1/);
    assert.match(list, /min-height: 0/);
    assert.match(list, /overflow-y: auto/);
    assert.match(list, /overscroll-behavior: contain/);
    // Filling the pane replaces the old fixed pixel cap.
    assert.doesNotMatch(list, /max-height/);
  }
});

test("the custom-model row stays pinned under the chosen list", () => {
  const custom = block(".provider-custom-model");
  assert.match(custom, /flex: none/);
  assert.match(custom, /border-top: 1px solid var\(--ds-border-subtle\)/);
});

test("empty panes hold their height instead of collapsing", () => {
  for (const selector of [".provider-models-placeholder", ".provider-chosen-empty"]) {
    const empty = block(selector);
    assert.match(empty, /flex: 1/);
    assert.match(empty, /align-items: center/);
  }
});

test("the panes stack again before the dialog gets too narrow to read", () => {
  const at = styles.indexOf("@media (max-width: 940px)");
  assert.notEqual(at, -1, "missing the two-pane fallback breakpoint");
  const query = styles.slice(at, styles.indexOf("@media", at + 10));
  assert.match(query, /\.provider-setup-panes\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(query, /\.provider-setup-fields\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
  // A stacked dialog must be allowed to size to its content again.
  assert.match(query, /\.provider-setup-dialog\s*\{[\s\S]*?height: auto/);
});

test("the vendor account dialog keeps its stacked treatment", () => {
  // It has no discovery pane to pair with, so it must not lose its divider to
  // the two-pane rules the provider dialog needs.
  const chosen = block(".vendor-account-chosen");
  assert.match(chosen, /border-top: 1px solid var\(--ds-border-subtle\)/);
  const list = block(".vendor-account-chosen-list");
  assert.match(list, /max-height: min\(240px, 30vh\)/);
});
