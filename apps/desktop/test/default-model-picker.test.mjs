import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

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

test("the default summary and change action keep separate jobs", async () => {
  const styles = await loadStyles();

  const copy = styles.match(/\.model-default-copy \{([^}]*)\}/);
  assert.ok(copy, ".model-default-copy rule is missing");
  assert.match(copy[1], /flex: 1;/);
  assert.match(copy[1], /min-width: 0;/);

  const row = styles.match(/\.model-default-row \{([^}]*)\}/);
  assert.ok(row, ".model-default-row rule is missing");
  assert.match(row[1], /display: grid;/);
  assert.match(row[1], /grid-template-columns: minmax\(0, 1fr\) auto;/);

  const anchor = styles.match(/\.model-default-anchor \{([^}]*)\}/);
  assert.ok(anchor, ".model-default-anchor rule is missing");
  assert.match(anchor[1], /flex: none;/);

  const source = await read("../src/components/settings/ModelConfigPage.tsx");
  assert.match(source, /model-default-value/);
  assert.match(source, /model-default-description/);
  assert.match(source, /model-default-trigger-label/);
  assert.match(source, /defaultModelDescription/);
  assert.doesNotMatch(source, /model-default-trigger-provider/);
  assert.doesNotMatch(source, /model-default-trigger-model/);
});

/**
 * The picker used to expand inside the card, so the Defaults card grew taller
 * with every configured service. It is a bounded floating menu now.
 */
test("picking a default opens a bounded floating menu, not an inline list", async () => {
  const styles = await loadStyles();
  const source = await read("../src/components/settings/ModelConfigPage.tsx");

  assert.doesNotMatch(styles, /\.model-default-picker\b/);
  assert.doesNotMatch(source, /model-default-picker/);

  const menu = styles.match(/\.model-default-menu \{([^}]*)\}/);
  assert.ok(menu, ".model-default-menu rule is missing");
  // Fixed, because the settings panel clips its overflow.
  assert.match(menu[1], /position: fixed;/);
  assert.doesNotMatch(menu[1], /position: absolute;/);
  assert.match(menu[1], /width: min\(380px, calc\(100vw - 32px\)\);/);
  assert.match(menu[1], /max-height: min\(440px, calc\(100vh - 104px\)\);/);
  assert.match(styles, /\.model-default-results\s*\{[^}]*overflow-y: auto;/s);
  // Hidden until measured, mirroring the font picker.
  assert.match(menu[1], /visibility: hidden;/);
  assert.match(styles, /\.model-default-menu\.is-open \{[^}]*visibility: visible;/);
  /*
    z-command-palette is the design system's layer for body-portaled menus, and
    it is what the font picker uses; stacking inside the layer is DOM order, so
    the menu must not invent a higher value.
  */
  assert.match(menu[1], /z-index: 60;/);
});

test("the default picker portals out of the clipped settings panel", async () => {
  const menuSource = await read("../src/components/settings/AnchoredMenu.tsx");
  const source = await read("../src/components/settings/ModelConfigPage.tsx");

  assert.match(menuSource, /createPortal\(/);
  assert.match(menuSource, /document\.body/);
  // Escape and an outside press close it; a scrolled-away trigger closes it too.
  assert.match(menuSource, /event\.key === "Escape"/);
  assert.match(menuSource, /addEventListener\("mousedown", onPointer\)/);
  assert.match(menuSource, /addEventListener\("scroll", onViewportChange, true\)/);

  assert.match(source, /<AnchoredMenu/);
  assert.match(source, /aria-haspopup="listbox"/);
  assert.match(source, /role="option"/);
});

test("the default picker keeps keyboard focus contained", async () => {
  const menuSource = await read("../src/components/settings/AnchoredMenu.tsx");

  // Opening focuses the current option, so Enter re-confirms the default
  // instead of committing whichever service happens to be listed first.
  assert.match(menuSource, /aria-selected="true"\]:not\(\[disabled\]\)/);
  // Closing hands focus back to the trigger rather than dropping it on <body>.
  assert.match(menuSource, /triggerRef\.current\?\.focus\(\)/);
});
