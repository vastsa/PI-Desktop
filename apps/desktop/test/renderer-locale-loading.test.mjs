import assert from "node:assert/strict";
import i18n from "i18next";
import test from "node:test";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { applyAppLanguage } from "../src/lib/renderer-language.ts";
import {
  loadRendererCatalog,
  loadRendererResources,
} from "../src/lib/renderer-catalogs.ts";

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
