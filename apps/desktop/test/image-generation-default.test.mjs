/**
 * Behavioural tests for the app's default image model across a provider save.
 *
 * `settings.imageGeneration` is the app default the Composer reads, while
 * `settings.imageGenerationModels` is only the candidate list the picker
 * offers. Adding a provider extends that list, so these tests pin that the
 * user's default survives an added provider and moves only when the stored
 * choice stops being *runnable*.
 *
 * "Runnable" is the strict rule the picker row and the runtime apply: enabled
 * provider, non-OAuth, base URL, a usable credential and one of the provider's
 * configured models matched exactly. `providerOffersModel` is deliberately
 * looser — it answers whether a row *names* a model for the summary line — so
 * the assertions here must not accept it as proof that a default can run.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// The renderer module resolves its sibling through the bundler, not Node.
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  imageGenerationBindingAvailable,
  planImageGenerationDefaults,
  resolvesImageGenerationDefault,
} = await import("../src/components/settings/image-generation-default.ts");
const { MAX_IMAGE_GENERATION_MODELS, imageGenerationBindings, isImageGenerationModel } = await import("@pi-desktop/shared");

/** A runnable image provider row; `over` overrides any field. */
const provider = (id, modelIds, over = {}) => ({
  id,
  name: id,
  enabled: true,
  hasSecret: true,
  hasOauth: false,
  authKind: "api_key_and_base_url",
  baseUrl: "https://example.test/v1",
  models: modelIds.map((modelId) => ({ id: modelId })),
  ...over,
});

const binding = (providerId, modelId) => ({ providerId, modelId });

test("image bindings distinguish full routes and providers while ignoring case", () => {
  const prefixed = binding("x", "generic/model");
  const plain = binding("x", "model");
  assert.deepEqual(imageGenerationBindings([prefixed, plain, binding("x", "GENERIC/MODEL")], null),
    [prefixed, plain]);
  assert.equal(isImageGenerationModel([prefixed], "x", "model"), false);
  assert.equal(isImageGenerationModel([prefixed], "y", "generic/model"), false);
  assert.equal(isImageGenerationModel([prefixed], "x", "GENERIC/MODEL"), true);
  assert.equal(imageGenerationBindingAvailable(provider("x", ["generic/model"]), "model"), false);
  assert.equal(imageGenerationBindingAvailable(provider("x", ["generic/model"]), "GENERIC/MODEL"), false);
  const plan = planImageGenerationDefaults({ imageGeneration: prefixed }, "x", ["model"],
    [provider("x", ["generic/model", "model"])]);
  assert.deepEqual(plan.imageGeneration, plain);
});

test("a saved image selection extends the candidates without taking the default", () => {
  const plan = planImageGenerationDefaults(
    {
      imageGenerationModels: [binding("x", "img-x")],
      imageGeneration: binding("x", "img-x"),
    },
    "y",
    ["img-y"],
    [provider("x", ["img-x"]), provider("y", ["img-y"])],
  );
  assert.deepEqual(plan.imageGenerationModels, [
    binding("x", "img-x"),
    binding("y", "img-y"),
  ]);
  assert.deepEqual(plan.imageGeneration, binding("x", "img-x"));
});

test("a legacy default stored without a candidate list is kept too", () => {
  const plan = planImageGenerationDefaults(
    { imageGeneration: binding("x", "img-x") },
    "y",
    ["img-y"],
    [provider("x", ["img-x"]), provider("y", ["img-y"])],
  );
  assert.deepEqual(plan.imageGeneration, binding("x", "img-x"));
});

test("a default that no longer resolves gives way to a provider that does", () => {
  // The image provider was deleted while its binding stayed in settings: a
  // newly added provider with image models is what should fill that default.
  // The dead binding is dropped from the candidates as well — nothing can pick
  // a provider row that is gone, and the host would keep it forever.
  const plan = planImageGenerationDefaults(
    {
      imageGenerationModels: [binding("gone", "img-gone")],
      imageGeneration: binding("gone", "img-gone"),
    },
    "y",
    ["img-y"],
    [provider("y", ["img-y"])],
  );
  assert.deepEqual(plan.imageGenerationModels, [binding("y", "img-y")]);
  assert.deepEqual(plan.imageGeneration, binding("y", "img-y"));
});

test("an unconfigured default is filled by the saved selection", () => {
  const plan = planImageGenerationDefaults(
    { imageGenerationModels: [], imageGeneration: null },
    "y",
    ["img-y", "img-y", "img-y-alt"],
    [provider("y", ["img-y", "img-y-alt"])],
  );
  // A repeated pick collapses, so the picker shows one row per model.
  assert.deepEqual(plan.imageGenerationModels, [
    binding("y", "img-y"),
    binding("y", "img-y-alt"),
  ]);
  assert.deepEqual(plan.imageGeneration, binding("y", "img-y"));
});

