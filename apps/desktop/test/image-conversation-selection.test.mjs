import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { isImageGenerationModel } from "@pi-desktop/shared";
import { capabilitiesFromModelConfig } from "@pi-desktop/agent-runtime";
import { composerModelsForProvider } from "../src/lib/composer-models.ts";
import { defaultModelOptions } from "../src/components/settings/default-model.ts";

/**
 * Two classes of image-marked model, which #2253 separates:
 * - a pure image-generation endpoint (`gpt-image-2.5`) has no conversation
 *   route and must stay out of every chat surface, and
 * - a dual-capability model (`gpt6.1-terra`) marked for image generation also
 *   supports conversation and keeps its chat eligibility everywhere.
 */
const pureImage = { providerId: "images", modelId: "gpt-image-2.5" };
const dualCapability = { providerId: "images", modelId: "gpt6.1-terra" };
const bindings = [pureImage, dualCapability];

/**
 * Complete launch fixture for `resolveAgentRuntimeLaunch`: the Host/provider
 * boundary is mocked at `runtimeState.host`, so no real model call happens.
 * The launch must succeed end to end — no `.catch()` swallowing errors.
 */
async function makeLaunchRuntime({ bindingForModel = () => undefined, modelConfigFor, launchProviders } = {}) {
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
          return { providers: launchProviders ?? [runtimeProvider] };
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
    modelsDevCatalog: {
      configureAccount: () => {},
      ensureLoaded: async () => {},
      findModel: () => undefined,
      ...(modelConfigFor ? { modelConfigFor } : {}),
    },
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
  { id: "images", models: [{ id: "gpt-image-2.5" }, { id: "gpt6.1-terra" }, { id: "chat" }] },
  { id: "other", models: [{ id: "gpt-image-2.5" }] },
];

test("a pure image-generation model stays out of chat menus", () => {
  assert.deepEqual(defaultModelOptions(providers, bindings).map(x => [x.provider.id, x.modelId]), [
    ["images", "gpt6.1-terra"], ["images", "chat"], ["other", "gpt-image-2.5"],
  ]);
  assert.deepEqual(
    composerModelsForProvider(providers[0], undefined, bindings).map(x => x.modelId),
    ["gpt6.1-terra", "chat"],
  );
  assert.equal(isImageGenerationModel(bindings, "other", pureImage.modelId), false);
  assert.equal(isImageGenerationModel(bindings, "images", pureImage.modelId), true);
});

test("a dual-capability image-marked model stays selectable for chat", () => {
  // Both menus keep the image-marked model: the image binding is host-owned
  // and independent of the conversation route (#2253).
  assert.deepEqual(defaultModelOptions(providers, [dualCapability]).map(x => [x.provider.id, x.modelId]), [
    ["images", "gpt-image-2.5"], ["images", "gpt6.1-terra"], ["images", "chat"],
    ["other", "gpt-image-2.5"],
  ]);
  assert.deepEqual(
    composerModelsForProvider(providers[0], undefined, [dualCapability]).map(x => x.modelId),
    ["gpt-image-2.5", "gpt6.1-terra", "chat"],
  );
});

test("discovered image-only output modalities exclude a marked model; unknown custom metadata does not", () => {
  const discovered = [
    {
      modelId: "vision-image", displayName: "vision-image", providerId: "images",
      modalities: { input: ["text"], output: ["image"] }, capabilities: [], source: "discovered",
    },
  ];
  const visionProvider = { id: "images", models: [{ id: "vision-image" }] };
  const marked = [{ providerId: "images", modelId: "vision-image" }];
  // Published output modalities that name no text output put the marked model
  // out of the Composer list.
  assert.deepEqual(
    composerModelsForProvider(visionProvider, discovered, marked).map(x => x.modelId),
    [],
  );
  // Metadata is unknown, not an inference failure: the same id without
  // discovery metadata is never excluded on a guess.
  assert.deepEqual(
    composerModelsForProvider(visionProvider, undefined, marked).map(x => x.modelId),
    ["vision-image"],
  );
  // An unmarked model is never excluded by its own modalities either.
  assert.deepEqual(
    composerModelsForProvider(visionProvider, discovered, []).map(x => x.modelId),
    ["vision-image"],
  );
});

