import { clampThinkingLevel as clampPiThinkingLevel, type Api, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type {
  ModelCost,
  ModelExperimentalMetadata,
  ModelInterleaved,
  ModelLimit,
  ModelModalities,
  ModelProviderMetadata,
  ModelReasoningOption,
  SessionThinkingLevel,
  ThinkingProtocol,
  ThinkingLevel,
} from "@pi-desktop/shared";

export type ThinkingCapabilitySet = {
  supportsReasoning: boolean;
  supportedThinkingLevels: readonly ThinkingLevel[];
};

/**
 * Serializable projection of the account's effective Pi chat model.
 * Legacy source tags remain readable; no legacy catalog is consulted.
 */
export type ModelConfig = {
  source: "pi" | "models.dev" | "generic";
  inputLimits?: Model<Api>["inputLimits"];
  promptCache?: Model<Api>["promptCache"];
  samplingParams?: Model<Api>["samplingParams"];
  name: string;
  baseUrl: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  reasoning: boolean;
  reasoningOptions?: ModelReasoningOption[];
  thinkingProtocol?: ThinkingProtocol;
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
  /** Pi's native request pricing, including tiers; never reconstruct it from UI prices. */
  nativeCost?: Model<Api>["cost"];
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

/** Normalize only after resolving the physical request model; never mutate preferences. */
export function effectiveThinkingLevel(
  model: Model<Api>,
  requested: SessionThinkingLevel,
): SessionThinkingLevel {
  return requested === "omit" ? "omit" : clampPiThinkingLevel(model, requested);
}

/** Simple requests encode off by omitting reasoning, unlike Agent bookkeeping. */
export function requestThinkingLevel(
  model: Model<Api>,
  requested: SessionThinkingLevel,
): SimpleStreamOptions["reasoning"] {
  const effective = effectiveThinkingLevel(model, requested);
  return effective === "off" || effective === "omit" ? undefined : effective;
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
