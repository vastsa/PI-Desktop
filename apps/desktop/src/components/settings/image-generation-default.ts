/**
 * Keeping the app's default image model across a provider save.
 *
 * `settings.imageGeneration` is the app default the Composer reads, while
 * `settings.imageGenerationModels` only lists the candidates the picker offers.
 * Saving a provider may extend that list, but adding one must not take over the
 * default: the chat default's rule applies here too — the stored choice
 * survives while a configured provider can actually run it, and only an
 * unrunnable or explicitly deselected one is replaced.
 *
 * "Can run it" is one rule everywhere: this file, the picker row
 * (`ImageGenerationModelRow.tsx`) and the runtime
 * (`electron/main/services/image-generation-service.ts`) all require an
 * enabled provider with a base URL, a usable credential and a model that
 * provider serves — either one it configures, or the image model a signed-in
 * vendor account answers with (see `imageModelOfferedByProvider`). A binding
 * that only looks present — disabled provider, missing credential, or a model
 * id the provider does not serve — fails at send time, so it must never be
 * kept as the default either.
 */
import {
  MAX_IMAGE_GENERATION_MODELS,
  imageGenerationBindings,
  imageModelOfferedByProvider,
  vendorAccountImageCandidates,
  type ImageGenerationBinding,
  type ImageProviderFacts,
  type ProviderPublic,
  modelWireIdsEqual as sameComposerModelId,
} from "@pi-desktop/shared";

/**
 * True when `provider` can actually run `modelId` for image generation now.
 *
 * The single source of truth for image availability: stricter than
 * `providerOffersModel`, which answers "does this row *name* the model" for the
 * display pairing and ignores whether the row is enabled or credentialed.
 */
export function imageGenerationBindingAvailable(
  provider: ProviderPublic | undefined,
  modelId: string,
): boolean {
  if (!provider || !provider.enabled) return false;
  return (
    !!provider.baseUrl &&
    (provider.hasSecret || provider.hasOauth === true || provider.authKind === "none") &&
    // Mirror image-generation-service's availability guard exactly: the same
    // model offer, so a choice the row shows can never fail at send time.
    imageModelOfferedByProvider(provider, modelId)
  );
}

/** True when the binding can be run by the enabled provider it names. */
export function resolvesImageGenerationDefault(
  binding: ImageGenerationBinding | null | undefined,
  providers: readonly ProviderPublic[],
): boolean {
  if (!binding) return false;
  const provider = providers.find((candidate) => candidate.id === binding.providerId);
  return imageGenerationBindingAvailable(provider, binding.modelId);
}

/**
 * Every binding the image-model picker offers, in the order it shows them: a
 * stored candidate list is the user's own selection, the single stored default
 * is the legacy fallback only while no list was ever saved, and a signed-in
 * vendor account contributes the image model it answers with — which its chat
 * model list does not carry.
 *
 * The row that renders these options and the settings page that accepts the
 * user's choice must read this one list. When they composed it separately, the
 * page validated against the narrower one, so picking the image model of a
 * signed-in ChatGPT (Codex) account saved nothing at all.
 */
export function imageGenerationPickerCandidates(
  stored: readonly ImageGenerationBinding[] | null | undefined,
  active: ImageGenerationBinding | null | undefined,
  providers: readonly ImageProviderFacts[],
): ImageGenerationBinding[] {
  const configured = Array.isArray(stored)
    ? imageGenerationBindings(stored, null)
    : imageGenerationBindings(undefined, active);
  return imageGenerationBindings(
    [...configured, ...vendorAccountImageCandidates(providers)],
    null,
  );
}

/** Whether `(providerId, modelId)` is one of the candidates a picker offered. */
export function isImageGenerationPickerCandidate(
  candidates: readonly ImageGenerationBinding[],
  providerId: string,
  modelId: string,
): boolean {
  return candidates.some((entry) =>
    entry.providerId === providerId && sameComposerModelId(entry.modelId, modelId),
  );
}

export type ImageGenerationDefaultDraft = {
  imageGenerationModels?: readonly ImageGenerationBinding[] | null;
  imageGeneration?: ImageGenerationBinding | null;
};

export type ImageGenerationDefaultPlan = {
  imageGenerationModels: ImageGenerationBinding[];
  imageGeneration: ImageGenerationBinding | null;
};

/**
 * Trim the candidate list to the host's cap without dropping the active
 * binding: the settings channel rejects a longer list outright, and losing the
 * default's own row would leave the picker unable to show what runs.
 */
function cappedImageGenerationCandidates(
  candidates: readonly ImageGenerationBinding[],
  active: ImageGenerationBinding | null,
): ImageGenerationBinding[] {
  if (candidates.length <= MAX_IMAGE_GENERATION_MODELS) return [...candidates];
  const activeIndex = active
    ? candidates.findIndex((candidate) =>
        candidate.providerId === active.providerId &&
        sameComposerModelId(candidate.modelId, active.modelId),
      )
    : -1;
  if (activeIndex < MAX_IMAGE_GENERATION_MODELS - 1) {
    return candidates.slice(0, MAX_IMAGE_GENERATION_MODELS);
  }
  const head = candidates
    .filter((_, index) => index !== activeIndex)
    .slice(0, MAX_IMAGE_GENERATION_MODELS - 1);
  return [...head, candidates[activeIndex]];
}

/**
 * The candidate list and active default a saved provider should leave behind.
 *
 * The saved provider's selection replaces its own earlier candidates, while the
 * candidates of other providers stay listed — minus the rows whose provider no
 * The active default moves only when explicitly deselected or no longer runnable,
 * and then to the first candidate that is, so a newly added provider claims the
 * default exactly when nothing else can hold it. Clearing every image model on
 * the provider that holds the default leaves it unchecked instead: another
 * provider's candidate stays available, but it is not checked automatically.
 * When nothing can run, the default stays empty rather than naming a binding
 * that would fail on the next request.
 */
export function planImageGenerationDefaults(
  current: ImageGenerationDefaultDraft,
  savedProviderId: string,
  selectedModelIds: readonly string[],
  providers: readonly ProviderPublic[],
  removedDefaultModel = false,
): ImageGenerationDefaultPlan {
  const existing = imageGenerationBindings(
    current.imageGenerationModels,
    current.imageGeneration,
  );
  const selected = [...new Set(selectedModelIds)].map((modelId) => ({
    providerId: savedProviderId,
    modelId,
  }));
  const previous = current.imageGeneration ?? null;
  const active = previous?.providerId === savedProviderId &&
    !selected.some((binding) => sameComposerModelId(binding.modelId, previous.modelId))
    ? null
    : previous;
  const imageGenerationModels = cappedImageGenerationCandidates(
    [...existing.filter((binding) => binding.providerId !== savedProviderId), ...selected]
      .filter((binding) =>
        providers.some((provider) => provider.id === binding.providerId),
      ),
    active,
  );
  const fallback = imageGenerationModels.find((binding) =>
    resolvesImageGenerationDefault(binding, providers)
  ) ?? null;
  const clearedActiveProvider =
    selected.length === 0 && previous?.providerId === savedProviderId;
  return {
    imageGenerationModels,
    imageGeneration: removedDefaultModel || clearedActiveProvider
      ? null
      : resolvesImageGenerationDefault(active, providers) ? active : fallback,
  };
}
