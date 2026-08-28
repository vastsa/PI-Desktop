import { OPENCODE_GO_API_STYLE, type ThinkingLevel } from "@pi-desktop/shared";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
export {
  clampThinkingLevel,
  type PiModelConfig,
  type ThinkingCapabilitySet,
} from "./thinking-level.js";
import type { PiModelConfig } from "./thinking-level.js";

export type ModelCapabilityInput = {
  vendorKey: string;
  modelId: string;
  apiStyle?: string;
};

export type ModelCapabilities = {
  supportsReasoning: boolean;
  supportedThinkingLevels: ThinkingLevel[];
};

/** Whether the pi-ai fallback model accepts image input blocks. */
export function resolveVisionCapability(input: ModelCapabilityInput): boolean {
  return findCatalogModel(input)?.input.includes("image") ?? false;
}

/** Public name used by the desktop main-process provider enrichment. */
export type ThinkingCapabilities = ModelCapabilities;

let cachedBuiltinModels: ReturnType<typeof builtinModels> | undefined;

function getBuiltinCatalog() {
  cachedBuiltinModels ??= builtinModels();
  return cachedBuiltinModels;
}

/** Map a stored provider apiStyle onto the pi-ai wire api (runtime binding). */
function wireApiForStyle(apiStyle?: string): string {
  switch (apiStyle) {
    case OPENCODE_GO_API_STYLE:
      return "openai-completions";
    case "responses":
      return "openai-responses";
    case "openai_codex_responses":
      return "openai-codex-responses";
    case "anthropic_messages":
      return "anthropic-messages";
    case "google_generative_ai":
      return "google-generative-ai";
    case "pi_messages":
      return "pi-messages";
    default:
      return "openai-completions";
  }
}

/** Separators after which a catalog id counts as a prefix of a gateway id. */
const MODEL_ID_BOUNDARY = new Set(["-", "_", ".", ":", "@", "/"]);

/**
 * Providers whose catalog records describe the original model vendor rather
 * than a gateway, reseller, or subscription proxy. This list is deliberately
 * narrower than pi-ai's complete provider catalog because settings metadata
 * must not inherit limits from an intermediary's copy of a model.
 */
const OFFICIAL_CATALOG_PROVIDER_ORDER = [
  "openai",
  "openai-codex",
  "anthropic",
  "deepseek",
  "google",
  "xai",
  "mistral",
  "minimax",
  "minimax-cn",
  "moonshotai",
  "moonshotai-cn",
  "kimi-coding",
  "zai",
  "zai-coding-cn",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "xiaomi",
  "ant-ling",
] as const;

const OFFICIAL_CATALOG_PROVIDER_RANK = new Map<string, number>(
  OFFICIAL_CATALOG_PROVIDER_ORDER.map((provider, index) => [provider, index]),
);

function officialCatalogProviderRank(provider: string): number | undefined {
  const normalized = provider.trim().toLowerCase();
  const exactRank = OFFICIAL_CATALOG_PROVIDER_RANK.get(normalized);
  if (exactRank !== undefined) return exactRank;
  if (normalized.startsWith("xiaomi-token-plan-")) {
    return OFFICIAL_CATALOG_PROVIDER_ORDER.length;
  }
  return undefined;
}

function isOfficialCatalogProvider(provider: string): boolean {
  return officialCatalogProviderRank(provider) !== undefined;
}

type CatalogModel = ReturnType<
  ReturnType<typeof builtinModels>["getModels"]
>[number];

export type PiCatalogModelSummary = {
  modelId: string;
  displayName: string;
};

/**
 * List the pi-ai models for a known native provider. This is intentionally a
 * fallback catalog: models.dev is preferred by Electron main, while unknown
 * custom providers continue to use their own endpoint discovery.
 */
const PI_PROVIDER_ALIASES: Record<string, string[]> = {
  togetherai: ["together"],
  "fireworks-ai": ["fireworks"],
  "kimi-for-coding": ["kimi-coding"],
  azure: ["azure-openai-responses"],
  vercel: ["vercel-ai-gateway"],
};

