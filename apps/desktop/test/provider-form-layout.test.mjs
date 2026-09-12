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

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const setupSource = await read("../src/components/settings/ProviderSetupDialog.tsx");
const headerEditorSource = await read("../src/components/settings/ProviderHeadersEditor.tsx");
const vendorDialogSource = await read("../src/components/settings/VendorAccountDialog.tsx");
// The panes themselves live in the picker both dialogs render (D269).
const pickerSource = await read("../src/components/settings/ModelSelectionPanes.tsx");
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
  // Overlay is flex: auto min-width would keep the 1040px preferred width and
  // clip the credential fields (and their 2px focus ring) on a narrower window.
  assert.match(dialog, /min-width: 0/);
  assert.match(dialog, /max-width: 100%/);
});

test("the scrolling body keeps the credential focus ring inside the dialog", () => {
  const body = block(".provider-setup-body");
  assert.match(body, /overflow-x: hidden/);
  assert.match(body, /overflow-y: auto/);
  assert.match(body, /padding: 2px/);
  const vendorBody = block(".vendor-account-body");
  assert.match(vendorBody, /overflow-x: hidden/);
  assert.match(vendorBody, /padding: 2px/);
});

test("credentials use explicit rows for predictable field alignment", () => {
  assert.match(setupSource, /className="provider-setup-credentials"/);
  assert.match(setupSource, /provider-setup-fields/);
  assert.match(setupSource, /provider-setup-service-row/);
  assert.match(setupSource, /provider-setup-custom-identity-row/);
  assert.match(setupSource, /provider-setup-custom-auth-row/);
  const fields = block(".provider-setup-fields");
  assert.ok(fields.includes("display: flex"));
  assert.ok(fields.includes("flex-direction: column"));
  const row = block(".provider-setup-field-row");
  assert.ok(row.includes("display: grid"));
  assert.ok(row.includes("grid-template-columns: repeat(2, minmax(0, 1fr))"));
  // The old single-column wrapper is gone.
  assert.doesNotMatch(setupSource, /className="provider-setup-form"/);
  assert.doesNotMatch(styles, /\.provider-setup-form\s*\{/);
});

test("custom API format sits beside the key, not in a disclosure", () => {
  assert.doesNotMatch(setupSource, /<details/);
  assert.doesNotMatch(setupSource, /provider-setup-advanced-toggle/);
  assert.match(setupSource, /provider-advanced-dialog/);
  assert.match(setupSource, /settings\.advancedSettings/);
  const fieldsBlock = setupSource.slice(
    setupSource.indexOf("provider-setup-fields"),
    setupSource.indexOf("<ModelSelectionPanes"),
  );
  assert.match(fieldsBlock, /settings\.apiStyle"/);
  assert.match(fieldsBlock, /API_STYLES\.filter/);
  assert.doesNotMatch(fieldsBlock, /settings\.apiStyleDerived/);
  assert.match(fieldsBlock, /<ServicePicker/);
  assert.match(pickerSource, /provider-chosen-advanced-toggle/);
});

test("custom Name and Base URL sit on one row without helper copy", () => {
  assert.match(setupSource, /type="url"/);
  assert.match(setupSource, /inputMode="url"/);
  assert.match(setupSource, /autoComplete="url"/);
  // Placeholder is enough; a hint under the URL would un-align the name field.
  assert.doesNotMatch(setupSource, /settings\.baseUrlHint/);
  assert.match(setupSource, /onBlur={commitBaseUrl}/);
  assert.match(setupSource, /normalizeBaseUrlInput\(resolvedBaseUrl, resolvedApiStyle\)/);
  assert.match(setupSource, /!baseUrlIssue/);
  assert.match(setupSource, /aria-invalid={Boolean\(baseUrlError\)}/);
  assert.match(setupSource, /provider-base-url-error/);

  const customIdentity = block(".provider-setup-custom-identity-row");
  assert.ok(customIdentity.includes("grid-template-columns: minmax(180px, 0.8fr)"));
  const customAuth = block(".provider-setup-custom-auth-row");
  assert.ok(customAuth.includes("grid-template-columns: minmax(0, 1.25fr)"));
  const baseUrl = block(".provider-setup-base-url");
  assert.doesNotMatch(baseUrl, /grid-column/);
  assert.match(baseUrl, /min-width: 0/);
  assert.match(styles, /\.provider-setup-base-url \.field-input\[aria-invalid="true"\]/);
  assert.match(styles, /\.provider-setup-field-error\s*\{[\s\S]*overflow-wrap: anywhere/);

  const customBlock = setupSource.slice(
    setupSource.indexOf("{custom ? ("),
    setupSource.indexOf("<ModelSelectionPanes"),
  );
  assert.ok(
    customBlock.indexOf("settings.name") < customBlock.indexOf("provider-setup-base-url"),
    "Name must precede Base URL so they occupy the same 2-column row",
  );
});

test("a failed model list uses a classified error, not a raw dump plus empty copy", () => {
  assert.match(pickerSource, /describeModelsFetchError/);
  assert.match(pickerSource, /ModelsFetchErrorMessage/);
  assert.match(pickerSource, /variant="placeholder"/);
  assert.match(pickerSource, /variant="banner"/);
  assert.match(pickerSource, /emptyFetchError/);
  assert.match(styles, /\.provider-models-placeholder\.is-error\s*\{/);
  assert.match(styles, /\.provider-models-error-summary\s*\{/);
  assert.match(styles, /\.provider-models-note\.is-error\s*\{[\s\S]*overflow-wrap: anywhere/);
});

test("list rows carry no box of their own inside the inset pane", () => {
  // Double borders were what made the dialog look coarse; D297 removed the
  // hairline between rows too — the checkbox and a 2px gap make the list.
  const row = block(".provider-models-row");
  assert.doesNotMatch(row, /border:|border-top|box-shadow/);
  assert.doesNotMatch(styles, /\.provider-models-row \+ \.provider-models-row/);
  assert.match(block(".provider-models-list"), /gap: 2px/);
  const chosen = block(".provider-chosen-row");
  assert.doesNotMatch(chosen, /border:|border-top|box-shadow/);
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

test("the discovered list header hosts a select-all checkbox beside the title", () => {
  assert.match(pickerSource, /provider-models-heading/);
  assert.match(pickerSource, /provider-models-select-all/);
  const heading = block(".provider-models-heading");
  assert.match(heading, /display: flex/);
  assert.match(heading, /align-items: center/);
  assert.doesNotMatch(heading, /border:|box-shadow/);
  const selectAll = block(".provider-models-select-all");
  assert.match(selectAll, /flex: none/);
});

test("the discovered list header hosts a compact fetch-list action beside the title", () => {
  assert.match(pickerSource, /provider-models-reload/);
  assert.match(pickerSource, /settings\.fetchModelList/);
  const reload = block(".provider-models-reload");
  assert.match(reload, /display: inline-flex/);
  assert.match(reload, /min-height: 24px/);
  assert.match(reload, /background: var\(--ds-bg-chip\)/);
  assert.match(reload, /border: 0/);
  assert.doesNotMatch(reload, /box-shadow/);
  assert.doesNotMatch(styles, /\.provider-models-state\s*\{/);
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
  assert.match(pickerSource, /className="provider-setup-panes"/);
  const panes = block(".provider-setup-panes");
  assert.match(panes, /display: grid/);
  assert.match(panes, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(panes, /min-height: 0/);
  // The available list must come before the chosen list in reading order.
  assert.ok(
    pickerSource.indexOf('className="provider-models"') <
      pickerSource.indexOf('className="provider-chosen"'),
    "the credential's list should precede the chosen list",
  );
});

test("each pane is a self-contained panel that scrolls its own list", () => {
  for (const selector of [".provider-models", ".provider-chosen"]) {
    const pane = block(selector);
    assert.match(pane, /min-height: 0/);
    // D297: the inset tone is the pane's edge; no stroke of any kind.
    assert.doesNotMatch(pane, /border:|border-top|box-shadow/);
    assert.match(pane, /border-radius: var\(--radius-sm\)/);
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
  // D297: spacing, not a rule, sets it off from the list above.
  assert.match(custom, /margin-top: 2px/);
  assert.doesNotMatch(custom, /border-top/);
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
  assert.match(query, /\.provider-setup-field-row[\s\S]*?\{\s*grid-template-columns: minmax\(0, 1fr\)/);
  // The explicit custom rows must also collapse or Name | URL and Key | Format
  // stay side-by-side on a stacked dialog.
  assert.match(query, /\.provider-setup-custom-identity-row/);
  assert.match(query, /\.provider-setup-custom-auth-row/);
  // A stacked dialog must be allowed to size to its content again, and both
  // dialogs host the same panes, so both need that release.
  assert.match(
    query,
    /\.provider-setup-dialog,\s*\n\s*\.vendor-account-dialog\s*\{[\s\S]*?height: auto/,
  );
});

test("Advanced opens from the dialog header into a separate modal", () => {
  assert.match(setupSource, /ProviderHeadersEditor/);
  assert.match(vendorDialogSource, /ProviderHeadersEditor/);
  assert.match(setupSource, /provider-setup-head-actions/);
  assert.match(vendorDialogSource, /vendor-account-head/);
  assert.match(setupSource, /settings\.advancedSettings/);
  assert.match(vendorDialogSource, /settings\.advancedSettings/);
  assert.match(setupSource, /provider-advanced-dialog/);
  assert.match(vendorDialogSource, /provider-advanced-dialog/);
  assert.doesNotMatch(setupSource, /provider-advanced-actions/);
  assert.doesNotMatch(vendorDialogSource, /provider-advanced-actions/);
  assert.doesNotMatch(setupSource, /provider-setup-advanced-toggle/);
  assert.doesNotMatch(vendorDialogSource, /provider-setup-advanced-toggle/);
  assert.match(setupSource, /if \(advancedOpen\)/);
  assert.match(vendorDialogSource, /if \(advancedOpen\)/);
  const modal = block(".provider-advanced-dialog");
  assert.ok(modal.includes("width: min(560px, calc(100vw - 48px))"));
  assert.ok(modal.includes("max-height: min(560px, calc(100vh - 64px))"));
  const modalBody = block(".provider-advanced-body");
  assert.match(modalBody, /overflow-y: auto/);
});

test("Advanced offers presets plus JSON import and copy without redundant helper rows", () => {
  assert.match(setupSource, /ProviderHeadersEditor/);
  assert.match(vendorDialogSource, /ProviderHeadersEditor/);
  assert.match(headerEditorSource, /HEADER_PRESETS/);
  assert.match(headerEditorSource, /User-Agent/);
  assert.match(headerEditorSource, /importJson/);
  assert.match(headerEditorSource, /JSON\.parse/);
  assert.match(headerEditorSource, /file\.text\(\)/);
  assert.match(headerEditorSource, /accept="application\/json,\.json"/);
  // Copy serializes the same normalized record used when headers are persisted,
  // rather than exposing blank or duplicate editor rows.
  assert.match(headerEditorSource, /pairsToRecord/);
  assert.match(headerEditorSource, /JSON\.stringify\(pairsToRecord\(pairs\), null, 2\)/);
  assert.match(headerEditorSource, /navigator\.clipboard\.writeText/);
  assert.match(headerEditorSource, /setCopied\(true\)/);
  assert.match(headerEditorSource, /settings\.copyHeadersJson/);
  assert.match(headerEditorSource, /settings\.headersJsonCopied/);
  assert.match(headerEditorSource, /provider-setup-header-copy/);
  assert.match(styles, /\.provider-setup-header-copy\.is-copied/);
  assert.match(block(".provider-setup-headers-actions"), /flex-wrap: wrap/);
  assert.doesNotMatch(headerEditorSource, /provider-setup-headers-hint/);
  const advanced = block(".provider-setup-advanced");
  assert.match(advanced, /flex-direction: column/);
  assert.match(advanced, /min-height: 0/);
  assert.doesNotMatch(advanced, /grid-template-columns: repeat\(2/);
  assert.match(block(".provider-setup-headers"), /flex-direction: column/);
  const toolbar = block(".provider-setup-headers-toolbar");
  assert.match(toolbar, /display: flex/);
  const headersViewport = block(".provider-setup-header-list");
  assert.match(headersViewport, /max-height: min\(220px, 30vh\)/);
  assert.match(headersViewport, /overflow-y: auto/);
  assert.match(headersViewport, /overscroll-behavior: contain/);
  // Named and custom both expose Advanced; API format stays beside the key.
  const fieldsBlock = setupSource.slice(
    setupSource.indexOf("provider-setup-fields"),
    setupSource.indexOf("<ModelSelectionPanes"),
  );
  assert.match(setupSource, /named \|\| custom/);
  assert.match(fieldsBlock, /settings\.apiStyle"/);
});

test("the vendor account dialog hosts the same panes in the same shell", () => {
  // It renders the shared picker (D269), so it needs the provider dialog's box
  // rather than the narrower stacked one it used while it had its own copy.
  const dialog = block(".vendor-account-dialog");
  assert.match(dialog, /width: min\(1040px, calc\(100vw - 48px\)\)/);
  assert.match(dialog, /max-width: 100%/);
  assert.match(dialog, /min-width: 0/);
  assert.match(dialog, /height: min\(720px, calc\(100vh - 64px\)\)/);
  assert.match(vendorDialogSource, /<ModelSelectionPanes/);
  // The duplicated chosen-pane and custom-model rules are retired with it.
  assert.doesNotMatch(styles, /\.vendor-account-chosen/);
  assert.doesNotMatch(styles, /\.vendor-account-custom-model/);
});
