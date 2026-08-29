/**
 * Shared contract for the models.dev-driven model configuration surface.
 *
 * The desktop app treats models.dev as the single source of provider and model
 * metadata. This module owns the vocabulary both sides of the IPC boundary
 * agree on: what a catalog provider preset looks like, how a model search
 * request and its result rows are shaped, and how a published `npm` adapter
 * maps onto the wire API style the runtime speaks.
 *
 * Nothing here performs I/O, so the renderer, the Electron main process and the
 * tests share one implementation instead of re-deriving capability and
 * formatting rules per surface.
 */

import type { ModelBinding, ModelInfo, ThinkingLevel } from "./types.js";

/** Wire protocol a provider row speaks. Mirrors the runtime adapter list. */
export const API_STYLES = [
  "chat_completions",
  "responses",
  "anthropic_messages",
  "google_generative_ai",
  "openai_codex_responses",
  "pi_messages",
  "opencode_go",
] as const;

export type CatalogApiStyle = (typeof API_STYLES)[number];

/**
 * models.dev publishes an `npm` adapter package per provider. That value is the
 * most reliable published signal for which wire API a provider speaks, so the
 * setup flow derives the API style from it instead of asking the user to guess.
 */
const ADAPTER_API_STYLES: ReadonlyArray<readonly [string, CatalogApiStyle]> = [
  ["@ai-sdk/google-vertex/anthropic", "anthropic_messages"],
  ["@ai-sdk/anthropic", "anthropic_messages"],
  ["@ai-sdk/google-vertex", "google_generative_ai"],
  ["@ai-sdk/google", "google_generative_ai"],
  ["@ai-sdk/openai", "responses"],
];

/**
 * Resolve the wire style for a published adapter package. Unknown and
 * OpenAI-compatible adapters fall back to chat completions, the broadest
 * interoperable surface.
 */
export function apiStyleForAdapter(npm?: string | null): CatalogApiStyle {
  const adapter = (npm ?? "").trim().toLowerCase();
  if (!adapter) return "chat_completions";
  for (const [name, style] of ADAPTER_API_STYLES) {
    if (adapter === name) return style;
  }
  return "chat_completions";
}

/** One provider published by models.dev, offered as a setup preset. */
export type CatalogProviderPreset = {
  /** models.dev provider key, e.g. `anthropic`. */
  providerKey: string;
  /** Display name published by models.dev. */
  name: string;
  /** Documented base URL, when models.dev publishes one. */
  baseUrl?: string;
  /** Wire style derived from the published adapter package. */
  apiStyle: CatalogApiStyle;
  /** Published environment variable names that hold this provider's key. */
  envVars: readonly string[];
  /** Provider documentation URL, when published. */
  doc?: string;
  /** Number of text-capable models available for this provider. */
  modelCount: number;
  /** Id of the already-configured provider row for this preset, when any. */
  configuredProviderId?: string;
};

/** Capability filters offered by the model picker. */
export const MODEL_FILTERS = ["reasoning", "vision", "tools", "attachments"] as const;

export type ModelFilter = (typeof MODEL_FILTERS)[number];

/** A model search request against the local models.dev snapshot. */
export type ModelSearchInput = {
  /** Free-text query matched against model id, display name and family. */
  query?: string;
  /** Restrict results to one models.dev provider key. */
  providerKey?: string;
  /** Restrict results to the catalog provider matching this configured row. */
  providerId?: string;
  /** Required capabilities; a model must satisfy every entry. */
  filters?: readonly ModelFilter[];
  /** Maximum rows to return. The host clamps this to a sane upper bound. */
  limit?: number;
};

/** One result row from a model search. */
export type ModelSearchResult = {
  /** models.dev provider key that publishes this model. */
  providerKey: string;
  /** Display name of the publishing provider. */
  providerName: string;
  /** Complete published record, reused verbatim by the detail panel. */
  model: ModelInfo;
  /** Relevance score; higher sorts first. */
  score: number;
};

