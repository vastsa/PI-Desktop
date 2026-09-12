import {
  bindingSupportsImages,
  modelIdsMatch,
  modelMatchesFilter,
  type ModelBinding,
  type ModelInfo,
  type ProviderPublic,
} from "@pi-desktop/shared";

type ConfiguredProvider = Pick<ProviderPublic, "id" | "models" | "defaultModelId">;

/**
 * Resolve the provider heading shown in the Composer model menu.
 *
 * OAuth rows keep the vendor name as `provider.name` for runtime identity, but
 * the account-specific display label lives in `oauthAccountLabel`. Prefer that
 * label so duplicate accounts from one vendor remain distinguishable.
 */
export function composerProviderDisplayName(
  provider: Pick<ProviderPublic, "name" | "oauthAccountLabel">,
): string {
  return provider.oauthAccountLabel?.trim() || provider.name.trim();
}

/** Keep both the account label and vendor name searchable in the Composer. */
export function composerProviderSearchText(
  provider: Pick<ProviderPublic, "name" | "oauthAccountLabel">,
): string {
  const displayName = composerProviderDisplayName(provider);
  const providerName = provider.name.trim();
  return displayName === providerName
    ? displayName
    : `${displayName} ${providerName}`;
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
    const row: ModelInfo = metadata
      ? { ...metadata, modelId, providerId: provider.id }
      : {
          modelId,
          displayName: modelId,
          providerId: provider.id,
          capabilities: ["text"],
          source: "user" as const,
        };
    const displayName = composerModelDisplayName(provider, modelId, row.displayName);
    return displayName === row.displayName ? row : { ...row, displayName };
  });
}

/**
 * Resolve the one visible model name used by the Composer.
 *
 * Bindings and discovery can use equivalent namespaced or regional IDs. Use
 * the same tolerant identity match for aliases so a refresh cannot briefly
 * fall back to the wire ID before the configured label is reapplied.
 */
export function composerModelDisplayName(
  provider: ConfiguredProvider,
  modelId: string,
  fallback?: string,
): string {
  const alias = composerModelBinding(provider, modelId)?.alias?.trim();
  return alias || fallback?.trim() || modelId;
}

/**
 * The provider's configured binding for a model, matched the same tolerant way
 * as the display name so a namespaced or regional ID still finds its settings.
 */
export function composerModelBinding(
  provider: ConfiguredProvider,
  modelId: string,
): ModelBinding | undefined {
  const normalizedModelId = modelId.trim().toLowerCase();
  const bindings = provider.models ?? [];
  return (
    bindings.find((candidate) => candidate.id.trim().toLowerCase() === normalizedModelId) ??
    bindings.find((candidate) => modelIdsMatch(candidate.id, modelId))
  );
}

/** Short capability markers shown on a composer model row. */
export type ComposerModelBadge = "reasoning" | "vision";

/**
 * Capability markers for one configured model. The composer shows these so a
 * model can be chosen on capability rather than on name alone. Vision follows
 * the effective image input: the binding's Advanced "Image input" override
 * when set, the published capability otherwise, the same answer the transport
 * gate and the settings switch give (#214).
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
