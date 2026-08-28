import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const stylesSource = await loadStyles();

function pluginsSection(source) {
  const start = source.indexOf("/* ---- Plugins marketplace");
  assert.ok(start >= 0, "plugins marketplace section missing");
  return source.slice(start);
}

test("plugins page styles use design tokens in both themes", () => {
  const section = pluginsSection(stylesSource);

  // No blue-slate hardcodes / non-ds fallbacks from the old market CSS.
  for (const bad of [
    "#4f7cff",
    "#2a3144",
    "#9aa6bf",
    "#e8eefc",
    "#121826",
    "#0b1020",
    "#8df0c2",
    "var(--accent",
    "var(--text-primary",
    "var(--border-subtle",
    "var(--bg-elevated",
    "color-mix(in srgb",
  ]) {
    assert.equal(section.includes(bad), false, `leftover ${bad}`);
  }

  assert.match(section, /\.plugins-segment-btn\.active\s*\{[\s\S]*?--ds-text-primary/);
  assert.match(section, /\.plugins-header-menu\s*\{[\s\S]*?--ds-border-subtle/);
  assert.match(section, /\.plugins-search\s*\{[\s\S]*?--ds-text-primary/);
  assert.match(section, /\.plugins-modal\s*\{[\s\S]*?--ds-bg-elevated-opaque/);
  assert.match(section, /\.plugins-installed-mark\s*\{[\s\S]*?--ds-success/);
  assert.match(section, /:root\[data-theme="light"\] \.plugins-modal-backdrop/);
  assert.match(section, /\.plugins-page-header\s*\{[\s\S]*?border-bottom:\s*1px solid var\(--ds-border-subtle\)/);
  assert.match(section, /\.plugins-title-icon\s*\{[\s\S]*?--ds-border-subtle/);
  assert.match(section, /\.plugins-segment\s*\{[\s\S]*?border:\s*1px solid var\(--ds-border-default\)/);
  assert.match(section, /\.plugins-segment-btn\.active\s*\{[\s\S]*?box-shadow:\s*0 0 0 0\.5px var\(--ds-border-default\)/);

  assert.match(section, /\.plugins-title-icon\s*\{[\s\S]*?width:\s*24px[\s\S]*?height:\s*24px/);
  assert.match(section, /\.plugins-title-copy \.page-title\s*\{[\s\S]*?font-size:\s*var\(--text-lg\)[\s\S]*?font-weight:\s*var\(--font-weight-medium-plus\)/);
  assert.match(section, /\.plugins-header-actions > \.btn\s*\{[\s\S]*?min-height:\s*30px[\s\S]*?padding:\s*5px 10px/);
  assert.match(section, /\.plugins-header-menu:focus-visible\s*\{[\s\S]*?box-shadow:/);

  assert.match(
    stylesSource,
    /\.btn-primary\s*\{[\s\S]*?background:\s*var\(--ds-accent\);[\s\S]*?color:\s*var\(--ds-bg-primary\);/,
  );
  assert.match(
    stylesSource,
    /\.btn-secondary\s*\{[\s\S]*?background:\s*var\(--ds-bg-secondary\);[\s\S]*?color:\s*var\(--ds-text-primary\);[\s\S]*?--ds-border-default/,
  );
});

test("plugins page styles tier permission risk with semantic tokens", () => {
  const section = pluginsSection(stylesSource);

  assert.match(section, /\.plugins-perm-chip\.risk-high\s*\{[\s\S]*?--ds-warning/);
  assert.match(section, /\.plugins-risk-group\.risk-high\s*\{[\s\S]*?--ds-error/);
  assert.doesNotMatch(section, /\.plugins-hero|\.plugins-stat/);
  assert.match(section, /\.plugins-sheet\s*\{/);
  assert.match(section, /@media \(prefers-reduced-motion: reduce\)/);
});

// The installed list lives in .settings-panel, which clips overflow for its
// rounded corners; the row overflow menu must not be clipped with it.
test("plugins installed list lets row menus escape the panel", () => {
  const section = pluginsSection(stylesSource);

  assert.match(section, /\.plugins-list\s*\{[\s\S]*?overflow:\s*visible/);
  assert.match(section, /\.plugins-row:first-child\s*\{[\s\S]*?border-top-left-radius/);
  assert.match(section, /\.plugins-row:last-child\s*\{[\s\S]*?border-bottom-left-radius/);
  assert.match(section, /\.plugins-menu\.is-up\s*\{[\s\S]*?bottom:\s*calc\(100% \+ 5px\)/);
});

test("installed rows default to a calm summary with accessible details", () => {
  const section = pluginsSection(stylesSource);

  assert.match(section, /\.plugins-row\s*\{[\s\S]*?align-items:\s*center[\s\S]*?padding:\s*14px 16px/);
  assert.match(section, /\.plugins-row-details\s*\{/);
  assert.match(section, /\.plugins-row-details-body\s*\{[\s\S]*?box-shadow:\s*inset/);
  assert.match(section, /\.plugins-row-details-toggle:focus-visible\s*\{/);
  assert.match(section, /\.plugins-row-details\[open\] \.plugins-row-details-toggle > svg/);
});

test("installed row controls share one aligned rail and explain icon actions", () => {
  const section = pluginsSection(stylesSource);

  assert.match(section, /\.plugins-row-controls\s*\{[\s\S]*?margin-left:\s*auto/);
  assert.match(section, /\.plugins-row-actions\s*\{[\s\S]*?opacity:\s*1/);
  assert.doesNotMatch(section, /\.plugins-row:hover \.plugins-row-actions/);
  assert.match(section, /\.plugins-icon-btn\s*\{[\s\S]*?position:\s*relative/);
  assert.match(section, /\.plugins-icon-btn\[data-tip\]::after\s*\{[\s\S]*?content: attr\(data-tip\)/);
  assert.match(section, /\.plugins-icon-btn\[data-tip\]:focus-visible::after/);
});

// The 46px titlebar band floats over the destination pages on every platform: it
// is an opaque absolute .main-titlebar and a native drag rectangle, and on
// Windows/Linux the renderer-drawn window controls own the conversation pane's
// rightmost 120px. The page header lives in that band, so the frame must reserve
// it on macOS too or the title row paints underneath. The plugins page is the one
// destination page with controls in that corner (header actions, detail-sheet
// close), so both must clear the band.
test("plugins page keeps its header clear of the titlebar band on every platform", () => {
  assert.match(
    stylesSource,
    /:root\[data-platform="win32"\] \.page-frame,\s*:root\[data-platform="linux"\] \.page-frame,\s*:root\[data-platform="darwin"\] \.page-frame\s*\{[^}]*padding-top:\s*calc\(var\(--ds-toolbar-height\) \+ 8px\)/,
  );

  const section = pluginsSection(stylesSource);

  assert.match(
    section,
    /:root\[data-platform="win32"\] \.plugins-sheet,\s*:root\[data-platform="linux"\] \.plugins-sheet\s*\{[^}]*padding-top:\s*var\(--ds-toolbar-height\)/,
  );
  for (const selector of ["\\.plugins-header-actions", "\\.plugins-sheet-head"]) {
    assert.match(
      section,
      new RegExp(`${selector}\\s*\\{[^}]*-webkit-app-region:\\s*no-drag`),
      `${selector} must opt out of the titlebar drag rectangle`,
    );
  }
});
