import type { ImageApi, ImageModel, Models } from "@earendil-works/pi-ai";
import * as openrouterImages from "@earendil-works/pi-ai/api/openrouter-images";
import { createAccountModels, type RuntimeProviderConfig } from "../provider-binding.js";
import { OPENAI_IMAGES_API, openAIImagesAdapter } from "./openai-images.js";
import { imageError, type ImageDownloadOptions } from "./download.js";

export type ImageEndpoint = {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  headers?: Record<string, string>;
  providerId?: string;
  vendorKey?: string;
  authKind?: string;
  resolveAuth?: RuntimeProviderConfig["resolveAuth"];
  /** Effective typed model from the host's shared Pi account registry. */
  nativeModel?: ImageModel<ImageApi>;
};
export type ImageBinding = { models: Models; model: ImageModel<ImageApi>; accountId?: string };

/** An explicitly marked legacy image binding is an operation override, not chat capability inference. */
export function createImageBinding(endpoint: ImageEndpoint, downloads: ImageDownloadOptions = {}): ImageBinding {
  const providerId = endpoint.vendorKey?.trim() || endpoint.providerId || "pi-desktop-images";
  const known = endpoint.nativeModel;
  if (known && (known.type !== "image" || known.id !== endpoint.modelId || known.api !== "openrouter-images" && known.api !== OPENAI_IMAGES_API))
    throw imageError("IMAGE_MODEL_UNAVAILABLE");
  const native = known?.api === "openrouter-images" || providerId === "openrouter";
  // OAuth must have an actual native image operation, not an invented entitlement.
  if (endpoint.authKind === "oauth" && (known?.api !== "openrouter-images" || !endpoint.resolveAuth))
    throw imageError("IMAGE_AUTH_UNSUPPORTED");
  const model: ImageModel<ImageApi> = {
    ...(known ?? {
      type: "image", name: endpoint.modelId, input: ["text", "image"], output: ["image", "text"],
      // NaN denotes unavailable prices; never expose a fabricated zero cost.
      cost: { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN },
    }),
    id: endpoint.modelId, provider: providerId,
    api: native ? "openrouter-images" : OPENAI_IMAGES_API,
    baseUrl: endpoint.baseUrl, headers: endpoint.headers,
  };
  const models = createAccountModels({
    id: endpoint.providerId ?? providerId, vendorKey: endpoint.vendorKey,
    name: providerId, modelId: model.id, baseUrl: model.baseUrl,
    apiKey: endpoint.apiKey ?? "", authKind: endpoint.authKind ?? (endpoint.apiKey ? "api_key" : "none"),
    resolveAuth: endpoint.resolveAuth, supportsReasoning: false, supportedThinkingLevels: [],
  }, {
    models: [model],
    images: { [model.api]: native ? openrouterImages : openAIImagesAdapter(downloads) },
  });
  return { models, model, accountId: endpoint.providerId };
}
