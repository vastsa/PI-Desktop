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

/** The provider's own default: the head of its binding list. */
export function defaultModelIdOf(provider: ProviderPublic): string | undefined {
  return provider.models?.[0]?.id ?? provider.defaultModelId;
}

/** True when the provider actually offers `modelId`. */
export function providerOffersModel(
  provider: ProviderPublic,
  modelId?: string,
): boolean {
  if (!modelId) return false;
  const bindings = provider.models ?? [];
  if (bindings.some((binding) => modelIdsMatch(binding.id, modelId))) return true;
  // An OAuth row may carry only `defaultModelId` with no bindings yet.
  return !!provider.defaultModelId && modelIdsMatch(provider.defaultModelId, modelId);
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
