import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const rowSource = await readFile(
  new URL("../src/components/settings/LanguageRow.tsx", import.meta.url),
  "utf8",
);
const settingsPageSource = await readFile(
  new URL("../src/pages/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const styles = await loadStyles();

test("language picker uses an anchored menu so the settings card cannot clip it", () => {
  assert.match(rowSource, /AnchoredMenu/);
  assert.match(rowSource, /menuClassName=\"settings-language-menu\"/);
  assert.match(styles, /\.settings-language-menu\s*\{[^}]*position:\s*fixed;/s);
  assert.match(styles, /\.settings-language-menu\.is-open\s*\{/);
});

test("language options come from the shipped locale registry, not a hard-coded trio of cards", () => {
  assert.match(rowSource, /listedLocales\(\)/);
  assert.match(rowSource, /id: \"auto\"/);
  assert.match(rowSource, /saveSettings\(\{ language: id \}\)/);
  assert.match(settingsPageSource, /<LanguageRow /);
  assert.doesNotMatch(settingsPageSource, /settings-theme-card[\s\S]*lang/);
  assert.doesNotMatch(settingsPageSource, /\(\[\"auto\", \"zh-CN\", \"en\"\] as const\)/);
});

test("native language names stay in the registry rather than the catalog", () => {
  assert.match(rowSource, /locale\.nativeName/);
  assert.doesNotMatch(rowSource, /settings\.languageZh/);
  assert.doesNotMatch(rowSource, /settings\.languageEn/);
});

test("the Auto row shows the OS-detected native name", () => {
  assert.match(rowSource, /resolveAppLanguage\(\"auto\"\)/);
  assert.match(rowSource, /settings\.languageAutoDesc/);
  assert.match(rowSource, /detectedInfo\.nativeName/);
});
