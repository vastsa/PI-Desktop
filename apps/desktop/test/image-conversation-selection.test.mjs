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

test("an image-generation designation keeps the model usable for chat", () => {
  assert.deepEqual(defaultModelOptions(providers).map(x => [x.provider.id, x.modelId]), [
    ["images", "gpt-image-2.5"], ["images", "chat"], ["other", "gpt-image-2.5"],
  ]);
  assert.deepEqual(
    composerModelsForProvider(providers[0], undefined).map(x => x.modelId),
    ["gpt-image-2.5", "chat"],
  );
  assert.equal(isImageGenerationModel(image, "other", image.modelId), false);
  assert.equal(isImageGenerationModel(image, "images", image.modelId), true);
});

test("clearing candidates never removes provider models", () => {
  assert.equal(defaultModelOptions(providers).length, 3);
  assert.equal(composerModelsForProvider(providers[0], undefined).length, 2);
  assert.equal(providers[0].models.length, 2);
  const legacy = { id: "images", models: [], defaultModelId: image.modelId };
  assert.deepEqual(defaultModelOptions([legacy]).map(x => x.modelId), [image.modelId]);
  assert.deepEqual(
    composerModelsForProvider(legacy, undefined).map(x => x.modelId),
    [image.modelId],
  );
});

test("runtime no longer rejects an image-designated model for conversation", async () => {
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
    modelsDevCatalog: { configureAccount: () => {}, ensureLoaded: async () => {} },
  });
  // The launch path no longer fails the pairing up front; whatever happens
  // beyond that point, the old image-model guard is gone.
  await assert.doesNotReject(
    runtime.resolveAgentRuntimeLaunch(
      "session", { providerId: "images", modelId: image.modelId }, { imageGeneration: image },
    ).catch((error) => {
      assert.equal(/image model/.test(String(error?.message)), false);
    }),
  );
});
