import { readAppSource, readSettingsSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const rowSource = await readFile(
  new URL("../src/components/settings/FontSizeRow.tsx", import.meta.url),
  "utf8",
);
const appSource = await readAppSource();
const settingsPageSource = await readSettingsSource();
const tokensSource = await readFile(
  new URL("../src/styles/tokens.css", import.meta.url),
  "utf8",
);
const styles = await loadStyles();

test("Appearance card renders a font-size row after the font family picker", () => {
  const generalStart = settingsPageSource.indexOf(
    '{tab === "general" && settings && (',
  );
  const aiStart = settingsPageSource.indexOf('{tab === "ai" && settings && (');
  const generalSource = settingsPageSource.slice(generalStart, aiStart);
  const fontFamily = generalSource.indexOf("<FontFamilyRow ");
  const fontSize = generalSource.indexOf("<FontSizeRow ");
  assert.ok(fontFamily >= 0);
  assert.ok(fontSize > fontFamily);
});

test("presets and the scale slider persist AppSettings.fontScale", () => {
  assert.match(rowSource, /saveSettings\(\{ fontScale: scale \}\)/);
  assert.match(rowSource, /FONT_SCALE_PRESETS/);
  assert.match(rowSource, /type="range"/);
  assert.match(rowSource, /settings\.fontSizeSmall/);
  assert.match(rowSource, /settings\.fontSizeDefault/);
  assert.match(rowSource, /settings\.fontSizeLarge/);
  assert.match(rowSource, /settings\.fontSizeXl/);
  assert.doesNotMatch(rowSource, /px/);
});

test("the renderer applies a global type scale without a reload", () => {
  assert.match(appSource, /resolveFontScale\(settings/);
  assert.match(appSource, /"--font-scale"/);
  assert.match(tokensSource, /--font-scale:\s*1;/);
  assert.match(tokensSource, /--text-base:\s*calc\(14px \* var\(--font-scale\)\);/);
  assert.doesNotMatch(tokensSource, /--reading-font-size/);
  assert.doesNotMatch(tokensSource, /\.thread-wrap,\s*\n\.composer-dock \{/);
});

test("shared Lucide icons follow --font-scale", async () => {
  const iconsSource = await readFile(
    new URL("../src/components/icons.tsx", import.meta.url),
    "utf8",
  );
  assert.match(iconsSource, /function scaledIconBox\(/);
  assert.match(
    iconsSource,
    /calc\(\$\{size\}px \* var\(--font-scale\)\)/,
  );
  assert.match(iconsSource, /style=\{withScaledIconStyle\(size, style\)\}/);
});

test("font-size control stacks presets and a percentage slider", () => {
  assert.match(styles, /\.settings-font-size\s*\{[^}]*flex-direction:\s*column;/s);
  assert.match(styles, /\.settings-font-size-slider\s*\{/);
  assert.match(styles, /\.settings-font-size-percent\s*\{[^}]*font-size:\s*var\(--text-sm\);/s);
  assert.doesNotMatch(styles, /\.settings-font-size-custom\s*\{/);
});

test("cup-size preset labels stay on one line", () => {
  assert.match(
    styles,
    /\.settings-font-size \.settings-segment-item\s*\{[^}]*white-space:\s*nowrap;/s,
  );
  assert.match(
    styles,
    /\.settings-row:has\(\.settings-font-size\) \.settings-row-control\s*\{[^}]*max-width:\s*none;/s,
  );
});
