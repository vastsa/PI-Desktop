/** Shared public types grouped by the owning application domain. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
/**
 * Session and subagent selector values. `omit` leaves the provider default
 * untouched and is not a catalog/binding capability.
 */
export const SESSION_THINKING_LEVELS = [...THINKING_LEVELS, "omit"] as const;
export type SessionThinkingLevel = (typeof SESSION_THINKING_LEVELS)[number];
export const SUBAGENT_THINKING_LEVELS = SESSION_THINKING_LEVELS;
export type SubagentThinkingLevel = SessionThinkingLevel;

export type ModelProviderMetadata = string | Record<string, unknown>;
export type ModelExperimentalMetadata = boolean | Record<string, unknown>;

const MODEL_VENDOR_PREFIXES = new Set([
  "anthropic",
  "amazon",
  "aws",
  "cohere",
  "deepseek",
  "deepseek-ai",
  "gemini",
  "google",
  "meta",
  "minimax",
  "mistral",
  "moonshot",
  "moonshotai",
  "openai",
  "qwen",
  "z-ai",
  "zai",
  "zhipuai",
  "x-ai",
  "xai",
]);

/** Match a configured model ID with a namespaced models.dev ID. */
export function modelIdsMatch(candidate: string, requested: string): boolean {
  const left = candidate.trim().toLowerCase();
  const right = requested.trim().toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.endsWith(`/${right}`) || right.endsWith(`/${left}`)) return true;
  // Some providers use `model@region` aliases; the base model remains the
  // same published record for matching purposes.
  if (left.startsWith(`${right}@`) || right.startsWith(`${left}@`)) return true;
  for (const separator of ["-", "."] as const) {
    const leftPrefix = left.split(`${separator}${right}`, 1)[0];
    if (
      left.startsWith(`${leftPrefix}${separator}${right}`) &&
      MODEL_VENDOR_PREFIXES.has(leftPrefix)
    ) {
      return true;
    }
    const rightPrefix = right.split(`${separator}${left}`, 1)[0];
    if (
      right.startsWith(`${rightPrefix}${separator}${left}`) &&
      MODEL_VENDOR_PREFIXES.has(rightPrefix)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Where a saved context window came from.
 *
 * `catalog` is a metadata snapshot: the value follows the published models.dev
 * record, so a later catalog correction still reaches an already saved binding.
 * `user` is the user's own number and is never overwritten by the catalog.
 */
export type ContextWindowSource = "catalog" | "user";

/** Provider-local model settings persisted with the provider configuration. */
export type ModelBinding = {
  id: string;
  /** Optional display alias. When set it names the model everywhere the UI
   * shows a model label; the id remains the wire identity. */
  alias?: string;
  contextWindow: number;
  /** Provenance of `contextWindow`. Absent on records written before the
   * marker existed; readers then apply the historical rule documented on
   * `effectiveContextWindow`. */
  contextWindowSource?: ContextWindowSource;
  maxTokens: number;
  thinkingLevels: ThinkingLevel[];
  /** Canonical enabled level, or `omit` when new sessions should send no override. */
  defaultThinkingLevel: SessionThinkingLevel | null;
  /**
   * User override for image input. `null` or absent follows the published
   * models.dev capability; `true` forces image transport on for an endpoint the
   * catalog describes too narrowly, `false` keeps images out of the request.
   */
  supportsImages?: boolean | null;
  /**
   * User override for document (PDF) input, with the same three-state meaning.
   * Documents are still transported as bounded file references, so this records
   * the capability the model actually has rather than switching the encoding.
   */
  supportsDocuments?: boolean | null;
  /**
   * Whether this model is available for AI-driven subagent delegation.
   * When true, the model appears in the delegation model catalog so the
   * parent agent can pick it at Task time. Defaults to false (opt-in).
   */
  availableForSubagents?: boolean;
  /**
   * Opt-in for attaching the provider-hosted web search tool to requests for
   * this model. Absent/false keeps the tool off. There is no catalog default:
   * models.dev does not publish hosted-tool capability, so the user's own
   * knowledge of the endpoint is the only source.
   */
  nativeWebSearch?: boolean;
};

export const MODEL_MODALITIES = ["text", "image", "audio", "video", "pdf"] as const;
export type ModelModality = (typeof MODEL_MODALITIES)[number];

export type ModelReasoningOption = {
  type: string;
  values?: Array<string | null>;
  min?: number;
  max?: number;
};

export type ModelInterleaved = boolean | { field?: string };

export type ModelModalities = {
  input: readonly ModelModality[];
  output: readonly ModelModality[];
};

export type ModelLimit = {
  context?: number;
  input?: number;
  output?: number;
};

export type ModelCostTier = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tier?: { type?: string; size?: number };
};

export type ModelCost = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  inputAudio?: number;
  outputAudio?: number;
  contextOver200k?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  tiers?: ModelCostTier[];
};

export type ModelInfo = {
  modelId: string;
  displayName: string;
  providerId: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  reasoningOptions?: ModelReasoningOption[];
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
  cost?: ModelCost;
  interleaved?: ModelInterleaved;
  status?: string;
  /** Provider-local upstream metadata, including models.dev adapter details. */
  provider?: ModelProviderMetadata;
  /** Model metadata extension published by models.dev. */
  experimental?: ModelExperimentalMetadata;
  /** Convenience values retained for existing UI and cache consumers. */
  contextWindow?: number;
  maxTokens?: number;
  capabilities: Array<
    | "text"
    | "tools"
    | "vision"
    | "reasoning"
    | "json"
    | "audio"
    | "video"
    | "pdf"
    | "attachments"
    | "temperature"
  >;
  supportedThinkingLevels?: ThinkingLevel[];
  source: "bundled" | "discovered" | "user";
  /** Metadata catalog that supplied this row, when it is a known model. */
  catalogSource?: "models.dev" | "provider";
};

/**
 * Built-in themes, or `plugin:<pluginId>:<themeId>` for a theme contributed by
 * a plugin. The shell falls back to `system` when the provider goes away.
 */
