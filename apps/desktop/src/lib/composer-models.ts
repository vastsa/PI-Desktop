import {
  modelIdsMatch,
  modelMatchesFilter,
  type ModelInfo,
  type ProviderPublic,
} from "@pi-desktop/shared";

type ConfiguredProvider = Pick<ProviderPublic, "id" | "models" | "defaultModelId">;

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
 * provider settings. Discovery only enriches those configured rows; it does
 * not grant every discovered model access to the conversation picker.
 */
export function composerModelsForProvider(
  provider: ConfiguredProvider,
  discovered: readonly ModelInfo[] | undefined,
): ModelInfo[] {
  return configuredModelIds(provider).map((modelId) => {
    const metadata = (discovered ?? []).find((model) =>
      modelIdsMatch(model.modelId, modelId),
    );
    return metadata
      ? { ...metadata, modelId, providerId: provider.id }
      : {
          modelId,
          displayName: modelId,
          providerId: provider.id,
          capabilities: ["text"],
          source: "user" as const,
        };
  });
}

/** Short capability markers shown on a composer model row. */
export type ComposerModelBadge = "reasoning" | "vision";

/**
 * Published capability markers for one configured model. The composer shows
 * these so a model can be chosen on capability rather than on name alone.
 */
export function composerModelBadges(model: ModelInfo): ComposerModelBadge[] {
  const badges: ComposerModelBadge[] = [];
  if (modelMatchesFilter(model, "reasoning")) badges.push("reasoning");
  if (modelMatchesFilter(model, "vision")) badges.push("vision");
  return badges;
}

/**
 * Match a composer model row against the picker query. Model id, display name,
 * published family and the owning provider name are all searchable, so
 * "sonnet", "anthropic" and "claude-3" all reach the same row.
 */
export function composerModelMatchesQuery(
  model: ModelInfo,
  providerName: string,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystacks = [
    model.modelId,
    model.displayName ?? "",
    model.family ?? "",
    providerName,
  ];
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}
