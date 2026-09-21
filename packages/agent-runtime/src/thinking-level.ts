import type {
  ModelCost,
  ModelExperimentalMetadata,
  ModelInterleaved,
  ModelLimit,
  ModelModalities,
  ModelProviderMetadata,
  ModelReasoningOption,
  SessionThinkingLevel,
  ThinkingLevel,
} from "@pi-desktop/shared";

export type ThinkingCapabilitySet = {
  supportsReasoning: boolean;
  supportedThinkingLevels: readonly ThinkingLevel[];
};

/**
 * Serializable model metadata resolved in Electron main from models.dev.
 * pi-ai consumes this record through its selected transport adapter but does
 * not provide model names, limits, modalities, thinking levels, or prices.
 */
export type ModelConfig = {
  source: "models.dev" | "generic";
  name: string;
  baseUrl: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  reasoning: boolean;
  reasoningOptions?: ModelReasoningOption[];
  supportedThinkingLevels?: readonly ThinkingLevel[];
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  toolCall?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  knowledge?: string;
  releaseDate?: string;
  lastUpdated?: string;
  modalities?: ModelModalities;
  openWeights?: boolean;
  limit?: ModelLimit;
  cost?: ModelCost & {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  interleaved?: ModelInterleaved;
  status?: string;
  experimental?: ModelExperimentalMetadata;
  provider?: ModelProviderMetadata;
  /** Original models.dev provider metadata; kept separate from pi-ai's provider ID. */
  catalogProvider?: ModelProviderMetadata;
  /** Adapter-facing subset; models.dev modalities remain complete above. */
  input: Array<"text" | "image">;
  /** Published context window retained as a safety ceiling for user overrides. */
  catalogContextWindow?: number;
  contextWindow: number;
  maxTokens: number;
  /**
   * Opt-in for the provider-hosted web search tool. Set from the model
   * binding when the user enables native web search for this model; the
   * adapter attaches the vendor tool and extracts its stream blocks only
   * when this is true.
   */
  webSearch?: boolean;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  /**
   * Wire API pinned by the catalog for this model (e.g. "openai-responses").
   * When present it wins over the provider-wide apiStyle (see #105).
   */
  api?: string;
};

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Agent bookkeeping value: omit is stored as off so pi-ai does not synthesize a level. */
export function agentThinkingLevel(level: SessionThinkingLevel): ThinkingLevel {
  return level === "omit" ? "off" : level;
}

/** Null the Responses/simple-stream `off` fallback so omit sends no thinking field. */
export function omitThinkingModel<T extends { thinkingLevelMap?: Partial<Record<string, string | null>> }>(
  model: T,
): T {
  return {
    ...model,
    thinkingLevelMap: { ...model.thinkingLevelMap, off: null },
  };
}

/** Apply the canonical nearest-supported-level rule to catalog metadata. */
export function clampThinkingLevel(
  capabilities: ThinkingCapabilitySet,
  requested: SessionThinkingLevel,
): SessionThinkingLevel {
  if (!capabilities.supportsReasoning) return "off";
  if (requested === "omit") return "omit";
  const supported = new Set(capabilities.supportedThinkingLevels ?? ["off"]);
  if (supported.has(requested)) return requested;

  const requestedIndex = THINKING_LEVELS.indexOf(requested);
  for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index];
    if (supported.has(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index];
    if (supported.has(candidate)) return candidate;
  }
  return "off";
}
