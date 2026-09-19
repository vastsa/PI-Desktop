import { createImagesModels, createImagesProvider, type ImagesModel, type ImagesApi, type ImagesContext } from "@earendil-works/pi-ai";
import { openrouterImagesApi } from "@earendil-works/pi-ai/api/openrouter-images.lazy";
import type { RuntimeProviderConfig } from "../provider-binding.js";
import { EXTENSION_IMAGE_BYTES, imageMimeType, type ExtensionImageOptions } from "./image-contract.js";
import { openAIImagesAdapter } from "./openai-images.js";

/** Auth and collections come from pi; only the missing OpenAI Images adapter is local. */
export async function generateHostImages(provider: RuntimeProviderConfig, context: ImagesContext, options: ExtensionImageOptions = {}) {
  const openRouter = provider.vendorKey?.toLowerCase() === "openrouter";
  const model: ImagesModel<ImagesApi> = {
    id: provider.modelId, name: provider.modelId, provider: provider.id,
    api: openRouter ? "openrouter-images" : "openai-images",
    baseUrl: provider.baseUrl ?? "https://api.openai.com/v1",
    input: ["text", "image"], output: ["image", "text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  if (openRouter && [options.n, options.size, options.quality, options.background, options.outputFormat, options.editFormat].some((value) => value !== undefined)) {
    return { api: model.api, provider: model.provider, model: model.id, output: [], stopReason: "error" as const,
      errorMessage: "OpenRouter image options are not supported by the pinned pi adapter", timestamp: Date.now() };
  }
  const models = createImagesModels();
  models.setProvider(createImagesProvider({ id: provider.id, name: provider.name,
    auth: { apiKey: { name: provider.name, resolve: async () => ({ auth: provider.resolveAuth
      ? await provider.resolveAuth() : { apiKey: provider.apiKey } }) } },
    models: [model], api: openRouter ? openrouterImagesApi() : openAIImagesAdapter(options),
  }));
  const result = await models.generateImages(model, context, {
    signal: options.signal, timeoutMs: options.timeoutMs, maxRetries: 0,
    headers: provider.headers,
  });
  if (result.stopReason === "error") return { ...result, output: [],
    errorMessage: openRouter ? "OpenRouter image generation failed" : result.errorMessage };
  if (result.stopReason === "stop" && !result.output.some((part) => part.type === "image")) {
    return { ...result, output: [], stopReason: "error" as const, errorMessage: "Image provider returned no images" };
  }
  let bytes = 0;
  for (const part of result.output) {
    if (part.type !== "image") continue;
    const decoded = Buffer.from(part.data, "base64");
    bytes += decoded.length;
    if (decoded.toString("base64") !== part.data || imageMimeType(decoded) !== part.mimeType || bytes > EXTENSION_IMAGE_BYTES) {
      return { ...result, output: [], stopReason: "error" as const, errorMessage: "Invalid image output" };
    }
  }
  return result;
}
