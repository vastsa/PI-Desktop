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
  type Model,
  type ModelAuth,
  type Models,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import {
  OPENCODE_GO_API_STYLE,
  OPENCODE_GO_BASE_URL,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import { genericModelConfig } from "./model-capabilities.js";
import type { ModelConfig } from "./thinking-level.js";

export type RuntimeProviderConfig = {
  id: string;
  name: string;
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

export function buildProviderModel(
  provider: RuntimeProviderConfig,
): Model<Api> {
  const binding = apiBindingForStyle(provider.apiStyle);
  const catalog = provider.modelConfig;
  const catalogModel = catalog
    ? (({ source: _source, ...model }) => model)(catalog)
    : genericModelConfig(provider.modelId, provider.baseUrl ?? binding.defaultBaseUrl);
  // OpenAI-compatible gateways are not guaranteed to implement the newer
  // `developer` role, even when the selected model supports reasoning. Keep
  // the broadest Chat Completions wire shape as the default; a catalog/model
  // override may opt into `developer` when the endpoint explicitly supports it.
  const compat =
    binding.api === "openai-completions"
      ? {
          ...(catalogModel.compat ?? {}),
          supportsDeveloperRole: catalogModel.compat?.supportsDeveloperRole === true,
        }
      : catalogModel.compat;
  return {
    ...catalogModel,
    id: provider.modelId,
    api: binding.api,
    provider: provider.id,
    baseUrl: provider.baseUrl ?? catalog?.baseUrl ?? binding.defaultBaseUrl,
    ...(compat ? { compat } : {}),
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
      api: apiBindingForStyle(provider.apiStyle).adapter(),
    }),
  );
  return models;
}
