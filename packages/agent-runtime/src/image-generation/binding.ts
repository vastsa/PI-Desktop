import type { ImageApi, ImageModel, Models, ProviderImages } from "@earendil-works/pi-ai";
import * as openrouterImages from "@earendil-works/pi-ai/api/openrouter-images";
import { createAccountModels, type RuntimeProviderConfig } from "../provider-binding.js";
import { CODEX_IMAGE_VENDOR_KEY } from "@pi-desktop/shared";
import {
  OPENAI_IMAGES_API,
  codexImagesBaseUrl,
  openAIImagesAdapter,
} from "./openai-images.js";
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
  customImages?: ProviderImages;
};
export type ImageBinding = { models: Models; model: ImageModel<ImageApi>; accountId?: string };

/**
 * Whether this endpoint is a signed-in Codex (ChatGPT) account.
 *
 * Such an account serves image generation and editing on the vendor's Codex
 * routes with the same OAuth access token its chat traffic uses. Its image
 * models live outside the shared model catalog, so the catalog is not consulted
 * and the OpenAI Images wire format is used on both routes.
 */
function isCodexImageEndpoint(endpoint: ImageEndpoint): boolean {
  return endpoint.authKind === "oauth" &&
    endpoint.vendorKey?.trim() === CODEX_IMAGE_VENDOR_KEY;
}

/** An explicitly marked legacy image binding is an operation override, not chat capability inference. */
export function createImageBinding(endpoint: ImageEndpoint, downloads: ImageDownloadOptions = {}): ImageBinding {
  const providerId = endpoint.vendorKey?.trim() || endpoint.providerId || "pi-desktop-images";
  const codexImages = isCodexImageEndpoint(endpoint);
  const known = codexImages || endpoint.customImages ? undefined : endpoint.nativeModel;
  if (known && (known.type !== "image" || known.id !== endpoint.modelId || known.api !== "openrouter-images" && known.api !== OPENAI_IMAGES_API))
    throw imageError("IMAGE_MODEL_UNAVAILABLE");
  const native = known?.api === "openrouter-images" || providerId === "openrouter";
  // OAuth must have an actual image operation, not an invented entitlement:
  // OpenRouter's native one, or the Codex routes behind the account's token.
  const oauthImageApi = codexImages
    ? !!endpoint.resolveAuth
    : known?.api === "openrouter-images" && !!endpoint.resolveAuth;
  if (endpoint.authKind === "oauth" && !oauthImageApi && !endpoint.customImages)
    throw imageError("IMAGE_AUTH_UNSUPPORTED");
  const model: ImageModel<ImageApi> = {
    ...(known ?? {
      type: "image", name: endpoint.modelId, input: ["text", "image"], output: ["image", "text"],
      // NaN denotes unavailable prices; never expose a fabricated zero cost.
      cost: { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN },
    }),
    id: endpoint.modelId, provider: providerId,
    api: endpoint.customImages ? "plugin-images-v1" : native ? "openrouter-images" : OPENAI_IMAGES_API,
    baseUrl: codexImages ? codexImagesBaseUrl(endpoint.baseUrl) : endpoint.baseUrl,
    headers: endpoint.headers,
  };
  const models = createAccountModels({
    id: endpoint.providerId ?? providerId, vendorKey: endpoint.vendorKey,
    name: providerId, modelId: model.id, baseUrl: model.baseUrl,
    apiKey: endpoint.apiKey ?? "", authKind: endpoint.authKind ?? (endpoint.apiKey ? "api_key" : "none"),
    resolveAuth: endpoint.resolveAuth, supportsReasoning: false, supportedThinkingLevels: [],
  }, {
    models: [model],
    images: {
      [model.api]: endpoint.customImages ?? (native
        ? openrouterImages
        : openAIImagesAdapter(downloads, codexImages ? "codex-json" : "multipart")),
    },
  });
  return { models, model, accountId: endpoint.providerId };
}
