import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { composerModelsForProvider } = await import("../src/lib/composer-models.ts");
const { defaultModelOptions, loginDefaultModel } = await import("../src/components/settings/default-model.ts");

test("OAuth plugin image-only models never enter native chat choices or become the login default", () => {
  const provider = {
    id: "plugin:fixture.oauth:gateway", ownerPluginId: "fixture.oauth", name: "Fixture", enabled: true,
    authKind: "oauth", hasOauth: true, hasSecret: false,
    models: [{ id: "image" }, { id: "chat" }],
    pluginModelOperations: { image: ["images"], chat: ["chat"] },
  };
  assert.deepEqual(composerModelsForProvider(provider, []).map(model => model.modelId), ["chat"]);
  assert.deepEqual(defaultModelOptions([provider]).map(model => model.modelId), ["chat"]);
  assert.deepEqual(loginDefaultModel([provider], provider.id, {}), { providerId: provider.id, modelId: "chat" });
  const imageOnly = { ...provider, models: [{ id: "image" }] };
  assert.deepEqual(composerModelsForProvider(imageOnly, []), []);
  assert.equal(loginDefaultModel([imageOnly], imageOnly.id, {}), null);
});
