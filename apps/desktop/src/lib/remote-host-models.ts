/**
 * Project a paired Host's published model catalog onto the provider shape the
 * Composer already renders. Nothing here is a local provider: the rows are a
 * read-only view of what the Host can run, and every selection round-trips
 * through the Host's own `session/configure`.
 *
 * Both capabilities and the thinking ladder stay exactly as the Host declared
 * them. A model the Host published without reasoning levels must not gain a
 * thinking menu merely because this Desktop supports the level.
 */
import {
  CATALOG_DEFAULT_MAX_TOKENS,
  THINKING_LEVELS,
  type ModelBinding,
  type ModelInfo,
  type ProviderPublic,
  type RacpHostModel,
  type RacpHostModelCatalog,
  type RacpSessionUsage,
  type ThinkingLevel,
} from "@pi-desktop/shared";

type ModelCapability = ModelInfo["capabilities"][number];

export type RemoteModelCatalog = {
  providers: ProviderPublic[];
  providerModels: Record<string, ModelInfo[]>;
};

export const EMPTY_REMOTE_MODEL_CATALOG: RemoteModelCatalog = {
  providers: [],
  providerModels: {},
};

const KNOWN_CAPABILITIES = new Set<string>([
  "text",
  "tools",
  "vision",
  "reasoning",
  "json",
  "audio",
  "video",
  "pdf",
  "attachments",
  "temperature",
]);

function thinkingLevels(values: string[] | undefined): ThinkingLevel[] {
  if (!values?.length) return [];
  return THINKING_LEVELS.filter((level) => values.includes(level));
}

function capabilities(values: string[] | undefined): ModelCapability[] {
  const known = (values ?? []).filter((value): value is ModelCapability =>
    KNOWN_CAPABILITIES.has(value),
  );
  return known.length > 0 ? [...new Set(known)] : ["text"];
}

function binding(model: RacpHostModel): ModelBinding {
  const levels = thinkingLevels(model.supportedThinkingLevels);
  return {
    id: model.modelId,
    alias: model.displayName === model.modelId ? undefined : model.displayName,
    contextWindow: model.contextWindow ?? 0,
    maxTokens: CATALOG_DEFAULT_MAX_TOKENS,
    // An empty ladder is the Host saying "no choice to make"; `useComposerModelMenu`
    // then keeps the reasoning control hidden instead of inventing levels.
    thinkingLevels: levels.length > 0 ? levels : ["off"],
    defaultThinkingLevel: null,
    ...(model.fastMode === true ? { fastModeAllowed: true } : {}),
  };
}

function modelInfo(providerId: string, model: RacpHostModel): ModelInfo {
  const levels = thinkingLevels(model.supportedThinkingLevels);
  const caps = capabilities(model.capabilities);
  return {
    modelId: model.modelId,
    displayName: model.displayName,
    providerId,
    capabilities: caps,
    source: "user",
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(levels.length > 0 ? { supportedThinkingLevels: levels } : {}),
  };
}

function providerRow(providerId: string, rows: RacpHostModel[]): ProviderPublic {
  const bindings = rows.map(binding);
  const levels = THINKING_LEVELS.filter((level) =>
    rows.some((row) => thinkingLevels(row.supportedThinkingLevels).includes(level)),
  );
  const first = rows[0]!;
  return {
    id: providerId,
    name: first.providerName,
    vendorKey: providerId,
    type: "native",
    protocol: "racp",
    enabled: true,
    authKind: "none",
    hasSecret: true,
    models: bindings,
    defaultModelId: first.modelId,
    supportsReasoning: levels.some((level) => level !== "off"),
    supportedThinkingLevels: levels,
    createdAt: "",
    updatedAt: "",
  };
}

/**
 * Group the Host's flat model rows by provider, preserving the Host's order so
 * the Composer's provider rail reads the same sequence the Host would show.
 */
export function remoteModelCatalog(
  catalog: RacpHostModelCatalog | undefined,
): RemoteModelCatalog {
  if (!catalog?.models.length) return EMPTY_REMOTE_MODEL_CATALOG;
  const grouped = new Map<string, RacpHostModel[]>();
  for (const row of catalog.models) {
    const rows = grouped.get(row.providerId);
    if (rows) rows.push(row);
    else grouped.set(row.providerId, [row]);
  }
  const providers: ProviderPublic[] = [];
  const providerModels: Record<string, ModelInfo[]> = {};
  for (const [providerId, rows] of grouped) {
    providers.push(providerRow(providerId, rows));
    providerModels[providerId] = rows.map((row) => modelInfo(providerId, row));
  }
  return { providers, providerModels };
}

/** The window the Host itself uses for the model that answered the last request. */
export function remoteContextWindow(usage: RacpSessionUsage | undefined): number | undefined {
  const window = usage?.contextWindow;
  return typeof window === "number" && window > 0 ? window : undefined;
}