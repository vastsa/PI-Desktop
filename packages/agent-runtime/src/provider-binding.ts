/**
 * Product-owned inference boundary. Upstream adapters stay source-compatible,
 * but sessions, subagents and one-shot calls all construct models here.
 */
import {
  createModels, createProvider, type Api, type FetchFunction,
  type Model, type Models, type ProviderStreams,
} from "@earendil-works/pi-ai";
import {
  AI_PLATFORM_BASE_URL, assertAIPlatformProvider, assertAIPlatformRequestUrl,
  platformMediaKind,
} from "@pi-desktop/shared";
import {
  apiBindingForStyle, buildProviderModel as upstreamModel,
  runtimeBaseUrlForApi, type RuntimeProviderConfig,
} from "./provider-binding-upstream.js";

export type { RuntimeProviderConfig, ApiBinding } from "./provider-binding-upstream.js";
export {
  apiBindingForStyle, runtimeBaseUrlForApi, adapterAcceptsCustomFetch,
  copilotRequestHeaders, providerRequestKey, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS,
} from "./provider-binding-upstream.js";

export function apiBindingForProviderModel(provider: RuntimeProviderConfig) {
  assertAIPlatformProvider(provider);
  return apiBindingForStyle(provider.apiStyle ?? "chat_completions");
}

export function buildProviderModel(provider: RuntimeProviderConfig): Model<Api> {
  const binding = apiBindingForProviderModel(provider);
  if (platformMediaKind(provider.modelId))
    throw new Error("Use PlatformMedia for image/video models; select a chat model for conversation");
  const model = upstreamModel({
    ...provider,
    // A publisher catalog describes capability, never gateway routing/auth.
    ...(provider.modelConfig ? { modelConfig: {
      ...provider.modelConfig, api: binding.api,
      baseUrl: AI_PLATFORM_BASE_URL, headers: undefined,
    } } : {}),
  });
  return {
    ...model, api: binding.api,
    baseUrl: runtimeBaseUrlForApi(binding.api, AI_PLATFORM_BASE_URL),
    headers: undefined,
    // Completions has no native-search wire field. Do not silently switch API.
    webSearch: binding.api === "openai-completions" ? undefined : model.webSearch,
  };
}

export function createProviderModels(provider: RuntimeProviderConfig, model: Model<Api>): Models {
  const binding = apiBindingForProviderModel(provider);
  if (model.api !== binding.api || model.baseUrl !== runtimeBaseUrlForApi(binding.api, AI_PLATFORM_BASE_URL))
    throw new Error("Model endpoint/protocol override is unavailable");
  if (provider.resolveAuth) throw new Error("Vendor account authentication is unavailable in this edition");
  if (!provider.apiKey.trim()) throw new Error("Configure an AI Aggregation Platform API key in Settings > Models");
  const models = createModels();
  models.setProvider(createProvider({
    id: provider.id, name: provider.name, baseUrl: model.baseUrl,
    auth: { apiKey: {
      name: "AI Aggregation Platform API key",
      resolve: async () => ({ auth: { apiKey: provider.apiKey } }),
    } },
    models: [{ ...model, headers: undefined }], api: binding.adapter(),
  }));
  return models;
}

export function providerRequestFetch(api: Api | undefined, fetchFn: FetchFunction | undefined): FetchFunction {
  if (api && !["openai-completions", "openai-responses", "anthropic-messages"].includes(api))
    throw new Error("Unsupported platform model protocol");
  const transport = fetchFn ?? globalThis.fetch;
  return async (input, init) => {
    assertAIPlatformRequestUrl(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return transport(input, { ...init, redirect: "error" });
  };
}

export function createExtensionAgentModels(_input: {
  providerId: string; providerName: string; model: Model<Api>; stream: ProviderStreams;
}): Models {
  throw new Error("Extension-owned model transports are unavailable in the platform-only edition");
}
