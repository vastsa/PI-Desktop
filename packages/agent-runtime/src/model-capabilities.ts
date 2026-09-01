import {
  THINKING_LEVELS,
  type ModelBinding,
  type ModelInfo,
  type ModelModality,
  type ThinkingLevel,
} from "@pi-desktop/shared";
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
 * Apply explicit per-provider model settings. Limits and thinking levels come
 * from the user's binding; the catalog only seeds a new binding and supplies
 * the published baseline shown in metadata surfaces.
 */
export function modelConfigWithBinding(
  model: ModelConfig,
  binding?:
    | Pick<
        ModelBinding,
        | "contextWindow"
        | "maxTokens"
        | "thinkingLevels"
        | "supportsImages"
        | "supportsDocuments"
      >
    | null,
): ModelConfig {
  if (!binding) return model;
  const enabledThinkingLevels = THINKING_LEVELS.filter((level) =>
    binding.thinkingLevels.includes(level),
  );
  return {
    ...model,
    contextWindow: binding.contextWindow,
    maxTokens: binding.maxTokens,
    reasoning: enabledThinkingLevels.some((level) => level !== "off"),
    supportedThinkingLevels: enabledThinkingLevels,
    ...modalityOverride(model, binding),
  };
}

/**
 * Apply the binding's attachment overrides to the adapter-facing modality
 * arrays. Unlike thinking levels these are not narrowed to what models.dev
 * published: a self-hosted or proxied endpoint routinely accepts images the
 * catalog entry does not mention, and refusing the override would leave the user
 * with a switch that does nothing. `null`/absent still follows the catalog.
 */
function modalityOverride(
  model: ModelConfig,
  binding: Pick<ModelBinding, "supportsImages" | "supportsDocuments">,
): Partial<ModelConfig> {
  const images = binding.supportsImages;
  const documents = binding.supportsDocuments;
  if (typeof images !== "boolean" && typeof documents !== "boolean") return {};
  const publishedInput = model.modalities?.input ?? [];
  const nextInput = new Set<ModelModality>(publishedInput);
  if (typeof images === "boolean") {
    if (images) nextInput.add("image");
    else nextInput.delete("image");
  }
  if (typeof documents === "boolean") {
    if (documents) nextInput.add("pdf");
    else nextInput.delete("pdf");
  }
  nextInput.add("text");
  const input = [...nextInput];
  return {
    modalities: {
      input,
      output: model.modalities?.output ?? ["text"],
    },
    // The adapter subset carries only what pi-ai can encode as a content block.
    input: input.filter(
      (modality): modality is "text" | "image" =>
        modality === "text" || modality === "image",
    ),
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
