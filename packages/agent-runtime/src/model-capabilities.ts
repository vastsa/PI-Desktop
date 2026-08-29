import type { ModelBinding, ModelInfo, ThinkingLevel } from "@pi-desktop/shared";
import type { ModelConfig, ThinkingCapabilitySet } from "./thinking-level.js";

export {
  clampThinkingLevel,
  type ModelConfig,
  type ThinkingCapabilitySet,
} from "./thinking-level.js";

export type ModelCapabilities = ThinkingCapabilitySet;
/** Compatibility name used by Electron main and existing runtime callers. */
export type ThinkingCapabilities = ModelCapabilities;

/** Resolve reasoning capability from the model metadata supplied by main. */
export function capabilitiesFromModelConfig(
  model?: Pick<ModelConfig, "reasoning" | "supportedThinkingLevels"> | null,
): ModelCapabilities {
  if (!model?.reasoning) {
    return {
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    };
  }
  return {
    supportsReasoning: true,
    supportedThinkingLevels: model.supportedThinkingLevels?.length
      ? [...model.supportedThinkingLevels]
      : ["low", "medium", "high"],
  };
}

/** Resolve image transport from the full models.dev input modalities. */
export function visionFromModelConfig(
  model?: Pick<ModelConfig, "modalities" | "input"> | null,
): boolean {
  return model?.modalities?.input.includes("image") === true ||
    model?.input.includes("image") === true;
}

/** Map a public catalog row to the capability shape used by settings helpers. */
export function capabilitiesFromModelInfo(model?: ModelInfo | null): ModelCapabilities {
  if (!model?.reasoning) {
    return {
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    };
  }
  return {
    supportsReasoning: true,
    supportedThinkingLevels: model.supportedThinkingLevels?.length
      ? [...model.supportedThinkingLevels]
      : ["low", "medium", "high"],
  };
}

/**
 * Apply explicit per-provider model settings without expanding published
 * capabilities. Limits come from the user's binding; thinking levels are the
 * intersection of that binding and the models.dev-supported levels.
 */
export function modelConfigWithBinding(
  model: ModelConfig,
  binding?: Pick<ModelBinding, "contextWindow" | "maxTokens" | "thinkingLevels"> | null,
): ModelConfig {
  if (!binding) return model;
  const published = capabilitiesFromModelConfig(model);
  const enabledThinkingLevels = [...new Set(binding.thinkingLevels)].filter((level) =>
    published.supportedThinkingLevels.includes(level),
  );
  return {
    ...model,
    contextWindow: binding.contextWindow,
    maxTokens: binding.maxTokens,
    reasoning: published.supportsReasoning && enabledThinkingLevels.length > 0,
    supportedThinkingLevels: enabledThinkingLevels,
  };
}

/**
 * Unknown IDs remain runnable without invented catalog semantics. This is a
 * transport-safe generic shape, not a second model catalog.
 */
export function genericModelConfig(
  modelId: string,
  baseUrl = "",
): ModelConfig {
  return {
    source: "generic",
    name: modelId,
    baseUrl,
    reasoning: false,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 128_000, input: 128_000, output: 8_192 },
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 8_192,
    supportedThinkingLevels: [],
  };
}