test("clearing candidates never removes provider models a chat route can serve", () => {
  assert.equal(defaultModelOptions(providers, bindings).length, 3);
  assert.equal(composerModelsForProvider(providers[0], undefined, bindings).length, 2);
  assert.equal(providers[0].models.length, 3);
  const legacy = { id: "images", models: [], defaultModelId: dualCapability.modelId };
  assert.deepEqual(defaultModelOptions([legacy], bindings).map(x => x.modelId), [dualCapability.modelId]);
  assert.deepEqual(
    composerModelsForProvider(legacy, undefined, bindings).map(x => x.modelId),
    [dualCapability.modelId],
  );
  // A legacy default naming a pure image-generation endpoint is still not a
  // chat option.
  const legacyPure = { id: "images", models: [], defaultModelId: pureImage.modelId };
  assert.deepEqual(defaultModelOptions([legacyPure], bindings).map(x => x.modelId), []);
});

test("a pure image-generation endpoint cannot launch a conversation", async () => {
  register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
  const { runtime } = await makeLaunchRuntime();
  await assert.rejects(
    runtime.resolveAgentRuntimeLaunch(
      "session-pure-image",
      { providerId: "images", modelId: pureImage.modelId },
      { defaultProviderId: "images", defaultModelId: "chat", imageGenerationModels: [pureImage] },
    ),
    (error) => error.errorCode === "MODEL_NOT_CONFIGURED",
  );
});

test("launch succeeds with a dual-capability image-marked model and keeps the image binding", async () => {
  register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
  const bindingCalls = [];
  const { runtime, calls } = await makeLaunchRuntime({
    bindingForModel: (provider, modelId) => {
      bindingCalls.push([provider.id, modelId]);
      if (modelId === dualCapability.modelId) {
        return { thinkingLevels: [], supportsImages: true, supportsDocuments: null };
      }
      return undefined;
    },
  });
  // The launch path must not fail the pairing up front: an image-generation
  // designation on a conversation-capable model is host-owned and independent
  // of the conversation route, so the launch itself must succeed — not merely
  // avoid the old error message.
  const launch = await runtime.resolveAgentRuntimeLaunch(
    "session-image",
    { providerId: "images", modelId: dualCapability.modelId },
    { defaultProviderId: "images", defaultModelId: "chat", imageGenerationModels: [pureImage, dualCapability] },
  );
  assert.equal(launch.providerId, "images");
  assert.equal(launch.modelId, dualCapability.modelId);
  assert.equal(launch.sidecarParams.provider.id, "images");
  assert.equal(launch.sidecarParams.provider.modelId, dualCapability.modelId);
  // The stored image binding reaches the send path: the explicit
  // supportsImages pin survives the launch instead of being dropped.
  assert.equal(launch.sidecarParams.provider.supportsVision, true);
  assert.deepEqual(bindingCalls, [["images", dualCapability.modelId]]);
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
      return modelId === dualCapability.modelId
        ? { thinkingLevels: [], supportsImages: true, supportsDocuments: null }
        : undefined;
    },
  });
  // The session pins no model, so the saved chat default applies. Saving the
  // image binding must not reroute the default through the image model.
  const launch = await runtime.resolveAgentRuntimeLaunch(
    "session-default",
    {},
    { defaultProviderId: "images", defaultModelId: "chat", imageGenerationModels: [pureImage, dualCapability] },
  );
  assert.equal(launch.providerId, "images");
  assert.equal(launch.modelId, "chat");
  assert.equal(launch.sidecarParams.provider.modelId, "chat");
  assert.deepEqual(bindingCalls, [["images", "chat"]]);
});

// #2253 follow-up: the metadata argument must reach every call site, so a
// non-reserved image-only endpoint (a name the id regex cannot catch) is
// excluded by its discovered modalities on the same terms session launch
// reads them, an unknown custom model stays chat-eligible, and a
// dual-capability model stays selectable.
const visionImage = { providerId: "images", modelId: "vision-image" };
const visionDiscovered = [
  {
    modelId: "vision-image", displayName: "vision-image", providerId: "images",
    modalities: { input: ["text"], output: ["image"] }, capabilities: [], source: "discovered",
  },
];
const visionProviders = [{ id: "images", models: [{ id: "vision-image" }, { id: "chat" }] }];

