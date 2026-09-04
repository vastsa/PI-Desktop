import assert from "node:assert/strict";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const stylesSource = await loadStyles();

function styleBlock(selector) {
  return stylesSource.match(new RegExp(`(?:^|\\n)${selector} \\{[^}]*\\}`))?.[0] ?? "";
}

test("shell titlebar surfaces share the toolbar metric and borderless surface", () => {
  for (const selector of [
    "\\.main-titlebar",
    "\\.conversation-topbar",
    "\\.settings-titlebar",
  ]) {
    const block = styleBlock(selector);
    assert.match(block, /height:\s*var\(--ds-toolbar-height\);/);
    assert.match(block, /background:\s*var\(--ds-bg-primary\);/);
    assert.match(block, /border-bottom:\s*0;/);
  }
});

test("window chrome reserves the same titlebar height and native control band", () => {
  const controls = styleBlock("\\.window-controls");
  assert.match(controls, /height:\s*var\(--ds-toolbar-height\);/);
  assert.match(controls, /width:\s*var\(--ds-window-controls-width\);/);
  assert.match(stylesSource, /--ds-window-controls-width:\s*120px;/);
  assert.match(stylesSource, /--ds-toolbar-height:\s*46px;/);
});

test("window control band draws no boundary of its own", () => {
  // D297: the band paints the titlebar tone and nothing else; no side seam.
  const controls = styleBlock("\\.window-controls");
  assert.doesNotMatch(controls, /border-bottom:/);
  assert.doesNotMatch(controls, /border-left/);
  assert.match(controls, /background:\s*var\(--ds-bg-primary\);/);
});

test("sidebar and work-panel headers use the shared toolbar metric", () => {
  assert.match(styleBlock("\\.sidebar-header"), /height:\s*var\(--ds-toolbar-height\);/);
  assert.match(styleBlock("\\.sidebar-header"), /flex:\s*0 0 var\(--ds-toolbar-height\);/);
  assert.match(styleBlock("\\.work-panel-header"), /height:\s*var\(--ds-toolbar-height\);/);
  assert.match(
    styleBlock("\\.settings-content"),
    /padding:\s*calc\(var\(--ds-toolbar-height\) \+ 8px\) 48px 56px 40px;/,
  );
});
