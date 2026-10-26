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

/**
 * Vendors whose signed-in subscription account serves image models on the
 * vendor backend rather than through `provider.models`.
 *
 * A ChatGPT (Codex) account answers image generation and editing on the Codex
 * routes — `{baseUrl}/codex/images/generations` / `images/edits` — with the same
 * OAuth access token its chat traffic uses, so it needs no API key. Those image
 * models never appear in the vendor's chat model list, so the offer is defined
 * here instead of being smuggled into `provider.models`, where a chat picker
 * could then select an id the chat routes do not serve.
 *
 * The ids are ordered newest first and every one is verified against the
 * backend, so a user can fall back when a rollout does not reach their account.
 */
export const CODEX_IMAGE_VENDOR_KEY = "openai-codex";
export const CODEX_IMAGE_MODEL_IDS = ["gpt-image-2.5", "gpt-image-2"];

/** The provider fields the image rules read; anything else is ignored. */
export type ImageProviderFacts = {
  id?: string;
  vendorKey?: string;
  authKind?: string;
  /** True only once the vendor-account credential is actually stored. */
  hasOauth?: boolean;
  models?: readonly { id: string }[];
  ownerPluginId?: string;
  /** Host projection; runtime still rechecks the live declaration and grants. */
  pluginModelOperations?: Record<string, ("chat" | "images")[]>;
};

/**
 * Image model ids this provider offers beyond the models it configures.
 *
 * A vendor account must be signed in: an OAuth row without a stored credential
 * fails at send time, so it must not offer a choice either.
 */
export function vendorAccountImageModelIds(provider: ImageProviderFacts): string[] {
  return provider.authKind === "oauth" &&
    provider.hasOauth === true &&
    provider.vendorKey === CODEX_IMAGE_VENDOR_KEY
    ? [...CODEX_IMAGE_MODEL_IDS]
    : [];
}

/**
 * Whether the provider serves `modelId` for image generation.
 *
 * Configured models match exactly, mirroring the wire ids. A vendor account is
 * the exception in both directions: it offers the image models this module
 * knows its backend answers with, and it never runs one of its *chat* models —
 * only the vendors here have an image operation behind their OAuth token, and
 * inventing an entitlement for the rest would fail at send time.
 */
export function imageModelOfferedByProvider(
  provider: ImageProviderFacts,
  modelId: string,
): boolean {
  if (!modelId) return false;
  if (provider.ownerPluginId && provider.pluginModelOperations) {
    return (provider.authKind !== "oauth" || provider.hasOauth === true) &&
      (provider.models ?? []).some(model => model.id === modelId) &&
      provider.pluginModelOperations[modelId]?.includes("images") === true;
  }
  if (vendorAccountImageModelIds(provider).includes(modelId)) return true;
  if (provider.authKind === "oauth") return false;
  return (provider.models ?? []).some((model) => model.id === modelId);
}

/** Vendor-account image models as picker candidates, one row per account. */
export function vendorAccountImageCandidates(
  providers: readonly ImageProviderFacts[],
): ImageGenerationBinding[] {
  const candidates: ImageGenerationBinding[] = [];
  for (const provider of providers) {
    const providerId = provider.id;
    if (!providerId) continue;
    for (const modelId of vendorAccountImageModelIds(provider)) {
      candidates.push({ providerId, modelId });
    }
  }
  return candidates;
}