export type ModelSearchOutput = {
  results: ModelSearchResult[];
  /** Total matches before `limit` was applied. */
  total: number;
  /** True when the snapshot could not be loaded, so results are empty. */
  degraded: boolean;
};

/** Whether a published record satisfies a capability filter. */
export function modelMatchesFilter(model: ModelInfo, filter: ModelFilter): boolean {
  switch (filter) {
    case "reasoning":
      return model.reasoning === true || (model.supportedThinkingLevels?.length ?? 0) > 0;
    case "vision":
      return (
        model.capabilities.includes("vision") ||
        (model.modalities?.input?.includes("image") ?? false)
      );
    case "tools":
      return model.toolCall === true || model.capabilities.includes("tools");
    case "attachments":
      return model.attachment === true || model.capabilities.includes("attachments");
    default:
      return false;
  }
}

/** Whether a record satisfies every requested filter. */
export function modelMatchesFilters(
  model: ModelInfo,
  filters: readonly ModelFilter[] | undefined,
): boolean {
  return (filters ?? []).every((filter) => modelMatchesFilter(model, filter));
}

const THINKING_ORDER: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Sort thinking levels into canonical ascending order, dropping duplicates. */
export function sortThinkingLevels(levels: readonly ThinkingLevel[]): ThinkingLevel[] {
  return [...new Set(levels)].sort(
    (left, right) => THINKING_ORDER.indexOf(left) - THINKING_ORDER.indexOf(right),
  );
}

export const CATALOG_DEFAULT_CONTEXT_WINDOW = 128_000;
export const CATALOG_DEFAULT_MAX_TOKENS = 8_192;

/**
 * Build the persisted binding for a published record. Published limits and
 * thinking levels are adopted as-is, so a freshly picked model needs no manual
 * token entry; the user can still narrow them afterwards.
 */
export function bindingFromModelInfo(model: ModelInfo): ModelBinding {
  const thinkingLevels = sortThinkingLevels(
    model.supportedThinkingLevels?.length
      ? model.supportedThinkingLevels
      : model.thinkingLevelMap
        ? []
        : model.reasoning === true
          ? (["low", "medium", "high"] as ThinkingLevel[])
          : [],
  );
  return {
    id: model.modelId,
    contextWindow:
      model.contextWindow || model.limit?.context || CATALOG_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens || model.limit?.output || CATALOG_DEFAULT_MAX_TOKENS,
    thinkingLevels,
    defaultThinkingLevel: thinkingLevels.includes("medium")
      ? "medium"
      : (thinkingLevels[0] ?? null),
  };
}

/** Binding for a model id the catalog does not publish. */
export function bindingForCustomModel(id: string): ModelBinding {
  return {
    id: id.trim(),
    contextWindow: CATALOG_DEFAULT_CONTEXT_WINDOW,
    maxTokens: CATALOG_DEFAULT_MAX_TOKENS,
    thinkingLevels: [],
    defaultThinkingLevel: null,
  };
}

/** Compact token count for dense UI, e.g. `200K`, `1M`. */
export function formatTokenCount(tokens?: number): string {
  if (!tokens || tokens <= 0) return "—";
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const thousands = tokens / 1_000;
    return `${Number.isInteger(thousands) ? thousands : Math.round(thousands)}K`;
  }
  return String(tokens);
}

/**
 * Per-million-token price for the picker's cost column. models.dev publishes
 * cost per million tokens already, so this only formats.
 */
export function formatModelPrice(cost?: ModelInfo["cost"]): string {
  const input = cost?.input;
  const output = cost?.output;
  if (input === undefined && output === undefined) return "—";
  const price = (value?: number) =>
    value === undefined
      ? "—"
      : value === 0
        ? "free"
        : `$${value < 1 ? value.toFixed(2) : String(value)}`;
  return `${price(input)} / ${price(output)}`;
}
