import assert from "node:assert/strict";
import test from "node:test";

import {
  composerModelBadges,
  composerModelDisplayName,
  composerModelMatchesQuery,
  composerModelsForProvider,
} from "../src/lib/composer-models.ts";

const binding = (id) => ({
  id,
  contextWindow: 128_000,
  maxTokens: 8_192,
  thinkingLevels: [],
  defaultThinkingLevel: null,
});

const model = (modelId, displayName = modelId) => ({
  modelId,
  displayName,
  providerId: "mimo",
  capabilities: ["text"],
  source: "discovered",
});

test("Composer only lists models configured for the provider", () => {
  const models = composerModelsForProvider(
    {
      id: "mimo",
      models: [binding("claude-opus-4-6"), binding("x-ai/grok-4.6")],
    },
    [
      model("aws/claude-fable-5-006"),
      model("claude-opus-4-6", "Claude Opus 4.6"),
      model("x-ai/grok-4.6", "Grok 4.6"),
    ],
  );

  assert.deepEqual(
    models.map(({ modelId, displayName }) => ({ modelId, displayName })),
    [
      { modelId: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
      { modelId: "x-ai/grok-4.6", displayName: "Grok 4.6" },
    ],
  );
});

test("configured models remain selectable when discovery is unavailable", () => {
  const models = composerModelsForProvider(
    {
      id: "custom",
      models: [binding("my-model-v2")],
    },
    undefined,
  );

  assert.equal(models.length, 1);
  assert.equal(models[0].modelId, "my-model-v2");
  assert.equal(models[0].displayName, "my-model-v2");
});

test("legacy providers fall back to their default model binding", () => {
  const models = composerModelsForProvider(
    { id: "legacy", models: [], defaultModelId: "legacy-model" },
    [model("legacy-model", "Legacy model")],
  );

  assert.deepEqual(models.map((item) => item.modelId), ["legacy-model"]);
  assert.equal(models[0].displayName, "Legacy model");
});

test("a configured alias renames the composer row without changing its id", () => {
  const models = composerModelsForProvider(
    {
      id: "deepseek",
      models: [{ ...binding("deepseek-v4-pro"), alias: "  pro  " }],
    },
    [model("deepseek-v4-pro", "DeepSeek V4 Pro")],
  );

  assert.equal(models[0].modelId, "deepseek-v4-pro");
  assert.equal(models[0].displayName, "pro");
});

test("a configured alias is visible before discovery data is available", () => {
  const models = composerModelsForProvider(
    {
      id: "openai",
      models: [{ ...binding("gpt-5.3-codex-spark"), alias: "  Spark  " }],
    },
    undefined,
  );

  assert.equal(models[0].displayName, "Spark");
});

test("the selected label keeps its alias across equivalent model ids", () => {
  assert.equal(
    composerModelDisplayName(
      {
        id: "openai",
        models: [{ ...binding("openai/gpt-5.3-codex-spark"), alias: "Spark" }],
      },
      "gpt-5.3-codex-spark",
      "GPT-5.3 Codex Spark",
    ),
    "Spark",
  );
});

test("an exact binding alias wins over a broader equivalent id match", () => {
  assert.equal(
    composerModelDisplayName(
      {
        id: "openai",
        models: [
          { ...binding("gpt-5.3-codex-spark"), alias: "Base" },
          { ...binding("openai/gpt-5.3-codex-spark"), alias: "Namespaced" },
        ],
      },
      "openai/gpt-5.3-codex-spark",
      "GPT-5.3 Codex Spark",
    ),
    "Namespaced",
  );
});

test("a blank alias leaves the published display name alone", () => {
  const models = composerModelsForProvider(
    {
      id: "deepseek",
      models: [{ ...binding("deepseek-v4-pro"), alias: "   " }],
    },
    [model("deepseek-v4-pro", "DeepSeek V4 Pro")],
  );

  assert.equal(models[0].displayName, "DeepSeek V4 Pro");
});

test("composer model rows expose published reasoning and vision markers", () => {
  assert.deepEqual(
    composerModelBadges({
      modelId: "claude-opus-4-6",
      displayName: "Claude Opus 4.6",
      providerId: "anthropic",
      capabilities: ["text", "reasoning", "vision"],
      reasoning: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    }),
    ["reasoning", "vision"],
  );
  assert.deepEqual(
    composerModelBadges({
      modelId: "text-only",
      displayName: "Text only",
      providerId: "acme",
      capabilities: ["text"],
    }),
    [],
  );
});

test("composer model search matches id, name, family and provider", () => {
  const model = {
    modelId: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    providerId: "anthropic",
    family: "claude-4",
    capabilities: ["text"],
  };
  for (const query of ["opus", "CLAUDE-4", "Anthropic", "  "]) {
    assert.equal(
      composerModelMatchesQuery(model, "Anthropic", query),
      true,
      `expected ${JSON.stringify(query)} to match`,
    );
  }
  assert.equal(composerModelMatchesQuery(model, "Anthropic", "gemini"), false);
});