test("a non-reserved image-only bound model is excluded from the default picker by its metadata", () => {
  // With the discovered row the default picker excludes it, exactly as the
  // Composer list and session launch do.
  assert.deepEqual(
    defaultModelOptions(visionProviders, [visionImage], { images: visionDiscovered }).map(x => x.modelId),
    ["chat"],
  );
  // Without discovery metadata the binding alone is not a guess to exclude on.
  assert.deepEqual(
    defaultModelOptions(visionProviders, [visionImage]).map(x => x.modelId),
    ["vision-image", "chat"],
  );
});

test("a non-reserved image-only bound model cannot launch a conversation", async () => {
  register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
  const { runtime } = await makeLaunchRuntime({
    // The catalog row publishes image-only output modalities; the id itself
    // matches no reserved image-endpoint name.
    modelConfigFor: (input) => input.modelId === "vision-image"
      ? { modalities: { input: ["text"], output: ["image"] } }
      : {},
  });
  await assert.rejects(
    runtime.resolveAgentRuntimeLaunch(
      "session-vision-image",
      { providerId: "images", modelId: "vision-image" },
      { defaultProviderId: "images", defaultModelId: "chat", imageGenerationModels: [visionImage] },
    ),
    (error) => error.errorCode === "MODEL_NOT_CONFIGURED",
  );
});

test("an unknown custom image-marked model launches and stays selectable", async () => {
  register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
  const { runtime } = await makeLaunchRuntime({
    // No catalog row at all: the endpoint is a user-configured custom model
    // resolving to a generic, unrestricted config.
    launchProviders: [{
      id: "custom", authKind: "none", enabled: true,
      defaultModelId: "custom-vision", models: [{ id: "custom-vision" }],
    }],
    bindingForModel: (provider, modelId) => modelId === "custom-vision"
      ? { thinkingLevels: [], supportsImages: true, supportsDocuments: null }
      : undefined,
  });
  const customProvider = { id: "custom", models: [{ id: "custom-vision" }] };
  const customBinding = { providerId: "custom", modelId: "custom-vision" };
  // Unknown metadata is not an inference failure: the picker keeps it.
  assert.deepEqual(
    defaultModelOptions([customProvider], [customBinding]).map(x => x.modelId),
    ["custom-vision"],
  );
  assert.deepEqual(
    composerModelsForProvider(customProvider, undefined, [customBinding]).map(x => x.modelId),
    ["custom-vision"],
  );
  // And launch admits the pairing instead of rejecting on a guess.
  const launch = await runtime.resolveAgentRuntimeLaunch(
    "session-custom-vision",
    { providerId: "custom", modelId: "custom-vision" },
    { defaultProviderId: "custom", defaultModelId: "custom-vision", imageGenerationModels: [customBinding] },
  );
  assert.equal(launch.modelId, "custom-vision");
});

test("a dual-capability image-marked model is selectable and launches with discovered metadata", async () => {
  register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
  const dualDiscovered = [
    {
      modelId: "gpt6.1-terra", displayName: "gpt6.1-terra", providerId: "images",
      modalities: { input: ["text", "image"], output: ["text", "image"] }, capabilities: [], source: "discovered",
    },
  ];
  // Text in the output modalities keeps the model selectable everywhere.
  assert.deepEqual(
    defaultModelOptions(providers, [dualCapability], { images: dualDiscovered }).map(x => x.modelId),
    ["gpt-image-2.5", "gpt6.1-terra", "chat", "gpt-image-2.5"],
  );
  assert.deepEqual(
    composerModelsForProvider(providers[0], dualDiscovered, [dualCapability]).map(x => x.modelId),
    ["gpt-image-2.5", "gpt6.1-terra", "chat"],
  );
  const { runtime } = await makeLaunchRuntime({
    bindingForModel: (provider, modelId) => modelId === dualCapability.modelId
      ? { thinkingLevels: [], supportsImages: true, supportsDocuments: null }
      : undefined,
  });
  const launch = await runtime.resolveAgentRuntimeLaunch(
    "session-dual-discovered",
    { providerId: "images", modelId: dualCapability.modelId },
    { defaultProviderId: "images", defaultModelId: "chat", imageGenerationModels: [dualCapability] },
  );
  assert.equal(launch.modelId, dualCapability.modelId);
});