test("editing a provider replaces its own candidates only", () => {
  const plan = planImageGenerationDefaults(
    {
      imageGenerationModels: [binding("x", "img-x"), binding("y", "img-y-old")],
      imageGeneration: binding("x", "img-x"),
    },
    "y",
    ["img-y-new"],
    [provider("x", ["img-x"]), provider("y", ["img-y-new"])],
  );
  assert.deepEqual(plan.imageGenerationModels, [
    binding("x", "img-x"),
    binding("y", "img-y-new"),
  ]);
  assert.deepEqual(plan.imageGeneration, binding("x", "img-x"));
});

/**
 * Availability, not naming. The default is kept only while the provider can
 * actually run the model, so every state that would fail on the next request is
 * treated as unresolvable.
 */
test("resolving requires a runnable provider row", () => {
  const providers = [provider("x", ["img-x"])];
  assert.equal(resolvesImageGenerationDefault(null, providers), false);
  assert.equal(resolvesImageGenerationDefault(undefined, providers), false);
  assert.equal(resolvesImageGenerationDefault(binding("x", "img-x"), providers), true);
  // Another provider serving the same id is not the configured one.
  assert.equal(
    resolvesImageGenerationDefault(binding("x", "img-x"), [provider("z", ["img-x"])]),
    false,
  );
  // A model the provider no longer lists cannot hold the default.
  assert.equal(
    resolvesImageGenerationDefault(binding("x", "img-x"), [provider("x", ["other"])]),
    false,
  );
  // Covered in default-model-display.test.mjs: `providerOffersModel` accepts
  // all of these, which is exactly why the default must not use it.
  assert.equal(
    resolvesImageGenerationDefault(binding("x", "img-x"), [
      provider("x", ["img-x"], { enabled: false }),
    ]),
    false,
    "a disabled provider cannot run the stored default",
  );
  assert.equal(
    resolvesImageGenerationDefault(binding("x", "img-x"), [
      provider("x", ["img-x"], { hasSecret: false, hasOauth: false }),
    ]),
    false,
    "a provider without a stored key cannot run the stored default",
  );
  // A legacy OAuth-style row storing only `defaultModelId` used to count as
  // resolving. It names a model without configuring one, and the runtime
  // requires `provider.models` to contain it, so it must not keep the default.
  const legacyOnly = { ...provider("x", []), defaultModelId: "img-x" };
  assert.equal(imageGenerationBindingAvailable(legacyOnly, "img-x"), false);
  assert.equal(
    resolvesImageGenerationDefault(binding("x", "img-x"), [legacyOnly]),
    false,
    "a row with no configured model cannot run anything",
  );
  assert.equal(
    resolvesImageGenerationDefault(binding("x", "img-x"), [
      provider("x", ["img-x"], { authKind: "oauth", hasOauth: true, hasSecret: true }),
    ]),
    false,
    "image generation has no OAuth path",
  );
  assert.equal(
    resolvesImageGenerationDefault(binding("x", "img-x"), [
      provider("x", ["img-x"], { baseUrl: undefined }),
    ]),
    false,
    "an unaddressed provider cannot run the stored default",
  );
  // A no-auth row needs no key at all.
  assert.equal(
    resolvesImageGenerationDefault(binding("x", "img-x"), [
      provider("x", ["img-x"], { authKind: "none", hasSecret: false }),
    ]),
    true,
  );
  // Exact equality, like the runtime: a vendor-prefixed spelling is a different
  // binding, and the prefix-tolerant chat matcher must not leak in here.
  assert.equal(
    resolvesImageGenerationDefault(binding("x", "img-x"), [
      provider("x", ["openai/img-x"]),
    ]),
    false,
  );
});

test("the fallback is the first runnable candidate, never just the first one", () => {
  const plan = planImageGenerationDefaults(
    {
      imageGenerationModels: [binding("x", "img-x"), binding("y", "img-y")],
      imageGeneration: binding("x", "img-x"),
    },
    "z",
    ["img-z"],
    [
      provider("x", ["img-x"], { hasSecret: false }), // listed, not runnable
      provider("y", ["img-y"]),
      provider("z", ["img-z"]),
    ],
  );
  assert.deepEqual(plan.imageGenerationModels, [
    binding("x", "img-x"),
    binding("y", "img-y"),
    binding("z", "img-z"),
  ]);
  // The old behaviour kept x/img-x: the row existed, so the picker showed a
  // pairing the runtime then refused to run.
  assert.deepEqual(plan.imageGeneration, binding("y", "img-y"));
});

test("nothing runnable leaves the default empty instead of a dead binding", () => {
  const plan = planImageGenerationDefaults(
    {
      imageGenerationModels: [binding("x", "img-x")],
      imageGeneration: binding("x", "img-x"),
    },
    "y",
    ["img-y"],
    [
      provider("x", ["img-x"], { enabled: false }),
      provider("y", ["img-y"], { authKind: "oauth", hasOauth: true }),
    ],
  );
  assert.equal(plan.imageGeneration, null);
});

