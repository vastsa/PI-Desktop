import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const renderer = await import("../src/lib/api.ts");
const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");
const { searchSettings } = await import("../src/lib/settings-search.ts");
const { en } = await import("../../../packages/i18n/src/locales/en/index.ts");
const { zhCN } = await import("../../../packages/i18n/src/locales/zh-CN/index.ts");
const { flattenCatalog } = await import("../../../packages/i18n/src/locale-info.ts");
const main = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: {} });

test("scheduled tasks default on and preserve an explicit choice through settings edits", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    for (const enabled of [undefined, false, true]) {
      const stored = { defaultMode: "agent", theme: "light", enterToSend: true,
        ...(enabled === undefined ? {} : { scheduledTasksEnabled: enabled }) };
      const displayed = renderer.normalizeSettings(main.normalizeSettings(stored));
      assert.equal(displayed.scheduledTasksEnabled, enabled !== false);
      const written = main.validateSettingsWrite(renderer.validateSettingsWrite({ ...displayed, theme: "dark" }));
      assert.equal(written.scheduledTasksEnabled, enabled !== false);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("scheduled task switch rejects non-boolean writes at renderer and main boundaries", () => {
  for (const scheduledTasksEnabled of [undefined, null, "false", 0, {}]) {
    for (const validate of [renderer.validateSettingsWrite, main.validateSettingsWrite]) {
      assert.throws(() => validate({ scheduledTasksEnabled }), /scheduledTasksEnabled is invalid/);
    }
  }
});

test("the scheduled task switch remains searchable in General in English and Chinese", () => {
  for (const [catalog, query] of [[en, "scheduled tasks"], [zhCN, "定时任务"]]) {
    const copy = flattenCatalog(catalog);
    const hits = searchSettings(query, (key) => copy[key] ?? key);
    assert.ok(hits.some((hit) => hit.tab === "general" && hit.rowKey === "settings.scheduledTasks"));
  }
});
