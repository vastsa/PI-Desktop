import {
  capabilitiesFromModelConfig,
  capabilitiesFromModelInfo,
  clampThinkingLevel,
  genericModelConfig,
  modelConfigWithBinding,
  visionFromModelConfig,
  type ModelCapabilities,
} from "./model-capabilities.js";
import { describe, expect, it } from "vitest";
import type { ModelInfo, ThinkingLevel } from "@pi-desktop/shared";
import type { ModelConfig } from "./thinking-level.js";

function knownModel(): ModelConfig {
  return {
    ...genericModelConfig("claude-opus-4.6", "https://api.anthropic.com"),
    source: "models.dev" as const,
    name: "Claude 4.6 Opus",
    reasoning: true,
    supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"] as ThinkingLevel[],
    modalities: {
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
  };
}

describe("main-supplied model capabilities", () => {
  it("uses models.dev modalities for visual transport", () => {
    expect(visionFromModelConfig(knownModel())).toBe(true);
    expect(
      visionFromModelConfig({
        ...genericModelConfig("text-only"),
        modalities: { input: ["text"], output: ["text"] },
      }),
    ).toBe(false);
  });

  it("uses the published reasoning levels without consulting a model catalog", () => {
    expect(capabilitiesFromModelConfig(knownModel())).toEqual({
      supportsReasoning: true,
      supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(capabilitiesFromModelConfig(genericModelConfig("unknown"))).toEqual({
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    });
  });

  it("projects a public models.dev row to the same capability shape", () => {
    const info: ModelInfo = {
      modelId: "model",
      displayName: "Model",
      providerId: "provider",
      modalities: { input: ["text"], output: ["text"] },
      reasoning: true,
      supportedThinkingLevels: ["off", "high"],
      capabilities: ["text", "reasoning"],
      source: "discovered",
      catalogSource: "models.dev",
    };
    expect(capabilitiesFromModelInfo(info)).toEqual({
      supportsReasoning: true,
      supportedThinkingLevels: ["off", "high"],
    });
  });

  it("keeps unknown models on the generic non-reasoning shape", () => {
    const config = genericModelConfig("unknown-model", "https://gateway.example/v1");
    expect(config).toMatchObject({
      source: "generic",
      name: "unknown-model",
      reasoning: false,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 128_000, input: 128_000, output: 8_192 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
  });

  it("applies binding limits and intersects enabled thinking levels", () => {
    const configured = modelConfigWithBinding(knownModel(), {
      contextWindow: 64_000,
      maxTokens: 4_000,
      thinkingLevels: ["off", "low", "max"],
    });
    expect(configured.contextWindow).toBe(64_000);
    expect(configured.maxTokens).toBe(4_000);
    expect(configured.reasoning).toBe(true);
    expect(configured.supportedThinkingLevels).toEqual(["low", "max"]);

    const unknown = modelConfigWithBinding(genericModelConfig("unknown"), {
      contextWindow: 16_000,
      maxTokens: 2_000,
      thinkingLevels: ["high"],
    });
    expect(unknown.reasoning).toBe(false);
    expect(unknown.supportedThinkingLevels).toEqual([]);
  });

  it("clamps sparse catalog capability lists using the nearest supported level", () => {
    const capabilities: ModelCapabilities = {
      supportsReasoning: true,
      supportedThinkingLevels: ["off", "low", "high"] as ThinkingLevel[],
    };
    expect(clampThinkingLevel(capabilities, "minimal")).toBe("low");
    expect(clampThinkingLevel(capabilities, "max")).toBe("high");
  });
});
