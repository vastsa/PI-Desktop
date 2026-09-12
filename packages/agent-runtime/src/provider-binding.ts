/**
 * Provider/model wiring shared by the session runtime and its subagents.
 *
 * A subagent definition may pin its own provider and model, so building a
 * pi-ai `Models` registry is no longer something only the session runtime
 * does. Electron main still resolves credentials and catalog metadata; this
 * module only turns a resolved `RuntimeProviderConfig` into pi-ai objects.
 */

import {
  createModels,
  createProvider,
  type Api,
  type Context,
  type Model,
  type ModelAuth,
  type Models,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import {
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput,
} from "@earendil-works/pi-ai/api/github-copilot-headers";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import { GITHUB_COPILOT_MODELS } from "@earendil-works/pi-ai/providers/github-copilot.models";
import {
  OPENCODE_GO_API_STYLE,
  OPENCODE_GO_BASE_URL,
  resolveApiStyle,
  deepseekRequestCompat,
  zhipuRequestCompat,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import { genericModelConfig } from "./model-capabilities.js";
import type { ModelConfig } from "./thinking-level.js";

export type RuntimeProviderConfig = {
  id: string;
  name: string;
  vendorKey?: string;
  baseUrl?: string;
  modelId: string;
  apiKey: string;
  authKind?: string;
  /** Wire protocol for the endpoint (provider config apiStyle). */
  apiStyle?: string;
  supportsReasoning: boolean;
  supportedThinkingLevels: ThinkingLevel[];
  /** Complete model metadata resolved from models.dev by Electron main. */
  modelConfig?: ModelConfig;
  /**
   * Optional outbound HTTP headers. Empty/absent keeps adapter defaults.
   * Injected last via a fetch wrapper so Codex/Anthropic cannot overwrite them.
   */
  headers?: Record<string, string>;
  /**
   * Vendor-account auth, resolved once per request by Electron main.
   *
   * Injected by the sidecar, never part of the JSON launch payload: an OAuth
   * access token lives about an hour, so the sidecar holds no credential of
   * its own and asks for one — already refreshed if it had expired — at the
   * moment it signs a request.
   */
  resolveAuth?: () => Promise<ModelAuth>;
};

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;

export type ApiBinding = {
  api: Api;
  adapter: () => ProviderStreams;
  defaultBaseUrl: string;
};

/**
 * pi-ai's Anthropic SDK client appends `/v1` to its configured base URL.
 * Provider discovery accepts both an Anthropic root and a URL that already
 * includes `/v1`, so canonicalize the latter before runtime requests to keep
 * both forms on the same `/v1/messages` endpoint.
 */
export function runtimeBaseUrlForApi(api: Api, baseUrl: string): string {
  if (api !== "anthropic-messages") return baseUrl;
  const withoutTrailingSlash = baseUrl.replace(/\/+$/, "");
  const withoutVersion = withoutTrailingSlash.replace(/\/v1$/i, "");
  return withoutVersion || withoutTrailingSlash;
}

/** Map a stored provider apiStyle onto a pi-ai wire API. Unknown styles fall
 * back to OpenAI Chat Completions, the pre-apiStyle behavior. */
export function apiBindingForStyle(apiStyle?: string): ApiBinding {
  switch (apiStyle) {
    case OPENCODE_GO_API_STYLE:
      return {
        api: "openai-completions",
        adapter: openAICompletionsApi,
        defaultBaseUrl: OPENCODE_GO_BASE_URL,
      };
    case "responses":
      return {
        api: "openai-responses",
        adapter: openAIResponsesApi,
        defaultBaseUrl: "https://api.openai.com/v1",
      };
    case "anthropic_messages":
      return {
        api: "anthropic-messages",
        adapter: anthropicMessagesApi,
        defaultBaseUrl: "https://api.anthropic.com",
      };
    case "openai_codex_responses":
      // ChatGPT subscription endpoint. The adapter speaks Responses with the
      // Codex conversation envelope, which is not the public /v1/responses API.
      return {
        api: "openai-codex-responses",
        adapter: openAICodexResponsesApi,
        defaultBaseUrl: "https://chatgpt.com/backend-api",
      };
    case "pi_messages":
      return {
        api: "pi-messages",
        adapter: piMessagesApi,
        defaultBaseUrl: "https://radius.pi.dev",
      };
    case "google_generative_ai":
      return {
        api: "google-generative-ai",
        adapter: googleGenerativeAIApi,
        defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
      };
    default:
      return {
        api: "openai-completions",
        adapter: openAICompletionsApi,
        defaultBaseUrl: "https://api.openai.com/v1",
      };
  }
}

/** The key pi-ai signs requests with; `none` auth still needs a placeholder. */
export function providerRequestKey(provider: RuntimeProviderConfig): string {
  return (
    provider.apiKey || (provider.authKind === "none" ? "pi-desktop-no-auth" : "")
  );
}

/**
 * Resolve the wire API for one provider row. A catalog entry may pin a wire
 * API that differs from the provider-wide style (e.g. responses-only models
 * under an opencode_go provider, which defaults to Chat Completions). Honor
 * the model-level api when present so such models are not sent through the
 * wrong adapter (the gateway answers 500, see #105).
 */
export function apiBindingForProviderModel(provider: RuntimeProviderConfig): ApiBinding {
  return apiBindingForStyle(resolveApiStyle(provider.modelConfig?.api) ?? provider.apiStyle);
}

/**
 * The desktop stores OAuth accounts under local row UUIDs, while pi-ai's
 * native Copilot model records carry the required client identity headers.
 * Preserve those transport defaults without changing the row identity used by
 * auth binding and transcript ownership.
 */
function nativeCopilotHeaders(modelId: string): Record<string, string> | undefined {
  const model = modelId
    ? (GITHUB_COPILOT_MODELS as Record<string, Model<Api> | undefined>)[modelId]
    : undefined;
  if (model?.headers) return model.headers;

  // A model returned by models.dev or a user's Copilot entitlement may not be
  // present in pi-ai's pinned built-in catalog. Its transport still requires
  // the same client identity headers as every other Copilot model.
  return Object.values(GITHUB_COPILOT_MODELS).find((entry) => entry.headers)?.headers;
}

/** Add Copilot's request-context headers while retaining the local row id. */
export function copilotRequestHeaders(
  provider: Pick<RuntimeProviderConfig, "vendorKey">,
  context: Pick<Context, "messages">,
): Record<string, string> | undefined {
  if (provider.vendorKey?.trim().toLowerCase() !== "github-copilot") {
    return undefined;
  }
  return buildCopilotDynamicHeaders({
    messages: context.messages,
    hasImages: hasCopilotVisionInput(context.messages),
  });
}

export function buildProviderModel(
  provider: RuntimeProviderConfig,
): Model<Api> {
  const binding = apiBindingForProviderModel(provider);
  const catalog = provider.modelConfig;
  const catalogModel = catalog
    ? (({ source: _source, ...model }) => model)(catalog)
    : genericModelConfig(provider.modelId, provider.baseUrl ?? binding.defaultBaseUrl);
  const baseUrl = runtimeBaseUrlForApi(
    binding.api,
    provider.baseUrl ?? catalog?.baseUrl ?? binding.defaultBaseUrl,
  );
  const zhipuCompat = zhipuRequestCompat({
    vendorKey: provider.vendorKey,
    baseUrl,
  });
  const deepseekCompat = deepseekRequestCompat({
    vendorKey: provider.vendorKey,
    baseUrl,
    modelId: provider.modelId,
    family: catalogModel.family,
  });
  const copilotDefaults =
    provider.vendorKey?.trim().toLowerCase() === "github-copilot"
      ? nativeCopilotHeaders(provider.modelId)
      : undefined;
  const modelHeaders = {
    ...(copilotDefaults ?? {}),
    ...(catalogModel.headers ?? {}),
  };
  // OpenAI-compatible gateways are not guaranteed to implement the newer
  // `developer` role, even when the selected model supports reasoning. Keep
  // the broadest Chat Completions wire shape as the default; a catalog/model
  // override may opt into `developer` when the endpoint explicitly supports it.
  // Zhipu / Z.AI and DeepSeek-family Completions flags cannot use pi-ai's
  // provider-name detection: the row id stored as `model.provider` is a UUID.
  const compat =
    binding.api === "openai-completions"
      ? {
          ...(catalogModel.compat ?? {}),
          ...(zhipuCompat ?? {}),
          ...(deepseekCompat ?? {}),
          supportsDeveloperRole: catalogModel.compat?.supportsDeveloperRole === true,
        }
      : catalogModel.compat;
  return {
    ...catalogModel,
    id: provider.modelId,
    api: binding.api,
    provider: provider.id,
    baseUrl,
    ...(compat ? { compat } : {}),
    ...(Object.keys(modelHeaders).length > 0 ? { headers: modelHeaders } : {}),
  } as Model<Api>;
}

/** A single-model registry for one resolved provider. */
export function createProviderModels(
  provider: RuntimeProviderConfig,
  model: Model<Api>,
): Models {
  const requestKey = providerRequestKey(provider);
  const resolveAuth = provider.resolveAuth;
  const models = createModels();
  models.setProvider(
    createProvider({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      auth: {
        apiKey: {
          name: `${provider.name} API key`,
          // Plain apiKey semantics let each adapter emit its own auth header
          // (Bearer for OpenAI-style APIs, x-api-key for Anthropic, …).
          //
          // A vendor account resolves instead through Electron main, which
          // returns the whole `ModelAuth` — token, headers, and the
          // per-credential baseUrl GitHub Copilot hands out. pi-ai calls this
          // for every request and caches nothing, so a token that rotates
          // mid-session is picked up on the next one.
          resolve: async () =>
            resolveAuth
              ? { auth: await resolveAuth(), source: "OAuth" }
              : { auth: { apiKey: requestKey } },
        },
      },
      models: [model],
      api: apiBindingForProviderModel(provider).adapter(),
    }),
  );
  return models;
}
