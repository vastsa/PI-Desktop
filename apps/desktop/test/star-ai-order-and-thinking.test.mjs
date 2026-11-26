import assert from "node:assert/strict";
import test from "node:test";
import {
  initialThinkingLevelForBinding,
  initialThinkingLevelForUnmatchedModel,
  sortStarAiModels,
  starAiModelReleaseDate,
} from "@pi-desktop/shared";
import { composerModelsForProvider } from "../src/lib/composer-models.ts";

test("sortStarAiModels orders models by release date descending, groups effort variants, and prepends brand-new versioned models", () => {
  const gpt = [
    "codex-auto-review",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6.2-astra",
    "gpt-6.2-sol",
  ];
  assert.deepEqual(sortStarAiModels(gpt), [
    "gpt-6.2-astra",
    "gpt-6.2-sol",
    "gpt-6.1-terra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-astra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "codex-auto-review",
  ]);

  // A newly added model not yet in models.dev prepends to the top.
  assert.equal(sortStarAiModels([...gpt, "gpt-6.3-astra"])[0], "gpt-6.3-astra");

  // Gemini effort variants inherit their base model's release date and stay grouped.
  assert.equal(starAiModelReleaseDate("gemini-4-hydrogen-xhigh"), "2026-11-12");
  const gemini = [
    "gemini-3.5-flash-lite",
    "gemini-4-carbon-low",
    "gemini-4-carbon",
    "gemini-4-carbon-high",
    "gemini-4-hydrogen-low",
    "gemini-4-hydrogen-xhigh",
    "gemini-4-hydrogen",
    "gemini-4-hydrogen-high",
    "gemini-4-neon",
  ];
  assert.deepEqual(sortStarAiModels(gemini), [
    "gemini-4-neon",
    "gemini-4-hydrogen",
    "gemini-4-hydrogen-xhigh",
    "gemini-4-hydrogen-high",
    "gemini-4-hydrogen-low",
    "gemini-4-carbon",
    "gemini-4-carbon-high",
    "gemini-4-carbon-low",
    "gemini-3.5-flash-lite",
  ]);
});

test("composerModelsForProvider keeps StarAI models fixed newest-first regardless of active selection order", () => {
  const provider = {
    id: "starai-managed-gpt",
    defaultModelId: "gpt-5.6-sol",
    models: [
      { id: "gpt-5.6-sol", thinkingLevels: [] },
      { id: "gpt-6-astra", thinkingLevels: [] },
      { id: "gpt-6.2-astra", thinkingLevels: [] },
      { id: "gpt-6.1-terra", thinkingLevels: [] },
    ],
    starAiGroup: {
      id: "gpt满血渠道",
      chatModels: ["gpt-5.6-sol", "gpt-6-astra", "gpt-6.2-astra", "gpt-6.1-terra"],
    },
  };
  const rows = composerModelsForProvider(provider, undefined, null, false);
  assert.deepEqual(
    rows.map((r) => r.modelId),
    ["gpt-6.2-astra", "gpt-6.1-terra", "gpt-6-astra", "gpt-5.6-sol"],
  );
});

test("all reasoning-capable models default to high thinking level unless explicitly overridden", () => {
  assert.equal(
    initialThinkingLevelForBinding({ thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"] }),
    "high",
  );
  assert.equal(
    initialThinkingLevelForBinding(undefined, ["low", "medium", "high", "max"]),
    "high",
  );
  assert.equal(
    initialThinkingLevelForBinding(undefined, ["off", "low", "medium"]),
    "medium",
  );
  assert.equal(
    initialThinkingLevelForUnmatchedModel({ thinkingLevels: [] }),
    "high",
  );
  assert.equal(
    initialThinkingLevelForBinding({ thinkingLevels: ["off", "low", "high"], defaultThinkingLevel: "low" }),
    "low",
  );
  assert.equal(
    initialThinkingLevelForBinding({ thinkingLevels: ["off"] }),
    "off",
  );
});
