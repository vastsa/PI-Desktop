import { describe, expect, it } from "vitest";
import {
  clampThinkingLevel,
  listPiCatalogModels,
  resolvePiModelConfig,
  resolvePiModelConfigForModelDraft,
  resolveThinkingCapabilities,
  resolveVisionCapability,
  type ModelCapabilities,
} from "./model-capabilities.js";
import type { ThinkingLevel } from "@pi-desktop/shared";

describe("pi-ai model resolution", () => {
  it("lists known native models for the Electron fallback catalog", () => {
    const models = listPiCatalogModels({
      vendorKey: "anthropic",
      apiStyle: "anthropic_messages",
    });
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((model) => model.modelId === "claude-opus-4-7")).toBe(true);
    expect(listPiCatalogModels({ vendorKey: "togetherai", apiStyle: "chat_completions" }).length).toBeGreaterThan(0);
    expect(listPiCatalogModels({ vendorKey: "custom", apiStyle: "chat_completions" })).toEqual([]);
  });

  it("uses pi-ai input metadata as the vision capability source", () => {
    expect(
      resolveVisionCapability({
        vendorKey: "openai",
        modelId: "gpt-5.1",
        apiStyle: "responses",
      }),
    ).toBe(true);
    expect(
      resolveVisionCapability({
        vendorKey: "custom",
        modelId: "unknown-model",
        apiStyle: "chat_completions",
      }),
    ).toBe(false);
  });

  it("uses the exact pi-ai catalog model and its supported levels", () => {
    const capabilities = resolveThinkingCapabilities({
      vendorKey: "openai",
      modelId: "gpt-5.1",
      apiStyle: "responses",
    });
    const model = resolvePiModelConfig({
      vendorKey: "openai",
      modelId: "gpt-5.1",
      apiStyle: "responses",
    });

    expect(capabilities).toEqual({
      supportsReasoning: true,
      supportedThinkingLevels: ["off", "low", "medium", "high"],
    });
    expect(model).toMatchObject({
      source: "pi",
      name: "GPT-5.1",
      reasoning: true,
      contextWindow: 400_000,
      maxTokens: 128_000,
      input: ["text", "image"],
    });
  });

  it("copies MiMo model limits, input modes, and wire compatibility", () => {
    const model = resolvePiModelConfig({
      vendorKey: "xiaomi",
      modelId: "mimo-v2.5",
    });

    expect(model).toMatchObject({
      source: "pi",
      reasoning: true,
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      input: ["text", "image"],
      compat: {
        thinkingFormat: "deepseek",
        requiresReasoningContentOnAssistantMessages: true,
      },
    });
  });

  it("resolves GPT-5.6 Luna context limits for Responses gateways", () => {
    const model = resolvePiModelConfig({
      vendorKey: "custom",
      modelId: "gpt-5.6-luna",
      apiStyle: "responses",
    });

    expect(model).toMatchObject({
      source: "pi",
      name: "GPT-5.6 Luna",
      contextWindow: 272_000,
      maxTokens: 128_000,
    });
  });

  it("prefills a chat-compatible gateway from the official OpenAI record", () => {
    const input = {
      vendorKey: "custom",
      modelId: "GPT-5.6-LUNA",
      apiStyle: "chat_completions",
    };
    const draftModel = resolvePiModelConfigForModelDraft(input);

    expect(draftModel).toMatchObject({
      source: "pi",
      name: "GPT-5.6 Luna",
      reasoning: true,
      contextWindow: 272_000,
      maxTokens: 128_000,
      thinkingLevelMap: {
        off: "none",
        low: "low",
        medium: "medium",
        high: "high",
      },
    });
    expect(resolvePiModelConfig(input)).toBeUndefined();
    expect(resolveThinkingCapabilities(input)).toEqual({
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    });

    expect(
      resolvePiModelConfigForModelDraft({
        vendorKey: "custom",
        modelId: "gpt-5.6-luna-custom",
        apiStyle: "chat_completions",
      }),
    ).toMatchObject({
      contextWindow: 272_000,
      maxTokens: 128_000,
    });
  });

  it("prefills DeepSeek metadata without requiring its catalog api", () => {
    const model = resolvePiModelConfigForModelDraft({
      vendorKey: "custom",
      modelId: "deepseek-v4-flash",
      apiStyle: "chat_completions",
    });

    expect(model).toMatchObject({
      name: "DeepSeek V4 Flash",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 384_000,
    });
  });

  it("does not use gateway-only catalog records for settings defaults", () => {
    expect(
      resolvePiModelConfigForModelDraft({
        vendorKey: "openrouter",
        modelId: "ai21/jamba-large-1.7",
        apiStyle: "chat_completions",
      }),
    ).toBeUndefined();
    expect(
      resolvePiModelConfigForModelDraft({
        vendorKey: "custom",
        modelId: "unknown-model",
        apiStyle: "chat_completions",
      }),
    ).toBeUndefined();
  });

  it("matches gateway alias ids by a separator boundary", () => {
    const model = resolvePiModelConfig({
      vendorKey: "custom",
      modelId: "mimo-v2.5-pro-think",
      apiStyle: "chat_completions",
    });

    expect(model?.name).toBe("MiMo-V2.5-Pro");
    expect(model?.compat?.thinkingFormat).toBe("deepseek");
    expect(
      resolvePiModelConfig({ vendorKey: "custom", modelId: "mimo-v2.50" }),
    ).toBeUndefined();
  });

  it("preserves adaptive Claude metadata exactly as pi publishes it", () => {
    const model = resolvePiModelConfig({
      vendorKey: "custom",
      modelId: "claude-opus-4-6",
      apiStyle: "anthropic_messages",
    });

    expect(model).toMatchObject({
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { max: "max" },
      compat: { forceAdaptiveThinking: true },
    });
  });

  it("resolves Claude Opus 5 limits and adaptive thinking from the pinned catalog", () => {
    const model = resolvePiModelConfig({
      vendorKey: "custom",
      modelId: "claude-opus-5",
      apiStyle: "anthropic_messages",
    });
    const capabilities = resolveThinkingCapabilities({
      vendorKey: "custom",
      modelId: "claude-opus-5",
      apiStyle: "anthropic_messages",
    });

    expect(model).toMatchObject({
      source: "pi",
      name: "Claude Opus 5",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      compat: { forceAdaptiveThinking: true },
    });
    expect(capabilities.supportsReasoning).toBe(true);
    expect(capabilities.supportedThinkingLevels).toEqual(
      expect.arrayContaining(["off", "xhigh", "max"]),
    );
  });

  it("keeps an unknown free-form model on the generic non-reasoning path", () => {
    const input = {
      vendorKey: "custom",
      modelId: "unknown-model",
      apiStyle: "chat_completions",
    };
    expect(resolvePiModelConfig(input)).toBeUndefined();
    expect(resolveThinkingCapabilities(input)).toEqual({
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    });
  });

  it("clamps sparse pi capability lists using the nearest supported level", () => {
    const capabilities: ModelCapabilities = {
      supportsReasoning: true,
      supportedThinkingLevels: ["off", "low", "high"] as ThinkingLevel[],
    };
    expect(clampThinkingLevel(capabilities, "minimal")).toBe("low");
    expect(clampThinkingLevel(capabilities, "max")).toBe("high");
  });
});
