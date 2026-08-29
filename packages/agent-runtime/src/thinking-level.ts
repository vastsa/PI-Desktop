import type {
  ModelCost,
  ModelInterleaved,
  ModelLimit,
  ModelModalities,
  ModelReasoningOption,
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
  experimental?: boolean;
  provider?: string;
  /** Adapter-facing subset; models.dev modalities remain complete above. */
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
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

/** Apply the canonical nearest-supported-level rule to catalog metadata. */
export function clampThinkingLevel(
  capabilities: ThinkingCapabilitySet,
  requested: ThinkingLevel,
): ThinkingLevel {
  if (!capabilities.supportsReasoning) return "off";
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
