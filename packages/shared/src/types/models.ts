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

export const MODEL_VENDOR_PREFIXES = new Set([
  "amazon",
  "anthropic",
  "aws",
  "azure",
  "cohere",
  "deepseek",
  "deepseek-ai",
  "gemini",
  "google",
  "meta",
  "meta-llama",
  "minimax",
  "mistral",
  "moonshot",
  "moonshotai",
  "openai",
  "qwen",
  "tencent",
  "x-ai",
  "xai",
  "z-ai",
  "zai",
  "zhipuai",
]);

const THINKING_SUFFIX_REGEX = /[-:](?:thinking|think)$/i;
const ENDPOINT_SUFFIX_REGEX = /[-:](?:agent|latest)$/i;

function stripRegion(value: string): string {
  const at = value.indexOf("@");
  return at > 0 ? value.slice(0, at) : value;
}

export function stripThinkingSuffix(value: string): string {
  let current = value;
  while (THINKING_SUFFIX_REGEX.test(current)) {
    current = current.replace(THINKING_SUFFIX_REGEX, "");
  }
  return current;
}

export function stripEndpointSuffix(value: string): string {
  let current = value;
  while (ENDPOINT_SUFFIX_REGEX.test(current)) {
    current = current.replace(ENDPOINT_SUFFIX_REGEX, "");
  }
  return current;
}

export function stripVariantSuffix(value: string): string {
  let current = value;
  let changed = true;
  while (changed) {
    const next = current
      .replace(THINKING_SUFFIX_REGEX, "")
      .replace(ENDPOINT_SUFFIX_REGEX, "");
    changed = next !== current;
    current = next;
  }
  return current;
}

function canonicalVendor(prefix: string): string {
  if (prefix === "deepseek-ai") return "deepseek";
  if (prefix === "gemini") return "google";
  if (prefix === "x-ai") return "xai";
  if (prefix === "z-ai" || prefix === "zhipuai") return "zai";
  if (prefix === "moonshotai") return "moonshot";
  if (prefix === "meta-llama") return "meta";
  if (prefix === "aws") return "amazon";
  return prefix;
}

function extractKnownVendor(id: string): string | undefined {
  const parts = id.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (MODEL_VENDOR_PREFIXES.has(part)) return canonicalVendor(part);
  }

  const lastPart = parts[parts.length - 1];
  for (const prefix of MODEL_VENDOR_PREFIXES) {
    if (lastPart === prefix || lastPart.startsWith(`${prefix}-`) || lastPart.startsWith(`${prefix}.`)) {
      return canonicalVendor(prefix);
    }
  }
  return undefined;
}

function pathLeaf(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

function exactPathAliasMatch(left: string, right: string): boolean {
  // Two independently routed paths cannot be identified by their leaf alone.
  if (left.includes("/") === right.includes("/")) return false;
  if (pathLeaf(left) !== pathLeaf(right)) return false;

  const leftVendor = extractKnownVendor(left);
  const rightVendor = extractKnownVendor(right);
  return !leftVendor || !rightVendor || leftVendor === rightVendor;
}

function normalizedMatch(left: string, right: string, allowPathLeaf = false): boolean {
  const leftVendor = extractKnownVendor(left);
  const rightVendor = extractKnownVendor(right);
  if (leftVendor && rightVendor && leftVendor !== rightVendor) return false;
  if (left === right) return true;
  if (left.endsWith(`/${right}`) || right.endsWith(`/${left}`)) return true;

  for (const separator of ["-", "."] as const) {
    for (const prefix of MODEL_VENDOR_PREFIXES) {
      if (left === `${prefix}${separator}${right}`) return true;
      if (right === `${prefix}${separator}${left}`) return true;
    }
  }

  return allowPathLeaf && exactPathAliasMatch(left, right);
}

/** Compare configured binding IDs without collapsing distinct route paths or variants. */
export function modelIdsMatch(candidate: string, requested: string): boolean {
  const left = candidate.trim().toLowerCase();
  const right = requested.trim().toLowerCase();
  if (!left || !right) return false;
  if (left.includes("@") && right.includes("@") && left !== right) return false;
  return normalizedMatch(stripRegion(left), stripRegion(right));
}

/** Broader metadata-only aliases; never use for configured binding identity. */
export function catalogModelIdsMatch(candidate: string, requested: string): boolean {
  const left = candidate.trim().toLowerCase();
  const right = requested.trim().toLowerCase();
  if (!left || !right) return false;

  const cleanLeft = stripRegion(left);
  const cleanRight = stripRegion(right);
  if (normalizedMatch(cleanLeft, cleanRight, true)) return true;

  const strippedLeft = stripVariantSuffix(cleanLeft);
  const strippedRight = stripVariantSuffix(cleanRight);
  if (strippedLeft === cleanLeft && strippedRight === cleanRight) return false;
  return normalizedMatch(strippedLeft, strippedRight, true);
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
  catalogSource?: "models.dev";
};

/**
 * Built-in themes, or `plugin:<pluginId>:<themeId>` for a theme contributed by
 * a plugin. The shell falls back to `system` when the provider goes away.
 */
