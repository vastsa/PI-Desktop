/** Image bindings use complete wire ids; catalog alias matching is not identity. */
function sameImageModelId(left: string, right: string): boolean {
  const requested = right.trim().toLowerCase();
  return requested.length > 0 && left.trim().toLowerCase() === requested;
}

/** A single host-owned binding, independent of the default conversation model. */
export type ImageGenerationBinding = { providerId: string; modelId: string };
export type ImageGenerationBindings =
  | ImageGenerationBinding
  | readonly ImageGenerationBinding[];

function sameImageGenerationBinding(
  left: ImageGenerationBinding,
  right: ImageGenerationBinding,
): boolean {
  return left.providerId === right.providerId && sameImageModelId(left.modelId, right.modelId);
}

/** Resolve the multi-select candidates, with legacy single-binding fallback. */
export function imageGenerationBindings(
  candidates: readonly ImageGenerationBinding[] | null | undefined,
  active: ImageGenerationBinding | null | undefined,
): ImageGenerationBinding[] {
  const source = candidates === undefined ? (active ? [active] : []) : candidates ?? [];
  const result: ImageGenerationBinding[] = [];
  for (const candidate of source) {
    if (!result.some((entry) => sameImageGenerationBinding(entry, candidate))) {
      result.push(candidate);
    }
  }
  if (active && !result.some((entry) => sameImageGenerationBinding(entry, active))) {
    result.push(active);
  }
  return result;
}

export function isImageGenerationModel(
  binding: ImageGenerationBindings | null | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
): boolean {
  const bindings = Array.isArray(binding) ? binding : binding ? [binding] : [];
  return !!providerId && !!modelId && bindings.some((entry) =>
    entry.providerId === providerId && sameImageModelId(entry.modelId, modelId),
  );
}
export const MAX_GENERATED_IMAGES = 10;
export const IMAGE_GENERATION_TIMEOUT_MS = 180_000;
export const IMAGE_BATCH_TIMEOUT_MS = 950_000;
export type ImageGenerationItem = { prompt: string; count?: number; images?: string[] };
export type ImageGenerationInput = { items: ImageGenerationItem[] };
export type GeneratedImageResult = {
  index: number;
  status: "succeeded" | "failed" | "cancelled";
  path?: string;
  mimeType?: string;
  errorCode?: string;
};

function invalid(message: string): never {
  throw Object.assign(new Error(message), { errorCode: "INVALID_ARGUMENT" });
}

export function parseImageGenerationBinding(value: unknown): ImageGenerationBinding | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    invalid("imageGeneration must be an object");
  const record = value as Record<string, unknown>;
  const field = (name: string, max: number) => {
    const raw = record[name];
    if (typeof raw !== "string" || !raw.trim() || raw.length > max)
      invalid(`imageGeneration.${name} is invalid`);
    return raw.trim();
  };
  return { providerId: field("providerId", 128), modelId: field("modelId", 256) };
}

export const MAX_IMAGE_GENERATION_MODELS = 128;

export function parseImageGenerationBindings(
  value: unknown,
): ImageGenerationBinding[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) invalid("imageGenerationModels must be an array");
  if (value.length > MAX_IMAGE_GENERATION_MODELS) {
    invalid(`imageGenerationModels must contain at most ${MAX_IMAGE_GENERATION_MODELS} models`);
  }
  return value.map((entry) => {
    const binding = parseImageGenerationBinding(entry);
    if (!binding) invalid("imageGenerationModels contains an invalid binding");
    return binding;
  });
}

/** Expand variants into individually accountable requests; never silently truncate. */
export function imageGenerationItems(value: unknown): ImageGenerationItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("items are required");
  const items = (value as Record<string, unknown>).items;
  if (!Array.isArray(items) || !items.length || items.length > MAX_GENERATED_IMAGES)
    invalid("items must contain 1–10 entries");
  const prompts: ImageGenerationItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("invalid image item");
    const { prompt, count = 1, images } = item as Record<string, unknown>;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 32_000)
      invalid("prompt must contain 1–32000 characters");
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_GENERATED_IMAGES
    )
      invalid("count must be an integer from 1 to 10");
    if (
      images != null &&
      (!Array.isArray(images) ||
        images.length > 4 ||
        images.some((path) => typeof path !== "string" || !path.trim() || path.length > 4096))
    )
      invalid("images must contain at most 4 local image paths");
    for (let i = 0; i < count; i++)
      prompts.push({
        prompt: prompt.trim(),
        ...(Array.isArray(images) && images.length
          ? { images: (images as string[]).map((path) => path.trim()) }
          : {}),
      });
    if (prompts.length > MAX_GENERATED_IMAGES)
      invalid("at most 10 images may be generated per batch");
  }
  return prompts;
}

export function imageGenerationPrompts(value: unknown): string[] {
  return imageGenerationItems(value).map((item) => item.prompt);
}
