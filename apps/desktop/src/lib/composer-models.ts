import {
  bindingSupportsImages,
  configuredChatModels,
  effectiveContextWindow,
  isImageOnlyChatModel,
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

/**
 * One chat-eligibility answer everywhere: a model bound for image generation
 * stays chat-eligible unless its discovered metadata names no text output or
 * its id is a pure image-generation endpoint (#2253).
 */
export function composerModelChatEligible(
  imageGeneration: ImageGenerationBindings | null | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
  discovered?: readonly ModelInfo[],
): boolean {
  const metadata = composerModelMetadata(discovered, modelId);
  return !isImageOnlyChatModel(imageGeneration, providerId, modelId, metadata);
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
  return configuredChatModels(provider, discovered, imageGeneration).map(({ modelId, metadata, binding }) => {
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
