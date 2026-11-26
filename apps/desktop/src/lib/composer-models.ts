import {
  bindingSupportsImages,
  effectiveContextWindow,
  isImageOnlyChatModel,
  isStarAiProviderId,
  type ImageGenerationBindings,
  modelMatchesFilter,
  modelWireIdsEqual,
  type ModelBinding,
  type ModelInfo,
  type ProviderPublic,
} from "@pi-desktop/shared";

type ConfiguredProvider = Pick<ProviderPublic, "id" | "models" | "defaultModelId" | "starAiGroup">;

/** UI identity is the complete wire id, not a catalog alias or a route suffix. */
export function sameComposerModelId(left: string, right: string): boolean {
  return modelWireIdsEqual(left, right);
}

/**
 * Catalog/discovery metadata for a configured model id — the same modalities
 * source session launch reads from its catalog row. Callers of
 * `isImageOnlyChatModel` must resolve and pass this so every chat-eligibility
 * answer (picker, defaults, subagents, canSend, launch) sees one truth (#2253).
 */
export function composerModelMetadata(
  discovered: readonly ModelInfo[] | undefined,
  modelId: string | undefined,
): ModelInfo | undefined {
  if (!modelId) return undefined;
  return (discovered ?? []).find((model) => sameComposerModelId(model.modelId, modelId));
}

/** Managed chat capability comes from the same model-square snapshot that grants visibility. */
export function chatRowSelectable(provider: Pick<ProviderPublic, "id" | "starAiGroup">, modelId: string): boolean {
  return !isStarAiProviderId(provider.id) || provider.starAiGroup?.chatModels?.includes(modelId) === true;
}

export function composerModelChatEligible(
  imageGeneration: ImageGenerationBindings | null | undefined,
  provider: Pick<ProviderPublic, "id" | "starAiGroup">,
  modelId: string,
  metadata?: ModelInfo,
): boolean {
  if (isStarAiProviderId(provider.id)) return chatRowSelectable(provider, modelId);
  return !isImageOnlyChatModel(imageGeneration, provider.id, modelId, metadata);
}

function configuredModelIds(provider: ConfiguredProvider): string[] {
  const ids = (provider.models ?? [])
    .map((binding) => binding.id.trim())
    .filter(Boolean);
  if (ids.length > 0) return [...new Set(ids)];

  const legacyId = provider.defaultModelId?.trim();
  return legacyId ? [legacyId] : [];
}

/**
 * Build the Composer model list from the models explicitly enabled in
 * provider settings. Discovery only enriches an exact configured id; it does
 * not grant every discovered model access to the conversation picker or lend
 * another route's capabilities to this binding.
 */
export function composerModelsForProvider(
  provider: ConfiguredProvider,
  discovered: readonly ModelInfo[] | undefined,
  imageGeneration?: ImageGenerationBindings | null,
  includeNonChat = false,
): ModelInfo[] {
  const managed = isStarAiProviderId(provider.id);
  const chatModels = provider.starAiGroup?.chatModels;
  if (managed && !chatModels) return [];
  const ids = managed ? provider.models.map((model) => model.id) : configuredModelIds(provider);
  return ids.filter((modelId) => {
    const metadata = (discovered ?? []).find((model) =>
      sameComposerModelId(model.modelId, modelId),
    );
    // For a managed channel the verified square, including its chat subset,
    // is authoritative. Local discovery can enrich but cannot add or remove rows.
    if (managed) return includeNonChat || chatRowSelectable(provider, modelId);
    // Only a pure image-generation endpoint is excluded: a model the user
    // marked for image generation that also supports conversation stays in
    // the Composer list (#2253).
    return !isImageOnlyChatModel(imageGeneration, provider.id, modelId, metadata)
      && !(discovered ?? []).some((model) =>
        sameComposerModelId(model.modelId, modelId) && model.discoveryState === "unlisted");
  }).map((modelId) => {
    const metadata = (discovered ?? []).find((model) =>
      sameComposerModelId(model.modelId, modelId),
    );
    const binding = composerModelBinding(provider, modelId);
    const contextWindow = effectiveContextWindow(
      metadata?.contextWindow,
      binding?.contextWindow,
      binding?.contextWindowSource,
    );
    const contextLimit = contextWindow === undefined ? {} : { contextWindow };
    const displayName = modelId;
    return metadata
      ? { ...metadata, ...contextLimit, modelId, displayName, providerId: provider.id }
      : {
          modelId,
          displayName,
          providerId: provider.id,
          ...contextLimit,
          capabilities: ["text"],
          source: "user" as const,
        };
  });
}

/** The Composer uses the configured alias when set, otherwise the complete wire id. */
export function composerModelDisplayName(
  provider: ConfiguredProvider | undefined,
  modelId: string,
): string {
  const alias = provider ? composerModelBinding(provider, modelId)?.alias?.trim() : undefined;
  return alias || modelId;
}

/** Find only the binding for this complete wire id. */
export function composerModelBinding(
  provider: ConfiguredProvider,
  modelId: string,
): ModelBinding | undefined {
  return (provider.models ?? []).find((candidate) =>
    sameComposerModelId(candidate.id, modelId),
  );
}

/** Short capability markers shown on a composer model row. */
export type ComposerModelBadge = "reasoning" | "vision";

/**
 * Capability markers for one configured model. Vision follows the binding's
 * image-input override when set, the published capability otherwise.
 */
export function composerModelBadges(
  model: ModelInfo,
  provider?: ConfiguredProvider | null,
): ComposerModelBadge[] {
  const badges: ComposerModelBadge[] = [];
  if (modelMatchesFilter(model, "reasoning")) badges.push("reasoning");
  const binding = provider ? composerModelBinding(provider, model.modelId) : undefined;
  if (bindingSupportsImages(binding, model)) badges.push("vision");
  return badges;
}

/** Search the full id, configured alias, published name, family and provider. */
export function composerModelMatchesQuery(
  model: ModelInfo,
  providerName: string,
  query: string,
  alias?: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystacks = [
    model.modelId,
    alias ?? "",
    model.displayName ?? "",
    model.family ?? "",
    providerName,
  ];
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}
