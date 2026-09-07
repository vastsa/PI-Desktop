/**
 * Shared vocabulary for the model configuration surface.
 *
 * A service's own endpoint is the source of truth for which models it serves;
 * models.dev enriches those rows with published metadata. This module owns what
 * both sides of the IPC boundary agree on: the wire API styles, how a published
 * `npm` adapter maps onto one, how a published record becomes a persisted
 * binding, and the shared capability and formatting helpers.
 *
 * Nothing here performs I/O, so the renderer, the Electron main process and the
 * tests share one implementation instead of re-deriving these rules per surface.
 */

import { publishedThinkingLevels } from "./thinking-levels.js";
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

/** One published capability a model row can be checked against. */
export type ModelFilter = "reasoning" | "vision" | "tools" | "attachments" | "pdf";

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
    case "pdf":
      return (
        model.capabilities.includes("pdf") ||
        (model.modalities?.input?.includes("pdf") ?? false)
      );
    default:
      return false;
  }
}

/**
 * Effective image input for a binding: the user override when set, otherwise the
 * published capability. One helper so settings, the composer and the transport
 * gate cannot drift into three different answers.
 */
export function bindingSupportsImages(
  binding?: Pick<ModelBinding, "supportsImages"> | null,
  model?: ModelInfo | null,
): boolean {
  if (typeof binding?.supportsImages === "boolean") return binding.supportsImages;
  return model ? modelMatchesFilter(model, "vision") : false;
}

/** Effective document (PDF) input for a binding, override first. */
export function bindingSupportsDocuments(
  binding?: Pick<ModelBinding, "supportsDocuments"> | null,
  model?: ModelInfo | null,
): boolean {
  if (typeof binding?.supportsDocuments === "boolean") return binding.supportsDocuments;
  return model ? modelMatchesFilter(model, "pdf") : false;
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
 * Resolve a model's effective context window.
 *
 * Older provider bindings were seeded with the generic 128k fallback before a
 * catalog record was available. Treat that value as inherited when a published
 * model limit is now known, while preserving every non-default value as an
 * explicit Advanced override.
 */
export function effectiveContextWindow(
  publishedContextWindow?: number | null,
  configuredContextWindow?: number | null,
): number | undefined {
  const published =
    typeof publishedContextWindow === "number" &&
    Number.isFinite(publishedContextWindow) &&
    publishedContextWindow > 0
      ? Math.round(publishedContextWindow)
      : undefined;
  const configured =
    typeof configuredContextWindow === "number" &&
    Number.isFinite(configuredContextWindow) &&
    configuredContextWindow > 0
      ? Math.round(configuredContextWindow)
      : undefined;

  if (configured === undefined) return published;
  if (published !== undefined && configured === CATALOG_DEFAULT_CONTEXT_WINDOW) {
    return published;
  }
  return configured;
}

/**
 * Build the persisted binding for a published record. Published limits and
 * thinking levels seed a fresh binding, so a newly picked model needs no
 * manual token entry; the user can still configure the endpoint explicitly.
 */
export function bindingFromModelInfo(model: ModelInfo): ModelBinding {
  // Published levels seed a fresh binding. The user may add other canonical
  // levels later when the endpoint supports more than the catalog reports.
  const thinkingLevels = sortThinkingLevels(publishedThinkingLevels(model));
  return {
    id: model.modelId,
    contextWindow:
      model.contextWindow || model.limit?.context || CATALOG_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens || model.limit?.output || CATALOG_DEFAULT_MAX_TOKENS,
    thinkingLevels,
    defaultThinkingLevel: thinkingLevels.includes("medium")
      ? "medium"
      : (thinkingLevels[0] ?? null),
    // Absent overrides keep following models.dev, so a catalog correction still
    // reaches an already saved binding.
    supportsImages: null,
    supportsDocuments: null,
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
    supportsImages: null,
    supportsDocuments: null,
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
