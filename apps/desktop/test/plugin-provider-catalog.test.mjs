import assert from "node:assert/strict";
import test from "node:test";
import { pluginProviderCatalogEntries } from "../electron/main/plugin-provider-catalog.ts";

function plugin(id, name, permissions, providers) {
  return {
    permissions: new Set(permissions),
    manifest: { id, name, contributes: { providers } },
  };
}

test("the provider catalog is permission-filtered, API-key-only, localized and stable", () => {
  const entries = pluginProviderCatalogEntries([
    plugin("community.sites", "Community Sites", ["provider.register"], [
      {
        id: "second",
        name: "Second",
        baseUrl: "https://second.example/v1",
        category: { en: "Community", "zh-CN": "公益站" },
        description: { en: "A community API with check-in credits.", "zh-CN": "通过签到获取额度的公益 API 服务。" },
        models: [{ id: "second-model" }],
      },
      {
        id: "oauth",
        name: "Subscription",
        baseUrl: "https://oauth.example/v1",
        authKind: "oauth",
        models: [{ id: "oauth-model" }],
      },
      {
        id: "no-auth",
        name: "No authentication",
        baseUrl: "https://local.example/v1",
        authKind: "none",
        models: [{ id: "local-model" }],
      },
      {
        id: "missing-endpoint",
        name: "No endpoint",
        models: [{ id: "local-model" }],
      },
    ]),
    plugin("community.first", "First Plugin", ["provider.register"], [
      {
        id: "first",
        name: "First",
        baseUrl: "https://first.example/v1",
        category: "公益站",
        models: [{ id: "first-model" }],
      },
    ]),
    plugin("unapproved.plugin", "Unapproved", [], [
      {
        id: "hidden",
        name: "Hidden",
        baseUrl: "https://hidden.example/v1",
        models: [{ id: "hidden-model" }],
      },
    ]),
  ], "zh-CN");

  assert.deepEqual(entries, [
    {
      pluginId: "community.sites",
      providerId: "plugin:community.sites:second",
      pluginName: "Community Sites",
      category: "公益站",
      description: "通过签到获取额度的公益 API 服务。",
    },
    {
      pluginId: "community.first",
      providerId: "plugin:community.first:first",
      pluginName: "First Plugin",
      category: "公益站",
    },
  ]);
});

test("a missing category falls back to the plugin name", () => {
  const entries = pluginProviderCatalogEntries([
    plugin("demo.providers", "Demo Providers", ["provider.register"], [{
      id: "demo",
      name: "Demo",
      baseUrl: "https://demo.example/v1",
      models: [{ id: "demo-model" }],
    }]),
  ], "en");

  assert.equal(entries[0]?.category, "Demo Providers");
});

test("a localized provider category follows the active app locale", () => {
  const sources = [plugin("demo.providers", "Demo Providers", ["provider.register"], [{
    id: "demo",
    name: "Demo",
    baseUrl: "https://demo.example/v1",
    category: { en: "Community", "zh-CN": "公益站" },
    models: [{ id: "demo-model" }],
  }])];

  assert.equal(pluginProviderCatalogEntries(sources, "en")[0]?.category, "Community");
  assert.equal(pluginProviderCatalogEntries(sources, "zh-CN")[0]?.category, "公益站");
});

test("the provider catalog resolves a localized one-sentence introduction", () => {
  const sources = [plugin("demo.providers", "Demo Providers", ["provider.register"], [{
    id: "demo",
    name: "Demo",
    baseUrl: "https://demo.example/v1",
    description: { en: "A short introduction.", "zh-CN": "一句话简介。" },
    models: [{ id: "demo-model" }],
  }])];

  assert.equal(pluginProviderCatalogEntries(sources, "en")[0]?.description, "A short introduction.");
  assert.equal(pluginProviderCatalogEntries(sources, "zh-CN")[0]?.description, "一句话简介。");
});
