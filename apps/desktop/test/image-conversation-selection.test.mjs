import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { isImageGenerationModel } from "@pi-desktop/shared";
import { composerModelsForProvider } from "../src/lib/composer-models.ts";
import { defaultModelOptions } from "../src/components/settings/default-model.ts";

const image = { providerId: "images", modelId: "gpt-image-2.5" };
const providers = [
  { id: "images", models: [{ id: "gpt-image-2.5" }, { id: "chat" }] },
  { id: "other", models: [{ id: "gpt-image-2.5" }] },
];

test("conversation candidates exclude only the configured image binding", () => {
  assert.deepEqual(defaultModelOptions(providers, image).map(x => [x.provider.id, x.modelId]), [
    ["images", "chat"], ["other", "gpt-image-2.5"],
  ]);
  assert.deepEqual(composerModelsForProvider(providers[0], undefined, image).map(x => x.modelId), ["chat"]);
  assert.equal(isImageGenerationModel(image, "other", image.modelId), false);
  assert.equal(isImageGenerationModel(image, "images", image.modelId), true);
});

test("replacement and clearing recompute candidates without removing provider models", () => {
  const replacement = { providerId: "other", modelId: "gpt-image-2.5" };
  assert.equal(defaultModelOptions(providers, replacement).length, 2);
  assert.equal(composerModelsForProvider(providers[0], undefined, replacement).length, 2);
  assert.equal(defaultModelOptions(providers, null).length, 3);
  assert.equal(providers[0].models.length, 2);
  const legacy = { id: "images", models: [], defaultModelId: image.modelId };
  assert.deepEqual(defaultModelOptions([legacy], image), []);
  assert.deepEqual(composerModelsForProvider(legacy, undefined, image), []);
});

test("runtime rejects an image binding retained by an existing conversation", async () => {
  register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
  const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");
  const shell = { id: "cmd", label: "Command Prompt", dialect: "cmd", available: true, isDefault: true };
  const runtime = createSessionLaunchRuntime({
    runtimeState: { host: { call: async (method) => {
      if (method === "commandShells.list") return { configuredId: null, effective: shell, fallback: false, choices: [shell] };
      if (method === "providers.list") return { providers: [{ ...providers[0], authKind: "none" }] };
      if (method === "providers.getSecret") return {};
      throw new Error(`Unexpected host call: ${method}`);
    } } },
    modelsDevCatalog: { ensureLoaded: async () => {} },
  });
  await assert.rejects(
    runtime.resolveAgentRuntimeLaunch("session", { providerId: "images", modelId: image.modelId }, { imageGeneration: image }),
    error => error.errorCode === "MODEL_NOT_CONFIGURED" && /image model/.test(error.message),
  );
});
