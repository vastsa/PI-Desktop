import assert from "node:assert/strict";
import { register } from "node:module";
import i18n from "i18next";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { catalogs, flattenCatalog } = await import("@pi-desktop/i18n");
const { applyAppLanguage, resolveAppLanguage } = await import("../src/lib/renderer-language.ts");
const { loadRendererCatalog, loadRendererResources } = await import("../src/lib/renderer-catalogs.ts");

test("unset language defaults to zh-CN while explicit auto follows the OS locale", (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { locale: "en-US" } };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  assert.equal(resolveAppLanguage(undefined), "zh-CN");
  assert.equal(resolveAppLanguage("auto"), "en");
  assert.equal(resolveAppLanguage("en"), "en");
  assert.equal(resolveAppLanguage("zh-TW"), "zh-TW");
});

test("renderer locale resources load English fallback and the selected catalog", async () => {
  const resources = await loadRendererResources("zh-CN");

  assert.equal(
    resources.en.translation["app.starting"],
    catalogs.en.app.starting,
  );
  assert.equal(
    resources["zh-CN"].translation["app.starting"],
    catalogs["zh-CN"].app.starting,
  );
  assert.deepEqual(await loadRendererCatalog("zh-CN"), catalogs["zh-CN"]);
});

test("changing the renderer language loads its catalog before switching", async (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = { documentElement: { lang: "en" } };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  await i18n.init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: { translation: flattenCatalog(catalogs.en) },
    },
    interpolation: { escapeValue: false },
  });

  await applyAppLanguage("zh-CN");

  assert.equal(i18n.language, "zh-CN");
  assert.equal(i18n.t("app.starting"), catalogs["zh-CN"].app.starting);
  assert.equal(globalThis.document.documentElement.lang, "zh-CN");
});