test("candidates of a removed provider are dropped, the runnable ones stay", () => {
  const plan = planImageGenerationDefaults(
    {
      imageGenerationModels: [
        binding("gone", "img-gone"),
        binding("x", "img-x"),
      ],
      imageGeneration: binding("x", "img-x"),
    },
    "x",
    ["img-x"],
    [provider("x", ["img-x"])],
  );
  assert.deepEqual(plan.imageGenerationModels, [binding("x", "img-x")]);
  assert.deepEqual(plan.imageGeneration, binding("x", "img-x"));
});

test("a long candidate list is capped like the host and keeps the active binding", () => {
  // The settings channel rejects more than MAX_IMAGE_GENERATION_MODELS rows, so
  // the plan has to trim the tail itself instead of saving a list the host
  // refuses — the same cap the parser enforces.
  const many = Array.from({ length: MAX_IMAGE_GENERATION_MODELS + 2 }, (_, index) => ({
    binding: binding(`p${index}`, `img-${index}`),
    provider: provider(`p${index}`, [`img-${index}`]),
  }));
  const providers = many.map((entry) => entry.provider);
  const candidates = many.map((entry) => entry.binding);

  const capped = planImageGenerationDefaults(
    { imageGenerationModels: candidates, imageGeneration: null },
    "p0",
    ["img-0"],
    providers,
  );
  assert.equal(capped.imageGenerationModels.length, MAX_IMAGE_GENERATION_MODELS);
  // The saved provider's rows move to the tail, so the first runnable
  // candidate is the one the cap kept at the head.
  assert.deepEqual(capped.imageGeneration, capped.imageGenerationModels[0]);

  // An active binding that sits past the cut must survive the trim, otherwise
  // the default points at a candidate the picker can no longer show.
  const active = candidates[candidates.length - 1];
  const kept = planImageGenerationDefaults(
    { imageGenerationModels: candidates, imageGeneration: active },
    "p0",
    ["img-0"],
    providers,
  );
  assert.equal(kept.imageGenerationModels.length, MAX_IMAGE_GENERATION_MODELS);
  assert.deepEqual(kept.imageGeneration, active);
  assert.ok(
    kept.imageGenerationModels.some((entry) =>
      entry.providerId === active.providerId && entry.modelId === active.modelId
    ),
    "the active binding must stay in the capped candidate list",
  );
});

for (const candidates of [undefined, [], [binding("x", "chat-model")]]) {
  test(`unchecking the only image model releases it for chat (${JSON.stringify(candidates)})`, async () => {
    const { imageGenerationBindings } = await import("@pi-desktop/shared");
    const { defaultModelOptions } = await import("../src/components/settings/default-model.ts");
    const providers = [provider("x", ["chat-model"])];
    const plan = planImageGenerationDefaults(
      { imageGenerationModels: candidates, imageGeneration: binding("x", "chat-model") },
      "x", [], providers,
    );
    assert.equal(plan.imageGeneration, null);
    assert.deepEqual(plan.imageGenerationModels, []);
    const reloaded = JSON.parse(JSON.stringify(plan));
    assert.deepEqual(defaultModelOptions(providers,
      imageGenerationBindings(reloaded.imageGenerationModels, reloaded.imageGeneration)
    ).map(({ modelId }) => modelId), ["chat-model"]);
  });
}

test("unchecking the active model selects a remaining runnable candidate", () => {
  const plan = planImageGenerationDefaults(
    { imageGenerationModels: [binding("x", "old"), binding("y", "other")],
      imageGeneration: binding("x", "old") },
    "x", ["next"], [provider("x", ["old", "next"]), provider("y", ["other"], { enabled: false })],
  );
  assert.deepEqual(plan.imageGeneration, binding("x", "next"));
  assert.deepEqual(plan.imageGenerationModels, [binding("y", "other"), binding("x", "next")]);
});

test("removing the active provider model clears the image default", () => {
  const plan = planImageGenerationDefaults(
    {
      imageGenerationModels: [binding("x", "old"), binding("y", "other")],
      imageGeneration: binding("x", "old"),
    },
    "x",
    ["next"],
    [provider("x", ["next"]), provider("y", ["other"])],
    true,
  );
  assert.equal(plan.imageGeneration, null);
  assert.deepEqual(plan.imageGenerationModels, [binding("y", "other"), binding("x", "next")]);
});

test("saving the active provider preserves a still-selected default", () => {
  const plan = planImageGenerationDefaults(
    { imageGeneration: binding("x", "current") },
    "x", ["first", "current"], [provider("x", ["first", "current"])],
  );
  assert.deepEqual(plan.imageGeneration, binding("x", "current"));
});

test("unchecking every image model on the active provider clears the settings check", () => {
  const plan = planImageGenerationDefaults(
    {
      imageGenerationModels: [binding("x", "img-x"), binding("y", "img-y")],
      imageGeneration: binding("x", "img-x"),
    },
    "x",
    [],
    [provider("x", ["img-x"]), provider("y", ["img-y"])],
  );
  assert.equal(plan.imageGeneration, null);
  assert.deepEqual(plan.imageGenerationModels, [binding("y", "img-y")]);
});
