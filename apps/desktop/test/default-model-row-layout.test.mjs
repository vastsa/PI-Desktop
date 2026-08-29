import assert from "node:assert/strict";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

/**
 * `.settings-panel` only draws the rounded frame and clips overflow, so every
 * panel body has to supply its own inset. The Defaults card regressed once
 * because `.model-default-panel` supplied none: the label and the provider name
 * were painted on the border and lost their first glyph.
 */
test("the default model row carries the settings row inset", async () => {
  const styles = await loadStyles();

  const row = styles.match(/\.model-default-row \{([^}]*)\}/);
  assert.ok(row, ".model-default-row rule is missing");
  assert.match(row[1], /padding: 14px 16px;/);

  const panel = styles.match(/\.model-default-panel \{([^}]*)\}/);
  assert.ok(panel, ".model-default-panel rule is missing");
  // The inset belongs to the rows so the picker's divider still spans the panel.
  assert.doesNotMatch(panel[1], /padding:/);
});

test("the change trigger keeps its width while the model id wraps", async () => {
  const styles = await loadStyles();

  const copy = styles.match(/\.model-default-copy \{([^}]*)\}/);
  assert.ok(copy, ".model-default-copy rule is missing");
  assert.match(copy[1], /flex: 1;/);
  assert.match(copy[1], /min-width: 0;/);

  assert.match(styles, /\.model-default-row > \.btn \{[^}]*flex: none;/);
});

test("the picker list stays inset from the panel frame", async () => {
  const styles = await loadStyles();

  const picker = styles.match(/\.model-default-picker \{([^}]*)\}/);
  assert.ok(picker, ".model-default-picker rule is missing");
  assert.match(picker[1], /padding: 8px;/);
  assert.match(picker[1], /border-top: 1px solid var\(--ds-border-subtle\);/);
});
