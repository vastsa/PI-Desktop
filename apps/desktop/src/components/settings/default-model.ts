/**
 * Resolving which model id represents a provider's default.
 *
 * `settings.defaultModelId` is a single global value, so after the default
 * provider changes it can still name a model belonging to the previous one.
 * Rendering it next to the current provider's name would assert a pairing that
 * is not configured, so these helpers keep the two notions apart: what a
 * provider itself offers, and what is safe to display for it.
 */
import { modelIdsMatch, type ProviderPublic } from "@pi-desktop/shared";

export type DefaultModelOption = {
  provider: ProviderPublic;
  modelId: string;
};

/** Expand runnable providers into the model choices they actually configure. */
export function defaultModelOptions(
  providers: readonly ProviderPublic[],
): DefaultModelOption[] {
  return providers.flatMap((provider) => {
    const modelIds = (provider.models ?? [])
      .map((binding) => binding.id.trim())
      .filter(Boolean);
    const ids = modelIds.length > 0 ? modelIds : [defaultModelIdOf(provider)?.trim() ?? ""];
    return [...new Set(ids)].filter(Boolean).map((modelId) => ({ provider, modelId }));
  });
}

/** The provider's own default: the first non-empty binding, then legacy fallback. */
export function defaultModelIdOf(provider: ProviderPublic): string | undefined {
  return (
    provider.models?.find((binding) => binding.id.trim())?.id.trim() ||
    provider.defaultModelId?.trim() ||
    undefined
  );
}

/** True when the provider actually offers `modelId`. */
export function providerOffersModel(
  provider: ProviderPublic,
  modelId?: string,
): boolean {
  if (!modelId) return false;
  const bindings = provider.models ?? [];
  if (bindings.some((binding) => modelIdsMatch(binding.id, modelId))) return true;
  // A legacy/OAuth row may carry only `defaultModelId` with no bindings yet.
  return (
    bindings.length === 0 &&
    !!provider.defaultModelId &&
    modelIdsMatch(provider.defaultModelId, modelId)
  );
}

/**
 * The model id to display for the default provider: the global value only when
 * this provider serves it, otherwise the provider's own head binding.
 */
export function displayedDefaultModelId(
  provider: ProviderPublic,
  settingsModelId?: string,
): string | undefined {
  return providerOffersModel(provider, settingsModelId)
    ? settingsModelId
    : defaultModelIdOf(provider);
}
