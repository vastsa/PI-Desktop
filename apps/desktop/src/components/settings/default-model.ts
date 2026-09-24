/**
 * Resolving which model id represents a provider's default.
 *
 * `settings.defaultModelId` is a single global value, so after the default
 * provider changes it can still name a model belonging to the previous one.
 * Rendering it next to the current provider's name would assert a pairing that
 * is not configured, so these helpers keep the two notions apart: what a
 * provider itself offers, and what is safe to display for it.
 */
import { isImageGenerationModel, modelWireIdsEqual as sameComposerModelId, type ImageGenerationBindings, type ProviderPublic } from "@pi-desktop/shared";

export type DefaultModelOption = {
  provider: ProviderPublic;
  modelId: string;
};

/** Expand runnable providers into the model choices they actually configure. */
export function defaultModelOptions(
  providers: readonly ProviderPublic[],
  imageGeneration?: ImageGenerationBindings | null,
): DefaultModelOption[] {
  return providers.flatMap((provider) => {
    const modelIds = (provider.models ?? [])
      .map((binding) => binding.id.trim())
      .filter(Boolean);
    const ids = modelIds.length > 0 ? modelIds : [defaultModelIdOf(provider)?.trim() ?? ""];
    return [...new Set(ids)].filter((modelId) => !!modelId &&
      !isImageGenerationModel(imageGeneration, provider.id, modelId),
    ).map((modelId) => ({ provider, modelId }));
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
  if (bindings.some((binding) => sameComposerModelId(binding.id, modelId))) return true;
  // A legacy/OAuth row may carry only `defaultModelId` with no bindings yet.
  return (
    bindings.length === 0 &&
    !!provider.defaultModelId &&
    sameComposerModelId(provider.defaultModelId, modelId)
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

/**
 * Whether the app default already names a model that still resolves.
 *
 * A non-empty `settings.defaultModelId` is not proof of a default: the value
 * outlives the provider it was picked from, so once that provider is deleted
 * or its binding list is emptied the value names nothing. Callers that would
 * otherwise adopt a default for a freshly added provider resolve through the
 * default provider row — the same pairing the summary line shows — and keep
 * the current value only when a real model stands behind it.
 */
export function hasResolvedDefaultModel(
  providers: readonly ProviderPublic[],
  defaultProviderId?: string,
  defaultModelId?: string,
): boolean {
  const provider = providers.find((candidate) => candidate.id === defaultProviderId);
  if (!provider) return false;
  return !!displayedDefaultModelId(provider, defaultModelId)?.trim();
}

/**
 * Whether the provider can run a chat default right now: enabled, credentialed
 * (API key, vendor login or none needed) and actually configuring at least one
 * non-image model.
 *
 * `defaultModelOptions` is the same expansion the default picker lists, so a
 * provider the picker would not offer cannot hold a default either.
 */
export function providerServesChatModels(
  provider: ProviderPublic,
  imageGeneration?: ImageGenerationBindings | null,
): boolean {
  return provider.enabled &&
    (provider.hasSecret || !!provider.hasOauth || provider.authKind === "none") &&
    defaultModelOptions([provider], imageGeneration).length > 0;
}

/**
 * Whether adding a provider must leave the app's chat default alone.
 *
 * `hasResolvedDefaultModel` alone only asks whether the default provider still
 * *names* a model, which a disabled or credential-less row does as well: every
 * session it launches then fails with `PROVIDER_SECRET_MISSING` while the
 * provider the user just configured is never used. The default therefore counts
 * as kept only while its provider is runnable — the same readiness the picker
 * and the provider rows demand.
 */
export function keepsAppDefaultModel(
  providers: readonly ProviderPublic[],
  defaultProviderId?: string,
  defaultModelId?: string,
  imageGeneration?: ImageGenerationBindings | null,
): boolean {
  const provider = providers.find((candidate) => candidate.id === defaultProviderId);
  if (!provider || !providerServesChatModels(provider, imageGeneration)) return false;
  return hasResolvedDefaultModel(providers, defaultProviderId, defaultModelId);
}
