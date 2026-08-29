import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

/**
 * The floating model combobox was removed with the model-config redesign: the
 * catalog browser is an inline two-pane surface, so nothing has to be portalled
 * out of a dialog or repositioned on scroll.
 */
test("model picking no longer depends on a portalled floating menu", async () => {
  const browser = await read("../src/components/settings/ModelCatalogBrowser.tsx");
  const vendorDialog = await read("../src/components/settings/VendorAccountDialog.tsx");
  const styles = await loadStyles();

  assert.doesNotMatch(browser, /createPortal/);
  assert.doesNotMatch(browser, /MenuPosition/);
  assert.doesNotMatch(vendorDialog, /flowMenu/);
  assert.doesNotMatch(styles, /provider-model-combo-flow/);

  // The list is a plain in-flow scroll container instead.
  assert.match(browser, /className="model-catalog-list"/);
  assert.match(styles, /\.model-catalog-list\s*\{[\s\S]*?overflow-y: auto;/);
});
