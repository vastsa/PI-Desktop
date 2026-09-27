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
  assert.match(section, /\.plugins-header-menu\s*\{[^}]*background:\s*var\(--plugins-tile\)/);
  assert.match(section, /\.plugins-search\s*\{[\s\S]*?--ds-text-primary/);
  assert.match(section, /\.plugins-modal\s*\{[\s\S]*?--ds-bg-elevated-opaque/);
  assert.match(section, /\.plugins-installed-mark\s*\{[\s\S]*?--ds-success/);
  assert.match(section, /:root\[data-theme="light"\] \.plugins-modal-backdrop/);
  // D296: the header, title glyph and segmented control carry tone, not rules.
  assert.doesNotMatch(section, /\.plugins-page-header\s*\{[^}]*border-bottom/);
  assert.match(section, /\.plugins-title-icon\s*\{[^}]*background:\s*var\(--plugins-tile-deep\)/);
  assert.doesNotMatch(section, /\.plugins-title-icon\s*\{[^}]*border:/);
  assert.match(section, /\.plugins-segment\s*\{[^}]*border-radius:\s*var\(--radius-full\)/);
  assert.doesNotMatch(section, /\.plugins-segment\s*\{[^}]*(border:|box-shadow:)/);
  assert.match(section, /\.plugins-segment-btn\.active\s*\{[^}]*box-shadow:\s*var\(--plugins-raised-shadow\)/);

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

// D296: installed rows are separate soft tiles stacked with a gap, not one
// hairline-separated panel. Nothing clips, so the row overflow menu can overhang
// the tile below, and rows near the viewport bottom still open upwards.
test("plugins installed rows are stacked tiles that let row menus overhang", () => {
  const section = pluginsSection(stylesSource);

  assert.match(section, /\.plugins-list\s*\{[^}]*display:\s*flex[^}]*gap:\s*6px/);
  assert.doesNotMatch(section, /\.plugins-list\s*\{[^}]*overflow:\s*hidden/);
  assert.match(section, /\.plugins-row\s*\{[^}]*border-radius:\s*var\(--radius-md-plus\)[^}]*background:\s*var\(--plugins-tile\)/);
  assert.doesNotMatch(section, /\.plugins-row \+ \.plugins-row/);
  assert.doesNotMatch(section, /\.plugins-row:(first|last)-child/);
  assert.match(section, /\.plugins-menu\.is-up\s*\{[\s\S]*?bottom:\s*calc\(100% \+ 5px\)/);
});

// D296: the whole page is divider-free. In-flow rules — border-top/bottom,
// inset hairline rings — are gone from plugins.css; the only stroke left is the
// tooltip's, a floating layer. Menu groups are separated by space, not a line.
test("extensions page draws no in-flow dividers", async () => {
  const pluginsCss = await readFile(new URL("../src/styles/plugins.css", import.meta.url), "utf8");

  assert.doesNotMatch(pluginsCss, /border-(top|bottom):\s*1px/);
  assert.doesNotMatch(pluginsCss, /inset 0 0 0 0\.5px/);
  const strokes = pluginsCss.match(/^\s*border:\s*1px solid/gm) ?? [];
  assert.equal(strokes.length, 1, "only the tooltip keeps a 1px stroke");
  assert.match(pluginsCss, /\.plugins-icon-btn\[data-tip\]::after\s*\{[^}]*border:\s*1px solid/);
  assert.match(pluginsCss, /\.plugins-menu-sep\s*\{[^}]*height:\s*6px/);
  assert.doesNotMatch(pluginsCss, /\.plugins-menu-sep\s*\{[^}]*background/);
  assert.match(pluginsCss, /\.plugins-sheet-cta\s*\{[^}]*border-radius/);
  assert.doesNotMatch(pluginsCss, /\.plugins-sheet-section\s*\{[^}]*border/);
  assert.match(pluginsCss, /\.plugins-card-foot\s*\{[^}]*padding:\s*2px 14px 12px/);
  assert.doesNotMatch(pluginsCss, /\.plugins-card-foot\s*\{[^}]*border/);
  assert.match(pluginsCss, /\.plugins-empty\s*\{[^}]*background:\s*var\(--plugins-tile\)/);
  assert.match(pluginsCss, /\.plugins-market-settings\s*\{[^}]*background:\s*var\(--plugins-tile\)/);
});

test("installed rows default to a calm summary with accessible details", () => {
  const section = pluginsSection(stylesSource);

  assert.match(section, /\.plugins-row\s*\{[^}]*align-items:\s*center[^}]*padding:\s*13px 16px/);
  assert.match(section, /\.plugins-row-details\s*\{/);
  assert.match(section, /\.plugins-row-details-body\s*\{[^}]*background:\s*var\(--plugins-raised\)[^}]*box-shadow:\s*var\(--plugins-raised-shadow\)/);
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
// close), so both must clear the band. The sheet's fixed layer stacks inside the
// route surface (its entry animation leaves a transform behind), so the band
// paints over the sheet on every platform and the sheet reserves it everywhere.
test("plugins page keeps its header clear of the titlebar band on every platform", () => {
  assert.match(
    stylesSource,
    /:root\[data-platform="win32"\] \.page-frame,\s*:root\[data-platform="linux"\] \.page-frame,\s*:root\[data-platform="darwin"\] \.page-frame\s*\{[^}]*padding-top:\s*calc\(var\(--ds-toolbar-height\) \+ 8px\)/,
  );

  const section = pluginsSection(stylesSource);

  assert.match(section, /\.plugins-sheet\s*\{[^}]*padding-top:\s*var\(--ds-toolbar-height\)/);
  for (const selector of ["\\.plugins-header-actions", "\\.plugins-sheet-head"]) {
    assert.match(
      section,
      new RegExp(`${selector}\\s*\\{[^}]*-webkit-app-region:\\s*no-drag`),
      `${selector} must opt out of the titlebar drag rectangle`,
    );
  }
});
