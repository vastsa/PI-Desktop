import {
  bindingSupportsImages,
  isImageGenerationModel,
  type ImageGenerationBindings,
  modelMatchesFilter,
  modelWireIdsEqual,
  type ModelBinding,
  type ModelInfo,
  type ProviderPublic,
} from "@pi-desktop/shared";

type ConfiguredProvider = Pick<ProviderPublic, "id" | "models" | "defaultModelId">;

/** UI identity is the complete wire id, not a catalog alias or a route suffix. */
export function sameComposerModelId(left: string, right: string): boolean {
  return modelWireIdsEqual(left, right);
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
): ModelInfo[] {
  return configuredModelIds(provider).filter((modelId) =>
    !isImageGenerationModel(imageGeneration, provider.id, modelId),
  ).map((modelId) => {
    const metadata = (discovered ?? []).find((model) =>
      sameComposerModelId(model.modelId, modelId),
    );
    const displayName = metadata?.displayName?.trim() || modelId;
    return metadata
      ? { ...metadata, modelId, displayName, providerId: provider.id }
      : {
          modelId,
          displayName,
          providerId: provider.id,
          capabilities: ["text"],
          source: "user" as const,
        };
  });
}

/** The Composer uses the configured alias, then published name, then wire id. */
export function composerModelDisplayName(
  provider: ConfiguredProvider | undefined,
  modelId: string,
  fallback?: string,
): string {
  const alias = provider ? composerModelBinding(provider, modelId)?.alias?.trim() : undefined;
  return alias || fallback?.trim() || modelId;
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
