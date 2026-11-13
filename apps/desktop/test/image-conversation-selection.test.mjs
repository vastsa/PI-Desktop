import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { isImageGenerationModel } from "@pi-desktop/shared";
import { capabilitiesFromModelConfig } from "@pi-desktop/agent-runtime";
import { composerModelsForProvider } from "../src/lib/composer-models.ts";
import { defaultModelOptions } from "../src/components/settings/default-model.ts";

const image = { providerId: "images", modelId: "gpt-image-2.5" };

/**
 * Complete launch fixture for `resolveAgentRuntimeLaunch`: the Host/provider
 * boundary is mocked at `runtimeState.host`, so no real model call happens.
 * The launch must succeed end to end — no `.catch()` swallowing errors.
 */
async function makeLaunchRuntime({ bindingForModel = () => undefined } = {}) {
  const calls = [];
  const shell = { id: "cmd", label: "Command Prompt", dialect: "cmd", available: true, isDefault: true };
  const runtimeProvider = {
    ...providers[0],
    authKind: "none",
    enabled: true,
    defaultModelId: "chat",
  };
  const host = {
    isAvailable: () => true,
    call: async (method) => {
      calls.push(method);
      switch (method) {
        case "commandShells.list":
          return { configuredId: null, effective: shell, fallback: false, choices: [shell] };
        case "providers.list":
          return { providers: [runtimeProvider] };
        case "providers.getSecret":
          return {};
        case "skills.disabledBuiltins":
        case "agents.disabledBuiltins":
          return { disabled: [] };
        case "skills.active":
          return { skills: [] };
        case "agents.active":
          return { subagents: [] };
        case "mcp.active":
          return { servers: [] };
        case "settings.get":
          return { inlineVisualizations: false };
        default:
          throw new Error(`Unexpected host call: ${method}`);
      }
    },
  };
  const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");
  const runtime = createSessionLaunchRuntime({
    runtimeState: { host },
    logger: { app: () => {} },
    userMcp: { toolsForProject: async () => [] },
    plugins: {
      listLoaded: () => [],
      getSkills: () => [],
      getTools: () => [],
      getAgentExtensions: () => [],
    },
    sessionProjects: new Map(),
    dataDir: "/tmp/pi-desktop-launch-test",
    modelsDevCatalog: { configureAccount: () => {}, ensureLoaded: async () => {}, findModel: () => undefined },
    vendorOAuth: { bindingFor: async () => undefined },
    getWorkspacePath: () => null,
    pluginActiveInProject: () => false,
    bindingForModel,
    effectiveSubagentModelConfig: (provider, modelId, catalogModelConfig) => ({
      modelConfig: catalogModelConfig,
      capabilities: capabilitiesFromModelConfig(catalogModelConfig),
    }),
    normalizeThinkingLevel: (value) => value ?? "medium",
  });
  return { runtime, calls };
}
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

test("launch succeeds with an image-designated model and keeps the image binding", async () => {
  register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
  const bindingCalls = [];
  const { runtime, calls } = await makeLaunchRuntime({
    bindingForModel: (provider, modelId) => {
      bindingCalls.push([provider.id, modelId]);
      if (modelId === image.modelId) {
        return { thinkingLevels: [], supportsImages: true, supportsDocuments: null };
      }
      return undefined;
    },
  });
  // The launch path no longer fails the pairing up front: an image-generation
  // designation is host-owned and independent of the conversation route, so
  // the launch itself must succeed — not merely avoid the old error message.
  const launch = await runtime.resolveAgentRuntimeLaunch(
    "session-image",
    { providerId: "images", modelId: image.modelId },
    {},
  );
  assert.equal(launch.providerId, "images");
  assert.equal(launch.modelId, image.modelId);
  assert.equal(launch.sidecarParams.provider.id, "images");
  assert.equal(launch.sidecarParams.provider.modelId, image.modelId);
  // The stored image binding reaches the send path: the explicit
  // supportsImages pin survives the launch instead of being dropped.
  assert.equal(launch.sidecarParams.provider.supportsVision, true);
  assert.deepEqual(bindingCalls, [["images", image.modelId]]);
  assert.deepEqual([...calls].sort(), [
    "agents.active", "agents.disabledBuiltins", "commandShells.list",
    "mcp.active", "providers.getSecret", "providers.list",
    "skills.active", "skills.disabledBuiltins",
  ]);
});

test("the chat default model is unchanged once an image binding is saved", async () => {
  register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
  const bindingCalls = [];
  const { runtime } = await makeLaunchRuntime({
    bindingForModel: (provider, modelId) => {
      bindingCalls.push([provider.id, modelId]);
      // The image binding is stored only for the image model; the chat default
      // keeps no binding of its own.
      return modelId === image.modelId
        ? { thinkingLevels: [], supportsImages: true, supportsDocuments: null }
        : undefined;
    },
  });
  // The session pins no model, so the saved chat default applies. Saving the
  // image binding must not reroute the default through the image model.
  const launch = await runtime.resolveAgentRuntimeLaunch(
    "session-default",
    {},
    { defaultProviderId: "images", defaultModelId: "chat" },
  );
  assert.equal(launch.providerId, "images");
  assert.equal(launch.modelId, "chat");
  assert.equal(launch.sidecarParams.provider.modelId, "chat");
  assert.deepEqual(bindingCalls, [["images", "chat"]]);
});
