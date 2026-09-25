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
import type {
  ContextWindowSource,
  ModelBinding,
  ModelInfo,
  ThinkingLevel,
} from "./types.js";

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
 * Keep persisted provider rows editable when an older or newer client stored
 * an API style this renderer does not know yet. Runtime transport resolution
 * uses the same Chat Completions fallback for unknown styles.
 */
export function normalizeApiStyle(value?: string | null): CatalogApiStyle {
  return API_STYLES.some((style) => style === value)
    ? (value as CatalogApiStyle)
    : "chat_completions";
}

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
 * `source` is the stored provenance of the configured value. A `catalog`
 * binding follows the published record, so a models.dev correction reaches a
 * binding that was saved before the fix; a `user` binding is the user's own
 * number and is never replaced, even when it equals the generic fallback.
 *
 * Older provider bindings name no source. They keep the rule this helper has
 * always applied: the generic 128k seed is treated as inherited when a
 * published limit is known, while every other value stays authoritative.
 */
export function effectiveContextWindow(
  publishedContextWindow?: number | null,
  configuredContextWindow?: number | null,
  source?: ContextWindowSource | null,
): number | undefined {
  const published = positiveTokenCount(publishedContextWindow);
  const configured = positiveTokenCount(configuredContextWindow);

  if (source === "catalog") return published ?? configured;
  if (source === "user") return configured ?? published;
  if (configured === undefined) return published;
  if (published !== undefined && configured === CATALOG_DEFAULT_CONTEXT_WINDOW) {
    return published;
  }
  return configured;
}

/** Token counts are whole positive numbers; anything else means "unset". */
function positiveTokenCount(value?: number | null): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.round(value);
}

/** Context-window fields the resolver reads and rewrites on a binding. */
type BindingContextWindow = Pick<ModelBinding, "contextWindow"> &
  Partial<Pick<ModelBinding, "contextWindowSource">>;

/**
 * Resolve a saved binding against its catalog baseline for
 * `modelConfigWithBinding`.
 *
 * That runtime helper applies the historical two-argument rule, which cannot
 * tell a hand-edited 128k from the generic seed. Callers that know where a
 * stored value came from resolve it first: the returned baseline and binding
 * both carry the source-aware window, so the two-argument rule lands on the
 * same answer. An exported binding keeps the catalog as its provenance whenever
 * the catalog supplied the value, so a later settings save cannot freeze an
 * inherited value into a snapshot of its own.
 *
 * A `generic` baseline is the fallback for a lookup that found no record, not
 * a published limit, so it never replaces a saved window: a catalog snapshot
 * taken while the record still resolved stays in force.
 */
export function resolveBindingContextWindow<
  C extends { contextWindow?: number | null; source?: string },
  B extends BindingContextWindow,
>(catalogConfig: C, binding: B): { catalogConfig: C; binding: B };
export function resolveBindingContextWindow<
  C extends { contextWindow?: number | null; source?: string },
  B extends BindingContextWindow,
>(
  catalogConfig: C,
  binding: B | null | undefined,
): { catalogConfig: C; binding: B | null | undefined };
export function resolveBindingContextWindow(
  catalogConfig: { contextWindow?: number | null; source?: string },
  binding: BindingContextWindow | null | undefined,
): {
  catalogConfig: { contextWindow?: number | null; source?: string };
  binding: BindingContextWindow | null | undefined;
} {
  if (!binding) return { catalogConfig, binding };
  const published = catalogConfig.source === "generic"
    ? undefined
    : positiveTokenCount(catalogConfig.contextWindow);
  const source = binding.contextWindowSource ?? undefined;
  const resolved = effectiveContextWindow(published, binding.contextWindow, source);
  if (resolved === undefined) return { catalogConfig, binding };
  const inherited = source !== "user" && published !== undefined;
  return {
    catalogConfig: { ...catalogConfig, contextWindow: resolved },
    binding: {
      ...binding,
      contextWindow: resolved,
      ...(inherited ? { contextWindowSource: "catalog" as const } : {}),
    },
  };
}

/**
 * Build the persisted binding for a published record. Published limits and
 * thinking levels seed a fresh binding, so a newly picked model needs no
 * manual token entry; the user can still configure the endpoint explicitly.
 */
export function bindingFromModelInfo(model: ModelInfo): ModelBinding {
  const thinkingLevels = sortThinkingLevels(publishedThinkingLevels(model));
  return {
    id: model.modelId,
    contextWindow:
      model.contextWindow || model.limit?.context || CATALOG_DEFAULT_CONTEXT_WINDOW,
    // The snapshot is a catalog value, not a user answer: a later models.dev
    // correction still reaches this binding.
    contextWindowSource: "catalog",
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

/**
 * Binding for a hand-typed id the catalog does publish.
 *
 * The published record seeds limits and thinking levels exactly like a picked
 * model, but the stored id stays what the user typed: the id is the string a
 * request is addressed with, and a catalog spelling that differs in case or
 * separators must not silently retarget it.
 */
export function bindingForCustomModelInfo(
  id: string,
  info: ModelInfo,
): ModelBinding {
  return { ...bindingFromModelInfo(info), id: id.trim() };
}

/** Binding for a model id the catalog does not publish. */
export function bindingForCustomModel(id: string): ModelBinding {
  return {
    id: id.trim(),
    // An unpublished model has no catalog value to inherit yet, so the seed
    // stays catalog-sourced: if models.dev describes the id later, the window
    // it publishes takes over.
    contextWindow: CATALOG_DEFAULT_CONTEXT_WINDOW,
    contextWindowSource: "catalog",
    maxTokens: CATALOG_DEFAULT_MAX_TOKENS,
    thinkingLevels: [],
    defaultThinkingLevel: null,
    supportsImages: null,
    supportsDocuments: null,
  };
}

/**
 * Drop a fraction's trailing zeros: `200.0` reads `200` and `1.10` reads `1.1`.
 */
function trimFraction(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Compact token count for dense UI.
 *
 * Published context windows sit on values a single rounded decimal cannot tell
 * apart — 1,000,000, 1,048,576 and 1,050,000 all rendered as `1M`/`1.1M`, and
 * reading 1,050,000 as `1.1M` overstated the window by 50k tokens. Two decimals
 * at the `M` scale and one at the `K` scale keep neighbouring rows distinct
 * while staying short: `1M`, `1.05M`, `1.1M`, `262.1K`.
 *
 * A count of `0` is a real value here, so callers that render an unpublished
 * limit go through `formatTokenCount` instead.
 */
export function formatCompactTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  const thousands = tokens / 1_000;
  // Rounding can push a `K` mantissa up to 1000 (999,999 -> `1000K`), which
  // reads as a scale error. Promote those to the `M` scale instead.
  if (Number(thousands.toFixed(1)) < 1_000) {
    return `${trimFraction(thousands.toFixed(1))}K`;
  }
  return `${trimFraction((tokens / 1_000_000).toFixed(2))}M`;
}

/**
 * Compact token count for a model limit, e.g. `200K`, `1.05M`.
 *
 * An absent or non-positive limit means the service never published one, so it
 * renders as an em dash rather than a number the user might trust.
 */
export function formatTokenCount(tokens?: number): string {
  if (!tokens || tokens <= 0) return "—";
  return formatCompactTokenCount(tokens);
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
