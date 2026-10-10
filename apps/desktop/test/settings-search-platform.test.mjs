/**
 * Platform-only settings rows are searchable only where they render.
 * Global search shares `searchSettings` with the settings rail keywords.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { en } = await import("../../../packages/i18n/src/locales/en/index.ts");
const { zhCN } = await import("../../../packages/i18n/src/locales/zh-CN/index.ts");
const { searchSettings } = await import("../src/lib/settings-search.ts");

const TITLE_KEY = "settings.macosSidebarVibrancy";
const DESC_KEY = "settings.macosSidebarVibrancyDesc";
const THEME_KEY = "settings.theme";

function translator(locale) {
  const catalog = locale === "en" ? en : zhCN;
  return (key) => {
    const value = key.split(".").reduce((current, part) => current?.[part], catalog);
    if (typeof value !== "string") {
      throw new Error(`missing ${locale} catalog string: ${key}`);
    }
    return value;
  };
}

function vibrancyHit(hits, rowKey) {
  return hits.find((hit) => hit.tab === "general" && hit.rowKey === rowKey);
}

test("macOS settings search matches the translucent sidebar title and description", () => {
  for (const locale of ["en", "zh-CN"]) {
    const t = translator(locale);
    const title = t(TITLE_KEY);
    const description = t(DESC_KEY);

    const titleHits = searchSettings(title, t, { platform: "darwin" });
    const descHits = searchSettings(description, t, { platform: "darwin" });
    assert.ok(vibrancyHit(titleHits, TITLE_KEY), `${locale} title`);
    assert.ok(vibrancyHit(descHits, TITLE_KEY), `${locale} description locates row title`);
  }
});

test("description-only matches target the switch and overlapping keywords offer it once", () => {
  const t = translator("en");
  assert.deepEqual(searchSettings("GPU", t, { platform: "darwin" }), [
    { tab: "general", tabLabelKey: "settings.nav.general", rowKey: TITLE_KEY },
  ]);
  const overlapping = searchSettings("sidebar", t, { platform: "darwin" });
  assert.equal(overlapping.filter((hit) => hit.rowKey === TITLE_KEY).length, 1);
});

test("Windows and Linux omit the translucent sidebar title and description", () => {
  for (const locale of ["en", "zh-CN"]) {
    const t = translator(locale);
    const title = t(TITLE_KEY);
    const description = t(DESC_KEY);
    for (const platform of ["linux", "win32"]) {
      assert.deepEqual(
        searchSettings(title, t, { platform }),
        [],
        `${locale} ${platform} title`,
      );
      assert.deepEqual(
        searchSettings(description, t, { platform }),
        [],
        `${locale} ${platform} description`,
      );
    }
  }
});

test("other settings destinations stay searchable on every platform", () => {
  for (const locale of ["en", "zh-CN"]) {
    const t = translator(locale);
    const theme = t(THEME_KEY);
    for (const platform of ["darwin", "linux", "win32"]) {
      assert.ok(
        searchSettings(theme, t, { platform }).some(
          (hit) => hit.tab === "general" && hit.rowKey === THEME_KEY,
        ),
        `${locale} ${platform} theme`,
      );
    }
  }
});
