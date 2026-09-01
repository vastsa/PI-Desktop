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

  it("applies binding limits and preserves explicit thinking levels", () => {
    const configured = modelConfigWithBinding(knownModel(), {
      contextWindow: 64_000,
      maxTokens: 4_000,
      thinkingLevels: ["off", "minimal", "low", "max"],
    });
    expect(configured.contextWindow).toBe(64_000);
    expect(configured.maxTokens).toBe(4_000);
    expect(configured.reasoning).toBe(true);
    expect(configured.supportedThinkingLevels).toEqual([
      "off",
      "minimal",
      "low",
      "max",
    ]);

    const unknown = modelConfigWithBinding(genericModelConfig("unknown"), {
      contextWindow: 16_000,
      maxTokens: 2_000,
      thinkingLevels: ["high"],
    });
    expect(unknown.reasoning).toBe(true);
    expect(unknown.supportedThinkingLevels).toEqual(["high"]);

    const cataloguedNonReasoning = modelConfigWithBinding(
      {
        ...genericModelConfig("catalogued-chat"),
        source: "models.dev" as const,
        reasoning: false,
        supportedThinkingLevels: [],
      },
      {
        contextWindow: 16_000,
        maxTokens: 2_000,
        thinkingLevels: ["medium"],
      },
    );
    expect(cataloguedNonReasoning.reasoning).toBe(true);
    expect(cataloguedNonReasoning.supportedThinkingLevels).toEqual(["medium"]);
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

describe("binding attachment capability overrides", () => {
  const baseBinding = {
    contextWindow: 200_000,
    maxTokens: 32_000,
    thinkingLevels: ["medium"] as ThinkingLevel[],
  };

  it("follows the published modalities when no override is stored", () => {
    const config = modelConfigWithBinding(knownModel(), {
      ...baseBinding,
      supportsImages: null,
      supportsDocuments: null,
    });
    expect(config.modalities?.input).toEqual(["text", "image", "pdf"]);
    expect(visionFromModelConfig(config)).toBe(true);
  });

  it("turns image transport off for a vision model the user opted out of", () => {
    const config = modelConfigWithBinding(knownModel(), {
      ...baseBinding,
      supportsImages: false,
    });
    expect(config.modalities?.input).not.toContain("image");
    expect(config.input).not.toContain("image");
    expect(visionFromModelConfig(config)).toBe(false);
  });

  it("grants image transport to a model the catalog calls text-only", () => {
    // A proxied endpoint routinely accepts input its catalog entry omits, so the
    // override is applied rather than narrowed to the published capability.
    const textOnly = {
      ...genericModelConfig("proxy-model", "https://proxy.test/v1"),
      modalities: { input: ["text"] as const, output: ["text"] as const },
    };
    const config = modelConfigWithBinding(textOnly, {
      ...baseBinding,
      supportsImages: true,
    });
    expect(config.modalities?.input).toContain("image");
    expect(config.input).toContain("image");
    expect(visionFromModelConfig(config)).toBe(true);
  });

  it("records a document override without adding an untransportable modality to the adapter subset", () => {
    const config = modelConfigWithBinding(knownModel(), {
      ...baseBinding,
      supportsDocuments: false,
    });
    expect(config.modalities?.input).not.toContain("pdf");
    // pi-ai has no PDF content block, so the adapter subset never carried it.
    expect(config.input).toEqual(["text", "image"]);
  });

  it("keeps text input even when every override is off", () => {
    const config = modelConfigWithBinding(knownModel(), {
      ...baseBinding,
      supportsImages: false,
      supportsDocuments: false,
    });
    expect(config.modalities?.input).toEqual(["text"]);
    expect(config.input).toEqual(["text"]);
  });

  it("leaves limits and explicit thinking levels untouched by a capability override", () => {
    const config = modelConfigWithBinding(knownModel(), {
      ...baseBinding,
      thinkingLevels: ["medium", "off"] as ThinkingLevel[],
      supportsImages: true,
    });
    expect(config.contextWindow).toBe(200_000);
    expect(config.maxTokens).toBe(32_000);
    expect(config.supportedThinkingLevels).toEqual(["off", "medium"]);
  });
});
