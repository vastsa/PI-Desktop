import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { IPC } from "../../../packages/shared/src/protocol.ts";
import { pluginProviderCatalogEntries } from "../electron/main/plugin-provider-catalog.ts";

/** Load the real main-process registration function with unrelated hosts stubbed. */
function loadPluginUiIpc() {
  const file = new URL("../electron/main/ipc/plugin-ui-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  const dependencies = {
    "node:fs": { existsSync: () => true },
    "node:path": { join: (...parts) => parts.join("/") },
    "@pi-desktop/shared": { IPC },
    "@pi-desktop/plugin-sdk": {
      normalizeThemeAssetPath: (path) => path,
      pluginThemeId: (...parts) => parts.join(":"),
      resolvePluginLocalizedString: (value) => value,
      themeAssetUrl: (value) => value,
    },
    "../browser-host": { BROWSER_PLUGIN_ID: "pi.browser", BROWSER_VIEW_ID: "browser" },
    "../plugin-runtime": { resolveInsidePlugin: () => "/plugin/index.html" },
    "../plugin-view-host": { pluginViewKey: (...parts) => parts.join("/") },
    "../plugin-panel-host": {},
    "../plugin-provider-catalog": { pluginProviderCatalogEntries },
  };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(dependencies, id), `unexpected plugin UI dependency: ${id}`);
      return dependencies[id];
    },
    module.exports,
    module,
  );
  return module.exports.registerPluginUiIpc;
}

test("the plugin Add Service IPC returns declared categories through the Host handler", async () => {
  const handlers = new Map();
  const plugin = (id, name, permissions, category) => ({
    permissions: new Set(permissions),
    manifest: {
      id,
      name,
      contributes: {
        providers: [{
          id: "primary",
          name: "Primary",
          baseUrl: "https://api.example/v1",
          category,
          description: { en: "A short English introduction.", "zh-CN": "一句话中文简介。" },
          models: [{ id: "model-1" }],
        }],
      },
    },
  });

  loadPluginUiIpc()({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    plugins: {
      listLoaded: () => [
        plugin("community.sites", "Community Sites", ["provider.register"], {
          en: "Community API Sites",
          "zh-CN": "公益站",
        }),
        plugin("unapproved.sites", "Unapproved", [], "Hidden"),
      ],
    },
    browserHost: {},
    pluginViews: {},
    pluginPanels: {},
    pluginActiveInProject: () => true,
    currentWorkspacePath: () => null,
    getUpdaterLocale: () => "zh-CN",
    getPluginPanelTheme: () => ({}),
  });

  const handler = handlers.get(IPC.invoke.pluginProviderCatalog);
  assert.equal(typeof handler, "function", "Add Service metadata IPC handler is registered");
  assert.deepEqual(await handler(), [{
    pluginId: "community.sites",
    providerId: "plugin:community.sites:primary",
    pluginName: "Community Sites",
    category: "公益站",
    description: "一句话中文简介。",
  }]);
});
