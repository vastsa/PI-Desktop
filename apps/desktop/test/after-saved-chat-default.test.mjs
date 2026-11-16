/**
 * Behavioural tests for the chat-default migration in the image-binding save
 * branch of `ModelConfigPage.afterSaved`.
 *
 * Marking a model for image generation during a provider save can leave the
 * app's chat default pointing at a model that can no longer hold one. The
 * callback must judge that from post-save state — the bindings `plan` writes
 * plus the discovered metadata — never from the pre-save candidates memo,
 * which cannot see what this save just marked (#2304 review). Three rules are
 * pinned here: a dual-capability default keeps its chat role, a default that
 * became unable to chat migrates to a chat model the saved provider still
 * serves, and with no replacement the stored default is left untouched.
 *
 * The `afterSaved` closure is extracted verbatim from the component source,
 * executed with the real `planImageGenerationDefaults` and shared helpers, and
 * captures the save result through `api.getSettings`/`api.setSettings` stand-ins
 * — the same harness the review ran by hand.
 */
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { isImageOnlyChatModel } = await import("@pi-desktop/shared");
const { planImageGenerationDefaults } = await import(
  "../src/components/settings/image-generation-default.ts"
);
const { providerServesChatModels } = await import(
  "../src/components/settings/default-model.ts"
);

const pageSource = await readFile(
  new URL("../src/components/settings/ModelConfigPage.tsx", import.meta.url),
  "utf8",
);

// The module-private helpers the closure reads, plus the closure itself.
const helpersStart = pageSource.indexOf("const sameWireId =");
const helpersEnd = pageSource.indexOf("export function ModelConfigPage");
const closureStart = pageSource.indexOf("const afterSaved = async (");
const closureEnd = pageSource.indexOf("const setImageGenerationDefault");
assert.ok(helpersStart !== -1 && helpersEnd > helpersStart, "helper block not found");
assert.ok(closureStart !== -1 && closureEnd > closureStart, "afterSaved block not found");
const snippet = `${pageSource.slice(helpersStart, helpersEnd)}\n${pageSource.slice(closureStart, closureEnd)}`;
const { outputFiles } = buildSync({
  stdin: { contents: snippet, loader: "ts", sourcefile: "ModelConfigPage.afterSaved.ts" },
  write: false,
  format: "cjs",
});
const code = outputFiles[0].text;

/** Run the verbatim closure against stubbed store/api boundaries. */
const runAfterSaved = async (over = {}) => {
  const savedSettings = over.settings ?? {};
  const savedBodies = [];
  const deps = {
    isImageOnlyChatModel,
    planImageGenerationDefaults,
    providerServesChatModels,
    // The pre-save candidates memo: deliberately stale so the callback can
    // only answer correctly from the post-save bindings it writes.
    imageGenerationCandidates: over.imageGenerationCandidates ?? [],
    providerModels: over.providerModels ?? {},
    providers: over.providers ?? [],
    settings: savedSettings,
    pluginCatalogSetup: null,
    editingProvider: over.editingProvider ?? { id: "p" },
    copyDraft: null,
    api: {
      getSettings: async () => savedSettings,
      setSettings: async (next) => {
        savedBodies.push(next);
        return next;
      },
    },
    useAppStore: { setState() {} },
    showToast() {},
    t: (key) => key,
    setSetupFor() {},
    setCopyDraft() {},
    setPluginCatalogSetup() {},
    refreshProviders: async () => {},
    ...over.deps,
  };
  const afterSaved = new Function(...Object.keys(deps), `${code}\nreturn afterSaved;`)(
    ...Object.values(deps),
  );
  await afterSaved(over.saved, over.models ?? [], over.imageModelIds ?? []);
  return savedBodies;
};

const binding = (id) => ({
  id,
  contextWindow: 128_000,
  maxTokens: 8_192,
  thinkingLevels: [],
  defaultThinkingLevel: null,
});

const savedProvider = (over = {}) => ({
  id: "p",
  name: "My Gateway",
  enabled: true,
  hasSecret: true,
  hasOauth: false,
  authKind: "api_key_and_base_url",
  baseUrl: "https://gateway.example",
  models: [binding("gpt-image-2.5"), binding("chat")],
  ...over,
});

test("a chat default the save made unable to chat migrates to the served chat model", async () => {
  // The maintainer's repro: the default is p/gpt-image-2.5, unmarked before
  // this save; editing the provider marks it for image generation. The
  // pre-save memo carries no marking (here: empty), so only post-save state
  // can see it — and `chat` is still available.
  const saved = await runAfterSaved({
    saved: savedProvider(),
    imageModelIds: ["gpt-image-2.5"],
    settings: {
      defaultProviderId: "p",
      defaultModelId: "gpt-image-2.5",
      imageGeneration: null,
      imageGenerationModels: [],
    },
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].defaultProviderId, "p");
  assert.equal(saved[0].defaultModelId, "chat");
  // The marking itself lands in the picker list.
  assert.deepEqual(saved[0].imageGenerationModels, [
    { providerId: "p", modelId: "gpt-image-2.5" },
  ]);
  // Consistency with the send/menu rule: the migrated default passes exactly
  // the check Composer and launch use for a chat-eligible model.
  assert.equal(
    isImageOnlyChatModel(
      saved[0].imageGenerationModels,
      saved[0].defaultProviderId,
      saved[0].defaultModelId,
      undefined,
    ),
    false,
  );
});

test("a dual-capability image-marked model keeps its chat default", async () => {
  // Metadata says the row also outputs text, so even with the new marking
  // present post-save the default still chats — no migration happens.
  const saved = await runAfterSaved({
    saved: savedProvider({ models: [binding("vision-pro"), binding("chat")] }),
    imageModelIds: ["vision-pro"],
    // Even a wrongly pre-marked memo must not trigger a migration: the
    // decision comes from the post-save bindings plus metadata, not from it.
    imageGenerationCandidates: [{ providerId: "p", modelId: "vision-pro" }],
    providerModels: {
      p: [{ modelId: "vision-pro", modalities: { output: ["text", "image"] } }],
    },
    settings: {
      defaultProviderId: "p",
      defaultModelId: "vision-pro",
      imageGeneration: null,
      imageGenerationModels: [],
    },
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].defaultProviderId, "p");
  assert.equal(saved[0].defaultModelId, "vision-pro");
});

test("a default that cannot chat and has no replacement is left untouched", async () => {
  // The provider serves only the now image-only model: there is nothing to
  // migrate to, so the save keeps the stored default instead of silently
  // clearing or rewriting it — the user's own picks stay theirs.
  const saved = await runAfterSaved({
    saved: savedProvider({ models: [binding("gpt-image-2.5")] }),
    imageModelIds: ["gpt-image-2.5"],
    settings: {
      defaultProviderId: "p",
      defaultModelId: "gpt-image-2.5",
      imageGeneration: null,
      imageGenerationModels: [],
    },
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].defaultProviderId, "p");
  assert.equal(saved[0].defaultModelId, "gpt-image-2.5");
});
