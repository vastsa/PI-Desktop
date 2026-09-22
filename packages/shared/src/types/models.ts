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
  /** Dynamic context gate (D447): the share of the hard limit at which old tool
   * results start being narrowed. Absent means the shipped behaviour; the
   * runtime falls back to `defaultDynamicContextPercent(contextWindow)`. */
  dynamicContext?: ModelDynamicContext;
  /** Early background compaction (ADR 0301): the share of the hard limit at
   * which an idle session compacts in the background, how long it must be idle,
   * and whether a successful pass is silent. Absent means the shipped defaults. */
  earlyCompaction?: ModelEarlyCompaction;
  /** Sleep-time digest (ADR 0301): off unless turned on. */
  sleepTime?: ModelSleepTime;
};

export type ModelDynamicContext = {
  enabled: boolean;
  /** 40–95; below the floor a session starts shedding while still roomy, above
   * the ceiling the narrowing can no longer happen before the hard limit. */
  thresholdPercent: number;
};

/** Gate bounds shared by the settings slider and the runtime clamp. */
export const DYNAMIC_CONTEXT_MIN_PERCENT = 40;
export const DYNAMIC_CONTEXT_MAX_PERCENT = 95;
/** Used when a binding predates the setting. */
export const DYNAMIC_CONTEXT_DEFAULT_PERCENT = 60;

/**
 * The default gate for a window, per the plan's "reserve one task's worth of
 * room" rule: `100% − max(100k, 15% × window) / window`, clamped to the bounds.
 * A larger window reserves proportionally less, so its gate sits higher (less
 * narrowing, later); small windows are held at the floor.
 */
export function defaultDynamicContextPercent(contextWindow: number): number {
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0;
  if (window <= 0) return DYNAMIC_CONTEXT_DEFAULT_PERCENT;
  const reserved = Math.max(100_000, window * 0.15);
  const percent = Math.round(100 - (reserved / window) * 100);
  return clampDynamicContextPercent(percent);
}

export function clampDynamicContextPercent(percent: number): number {
  if (!Number.isFinite(percent)) return DYNAMIC_CONTEXT_DEFAULT_PERCENT;
  return Math.min(
    DYNAMIC_CONTEXT_MAX_PERCENT,
    Math.max(DYNAMIC_CONTEXT_MIN_PERCENT, Math.round(percent)),
  );
}
/**
 * Early background compaction: the share of the hard limit at
 * which a settled, idle session compacts itself in the background, instead of
 * waiting for the next prompt to hit the hard limit on the critical path.
 *
 * Absent means "the defaults" (`defaultEarlyCompaction`): the pass runs at 75 %
 * of the hard limit after 120 s without activity, and a *successful* background
 * pass stays out of the toast channel — the transcript row, the context
 * inspector and `recall` remain, so the compaction is discoverable rather than
 * hidden. `silent: false` restores the warning toast; `enabled: false` turns
 * the background pass off entirely; the inline hard-limit path is unaffected by
 * all three and always warns.
 */
export type ModelEarlyCompaction = {
  enabled: boolean;
  /** 50–95; below the floor a session compacts while still roomy, above the
   * ceiling the pass can no longer beat the hard limit to the punch. */
  thresholdPercent: number;
  /** Idle seconds before the pass runs; any new prompt cancels it. */
  delaySeconds: number;
  /** Keep a successful background pass out of the toast channel. */
  silent: boolean;
};

/** Early-compaction bounds shared by the settings controls and the runtime. */
export const EARLY_COMPACTION_MIN_PERCENT = 50;
export const EARLY_COMPACTION_MAX_PERCENT = 95;
export const EARLY_COMPACTION_DEFAULT_PERCENT = 75;
export const EARLY_COMPACTION_MIN_DELAY_SECONDS = 15;
export const EARLY_COMPACTION_MAX_DELAY_SECONDS = 900;
export const EARLY_COMPACTION_DEFAULT_DELAY_SECONDS = 120;
export const EARLY_COMPACTION_DEFAULT_SILENT = true;

export function clampEarlyCompactionPercent(percent: number): number {
  if (!Number.isFinite(percent)) return EARLY_COMPACTION_DEFAULT_PERCENT;
  return Math.min(
    EARLY_COMPACTION_MAX_PERCENT,
    Math.max(EARLY_COMPACTION_MIN_PERCENT, Math.round(percent)),
  );
}

export function clampEarlyCompactionDelaySeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return EARLY_COMPACTION_DEFAULT_DELAY_SECONDS;
  return Math.min(
    EARLY_COMPACTION_MAX_DELAY_SECONDS,
    Math.max(EARLY_COMPACTION_MIN_DELAY_SECONDS, Math.round(seconds)),
  );
}

/** The settings a binding without `earlyCompaction` is compiled against. */
export function defaultEarlyCompaction(): ModelEarlyCompaction {
  return {
    enabled: true,
    thresholdPercent: EARLY_COMPACTION_DEFAULT_PERCENT,
    delaySeconds: EARLY_COMPACTION_DEFAULT_DELAY_SECONDS,
    silent: EARLY_COMPACTION_DEFAULT_SILENT,
  };
}

/** Sleep-time digest: a deterministic record of where the session stands,
    written while the session is idle and a compaction is still ahead of it.

    It is **off by default** and it never calls a provider: the digest is
    extracted from the transcript by the same deterministic pass the degradation
    ladder uses, so a summary request that never comes back still leaves the next
    window with the goal, the unresolved failures and the stated next step —
    captured *before* the attempt instead of after it. The only cost is a bounded
    amount of transcript, which is why the quota exists. */
export type ModelSleepTime = {
  enabled: boolean;
  /** 1–12 digest runs per hour of session time. */
  maxRunsPerHour: number;
};

export const SLEEP_TIME_MIN_RUNS_PER_HOUR = 1;
export const SLEEP_TIME_MAX_RUNS_PER_HOUR = 12;
export const SLEEP_TIME_DEFAULT_RUNS_PER_HOUR = 2;

export function clampSleepTimeRunsPerHour(runs: number): number {
  if (!Number.isFinite(runs)) return SLEEP_TIME_DEFAULT_RUNS_PER_HOUR;
  return Math.min(
    SLEEP_TIME_MAX_RUNS_PER_HOUR,
    Math.max(SLEEP_TIME_MIN_RUNS_PER_HOUR, Math.round(runs)),
  );
}

/** The settings a binding without `sleepTime` is compiled against: off. */
export function defaultSleepTime(): ModelSleepTime {
  return {
    enabled: false,
    maxRunsPerHour: SLEEP_TIME_DEFAULT_RUNS_PER_HOUR,
  };
}

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