export function listPiCatalogModels(input: {
  vendorKey?: string;
  apiStyle?: string;
}): PiCatalogModelSummary[] {
  const vendorKey = input.vendorKey?.trim().toLowerCase();
  if (!vendorKey || vendorKey === "custom") return [];
  const providerKeys = new Set([vendorKey, ...(PI_PROVIDER_ALIASES[vendorKey] ?? [])]);
  const api = wireApiForStyle(input.apiStyle);
  return getBuiltinCatalog()
    .getModels()
    .filter(
      (model) =>
        providerKeys.has(model.provider.trim().toLowerCase()) && model.api === api,
    )
    .map((model) => ({ modelId: model.id, displayName: model.name || model.id }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/** Prefer the catalog entry carrying the richest model-specific semantics. */
function catalogInfoScore(model: CatalogModel): number {
  const compat = (model.compat ?? {}) as Record<string, unknown>;
  let score = 0;
  if (compat.forceAdaptiveThinking === true) score += 16;
  if (typeof compat.thinkingFormat === "string") score += 8;
  if (typeof model.thinkingLevelMap?.off === "string") score += 4;
  if (model.thinkingLevelMap) score += 2;
  if (model.input.includes("image")) score += 1;
  return score;
}

function compareOfficialCatalogModels(a: CatalogModel, b: CatalogModel): number {
  const providerRank =
    (officialCatalogProviderRank(a.provider) ?? Number.MAX_SAFE_INTEGER) -
    (officialCatalogProviderRank(b.provider) ?? Number.MAX_SAFE_INTEGER);
  return providerRank || catalogInfoScore(b) - catalogInfoScore(a);
}

function findCatalogModel(input: ModelCapabilityInput): CatalogModel | undefined {
  const api = wireApiForStyle(input.apiStyle);
  const requestedId = input.modelId.trim().toLowerCase();
  if (!requestedId) return undefined;

  const catalog = getBuiltinCatalog();
  const vendorModel = catalog.getModel(input.vendorKey, input.modelId);
  if (vendorModel?.api === api) return vendorModel;

  const candidates = catalog.getModels().filter((model) => model.api === api);
  const exact = candidates
    .filter((model) => model.id.toLowerCase() === requestedId)
    .sort((a, b) => catalogInfoScore(b) - catalogInfoScore(a));
  return (
    exact[0] ??
    candidates
      .filter((model) => {
        const id = model.id.toLowerCase();
        return (
          requestedId.length > id.length &&
          requestedId.startsWith(id) &&
          MODEL_ID_BOUNDARY.has(requestedId.charAt(id.length))
        );
      })
      .sort(
        (a, b) =>
          b.id.length - a.id.length || catalogInfoScore(b) - catalogInfoScore(a),
      )[0]
  );
}

/**
 * Resolve model metadata for adding a model in Settings.
 *
 * Unlike runtime resolution, this intentionally ignores apiStyle. A custom
 * OpenAI-compatible provider may speak Chat Completions while selecting a
 * model that pi-ai registers under Responses. Only records from the original
 * model providers above may supply the settings defaults; gateway/reseller
 * records are never used for this path.
 */
function findOfficialCatalogModel(
  input: ModelCapabilityInput,
): CatalogModel | undefined {
  const requestedId = input.modelId.trim().toLowerCase();
  if (!requestedId) return undefined;

  const catalog = getBuiltinCatalog();
  const officialModels = catalog
    .getModels()
    .filter((model) => isOfficialCatalogProvider(model.provider));
  const vendorKey = input.vendorKey.trim().toLowerCase();

  const vendorExact = officialModels
    .filter(
      (model) =>
        model.provider.trim().toLowerCase() === vendorKey &&
        model.id.toLowerCase() === requestedId,
    )
    .sort(compareOfficialCatalogModels);
  if (vendorExact[0]) return vendorExact[0];

  const exact = officialModels
    .filter((model) => model.id.toLowerCase() === requestedId)
    .sort(compareOfficialCatalogModels);
  if (exact[0]) return exact[0];

  return officialModels
    .filter((model) => {
      const id = model.id.toLowerCase();
      return (
        requestedId.length > id.length &&
        requestedId.startsWith(id) &&
        MODEL_ID_BOUNDARY.has(requestedId.charAt(id.length))
      );
    })
    .sort(
      (a, b) =>
        b.id.length - a.id.length || compareOfficialCatalogModels(a, b),
    )[0];
}

/**
 * Resolve the official pi-ai metadata used to prefill a newly added model.
 *
 * This is deliberately separate from `resolvePiModelConfig`: changing the
 * latter would change sidecar request configuration and session capability
 * resolution, which remain api-aware by design.
 */
export function resolvePiModelConfigForModelDraft(
  input: ModelCapabilityInput,
): PiModelConfig | undefined {
  const model = findOfficialCatalogModel(input);
  return model ? piModelConfigFromModel(model) : undefined;
}

/** Resolve the complete serializable model metadata owned by pi-ai. */
export function resolvePiModelConfig(
  input: ModelCapabilityInput,
): PiModelConfig | undefined {
  const model = findCatalogModel(input);
  if (!model) return undefined;
  return piModelConfigFromModel(model);
}

/**
 * Flatten one pi-ai model record into the serializable config the sidecar
 * receives. Vendor-account rows resolve their model from the authenticated
 * collection rather than the builtin catalog, so this conversion is shared.
 */
export function piModelConfigFromModel(model: {
  name: string;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: CatalogModel["thinkingLevelMap"];
  input: readonly string[];
  cost: CatalogModel["cost"];
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: unknown;
}): PiModelConfig {
  return {
    source: "pi",
    name: model.name,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap
      ? { thinkingLevelMap: { ...model.thinkingLevelMap } }
      : {}),
    input: [...model.input] as PiModelConfig["input"],
    cost: {
      ...model.cost,
      ...(model.cost.tiers
        ? { tiers: model.cost.tiers.map((tier) => ({ ...tier })) }
        : {}),
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat
      ? { compat: structuredClone(model.compat) as Record<string, unknown> }
      : {}),
  };
}

/** Resolve UI/session reasoning capability from the same pi model record. */
export function resolveThinkingCapabilities(
  input: ModelCapabilityInput,
): ModelCapabilities {
  const model = findCatalogModel(input);
  if (!model?.reasoning) {
    return {
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    };
  }
  return {
    supportsReasoning: true,
    supportedThinkingLevels: [
      ...(getSupportedThinkingLevels(model) as ThinkingLevel[]),
    ],
  };
}
