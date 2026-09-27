import { isAIPlatformProvider, type PlatformProvider } from "./ai-platform.js";
import { bindingForCustomModel } from "./model-catalog.js";
import { imageGenerationBindings } from "./image-generation.js";
import type { AppSettings } from "./types/settings.js";
import type { ModelBinding } from "./types/models.js";

/** Product media routes, including task models omitted by /v1/models. */
export const PLATFORM_IMAGE_MODELS = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const;
export const PLATFORM_VIDEO_MODEL = "MiniMax-H3";
export const PLATFORM_MEDIA_MODELS = [...PLATFORM_IMAGE_MODELS, PLATFORM_VIDEO_MODEL] as const;

export function platformMediaKind(modelId: string | undefined): "image" | "video" | undefined {
  const id = modelId?.trim().toLowerCase();
  if (PLATFORM_IMAGE_MODELS.some(model => model.toLowerCase() === id)) return "image";
  if (id === PLATFORM_VIDEO_MODEL.toLowerCase()) return "video";
  return undefined;
}

/** Idempotent defaults; never mutate caller data or remove custom/chat models. */
export function platformMediaModelBindings(models: readonly ModelBinding[] = []): ModelBinding[] {
  const result = models.filter(model => !platformMediaKind(model.id));
  for (const id of PLATFORM_MEDIA_MODELS) {
    const existing = models.find(model => model.id.toLowerCase() === id.toLowerCase());
    result.push({ ...(existing ?? bindingForCustomModel(id)), id,
      thinkingLevels: [], defaultThinkingLevel: null, availableForSubagents: false,
      nativeWebSearch: false,
    });
  }
  return result;
}

/** Effective defaults are derived, so old profiles need no destructive migration. */
export function platformImageDefaults(
  settings: Pick<AppSettings, "imageGeneration" | "imageGenerationModels" | "defaultProviderId">,
  providers: readonly (PlatformProvider & { id: string; enabled?: boolean; hasSecret?: boolean })[],
) {
  const platform = providers.filter(isAIPlatformProvider);
  const candidates = imageGenerationBindings(settings.imageGenerationModels, settings.imageGeneration);
  for (const provider of platform) {
    for (const modelId of PLATFORM_IMAGE_MODELS) {
      if (!candidates.some(row => row.providerId === provider.id && row.modelId.toLowerCase() === modelId.toLowerCase()))
        candidates.push({ providerId: provider.id, modelId });
    }
  }
  const ready = platform.filter(provider => provider.enabled && provider.hasSecret);
  // Never guess another account if the selected default is unavailable.
  const provider = settings.defaultProviderId
    ? ready.find(row => row.id === settings.defaultProviderId)
    : ready.length === 1 ? ready[0] : undefined;
  return {
    imageGenerationModels: candidates,
    imageGeneration: settings.imageGeneration ?? (provider
      ? { providerId: provider.id, modelId: PLATFORM_IMAGE_MODELS[0] }
      : null),
  };
}
