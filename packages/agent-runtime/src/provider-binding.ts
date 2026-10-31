import { transcriptCompat } from "./transcript-compat.js";
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
  type FetchFunction,
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
  normalizeApiStyle,
  resolveNativeWebSearch,
  nativeWebSearchTransport,
  deepseekRequestCompat,
  zhipuRequestCompat,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import { genericModelConfig } from "./model-capabilities.js";
import { sessionAffinityCompat } from "./session-affinity.js";
import type { ModelConfig } from "./thinking-level.js";

export type RuntimeProviderConfig = {
  id: string;
  name: string;
  vendorKey?: string;
  baseUrl?: string;
  modelId: string;
  apiKey: string;
  authKind?: string;
  /** Plugin-owned trusted agent key when this is not a host provider row. */
  extensionAgentKey?: string;
  /** Wire protocol for the endpoint (provider config apiStyle). */
  apiStyle?: string;
  supportsReasoning: boolean;
  supportedThinkingLevels: ThinkingLevel[];
  /** Effective Pi model metadata resolved by Electron main. */
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

/**
 * Whether `api`'s pi-ai adapter accepts a caller-supplied `fetch`.
 *
 * The Google adapters throw unless `options.fetch` is `globalThis.fetch`
 * itself, and every wrapper this runtime builds is a different function, so a
 * request bound for them must carry no `fetch` at all (issue #1072). An
 * unknown wire API is treated as accepting one: only these two are known to
 * refuse, and the default must stay "inject" for everything else.
 */
export function adapterAcceptsCustomFetch(api: Api | undefined): boolean {
  return api !== "google-generative-ai" && api !== "google-vertex";
}

const NO_AUTH_REQUEST_KEY = "pi-desktop-no-auth";
const API_KEY_HEADERS = new Set(["api-key", "x-api-key", "x-goog-api-key"]);

function withoutNoAuthCredential(fetchFn: FetchFunction): FetchFunction {
  return (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    for (const [name, value] of [...headers]) {
      const normalizedName = name.toLowerCase();
      const trimmedValue = value.trim();
      const bearerValue = trimmedValue.slice(0, 7).toLowerCase() === "bearer "
        ? trimmedValue.slice(7).trim()
        : undefined;
      const isPlaceholderApiKey = API_KEY_HEADERS.has(normalizedName)
        && trimmedValue === NO_AUTH_REQUEST_KEY;
      const isPlaceholderAuthorization = normalizedName === "authorization"
        && (trimmedValue === NO_AUTH_REQUEST_KEY || bearerValue === NO_AUTH_REQUEST_KEY);
      if (isPlaceholderApiKey || isPlaceholderAuthorization) {
        headers.delete(name);
      }
    }
    return fetchFn(input, { ...(init ?? {}), headers });
  };
}

/**
 * The `fetch` one request may hand to `api`'s adapter: the caller's wrapper
 * where the adapter accepts one, otherwise nothing. Callers keep building the
 * wrapper (response capture, header override); this only decides whether it
 * reaches the adapter. No-auth requests also strip pi-ai's required placeholder
 * credential before the request leaves the runtime.
 */
export function providerRequestFetch(
  api: Api | undefined,
  fetchFn: FetchFunction | undefined,
  authKind?: string,
): FetchFunction | undefined {
  if (!adapterAcceptsCustomFetch(api)) return undefined;
  if (authKind !== "none") return fetchFn;
  return withoutNoAuthCredential(fetchFn ?? globalThis.fetch.bind(globalThis));
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

/** The API key pi-ai signs requests with; no-auth uses a stripped placeholder. */
export function providerRequestKey(provider: RuntimeProviderConfig): string {
  return provider.authKind === "none"
    ? NO_AUTH_REQUEST_KEY
    : provider.apiKey;
}

/**
 * Resolve the wire API for one provider row. A catalog entry may pin a wire
 * API that differs from the provider-wide style (e.g. responses-only models
 * under an opencode_go provider, which defaults to Chat Completions). Honor
 * the model-level api when compatible or when the provider has no explicit
 * wire style; never let a foreign-family catalog match (e.g. Google Generative AI
 * on a Gemini model served by an OpenAI-compatible relay) overwrite the provider's
 * wire protocol (see #105, #1310).
 */
export function apiBindingForProviderModel(provider: RuntimeProviderConfig): ApiBinding {
  return apiBindingForStyle(providerRequestTransport(provider).apiStyle);
}

function providerRequestTransport(provider: RuntimeProviderConfig) {
  const modelStyle = resolveApiStyle(provider.modelConfig?.api);
  const resolvedProviderStyle = resolveApiStyle(provider.apiStyle);
  const providerStyle = resolvedProviderStyle ?? (provider.apiStyle ? normalizeApiStyle(provider.apiStyle) : undefined);
  const customEndpoint = provider.vendorKey?.trim().toLowerCase() === "custom";
  const catalogBaseUrl =
    provider.modelConfig?.source === "models.dev" ? provider.modelConfig.baseUrl : undefined;
  const openCodeCatalogRoute =
    provider.vendorKey?.trim().toLowerCase() === "opencode-go" &&
    providerStyle === OPENCODE_GO_API_STYLE &&
    catalogBaseUrl !== undefined &&
    modelStyle === "anthropic_messages" &&
    catalogBaseUrl.trim().replace(/\/+$/, "").toLowerCase() !==
      provider.baseUrl?.trim().replace(/\/+$/, "").toLowerCase();
  const isOpenAiStyle = (style: string | undefined) =>
    style === "chat_completions" ||
    style === "responses" ||
    style === "openai_codex_responses" ||
    style === OPENCODE_GO_API_STYLE;
  const isCompatible =
    !providerStyle ||
    !modelStyle ||
    modelStyle === providerStyle ||
    (isOpenAiStyle(providerStyle) && isOpenAiStyle(modelStyle));
  // A custom endpoint's saved API format describes the user's actual gateway.
  // Published model metadata may describe another publisher's default adapter;
  // it cannot silently retarget that request. Other providers may use a
  // compatible model-level pin, such as OpenCode Go's Responses route (#105),
  // but foreign catalog protocols must not replace the provider's wire style.
  const apiStyle = customEndpoint
    ? provider.apiStyle ?? modelStyle
    : (openCodeCatalogRoute || isCompatible ? modelStyle : undefined) ?? provider.apiStyle;
  const baseUrl = openCodeCatalogRoute && catalogBaseUrl
    ? catalogBaseUrl
    : provider.baseUrl ?? provider.modelConfig?.baseUrl ?? apiBindingForStyle(apiStyle).defaultBaseUrl;
  return nativeWebSearchTransport({
    apiStyle,
    baseUrl,
    enabled: provider.modelConfig?.webSearch === true,
  });
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

  // A model returned by Pi or a user's Copilot entitlement may not be
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

/**
 * Row-scoped models bypass pi-ai's native Copilot Bearer branch, so the token
 * would leave as X-Api-Key. Send it as Bearer and null out X-Api-Key instead.
 * Keep apiKey set so the Anthropic SDK skips its default credential chain.
 * OpenAI-style adapters already sign an apiKey as Bearer.
 */
function copilotRequestAuth(
  provider: Pick<RuntimeProviderConfig, "vendorKey">,
  api: Api,
  auth: ModelAuth,
): ModelAuth {
  if (
    provider.vendorKey?.trim().toLowerCase() !== "github-copilot" ||
    api !== "anthropic-messages" ||
    !auth.apiKey
  ) {
    return auth;
  }
  const { apiKey, headers, ...rest } = auth;
  const requestHeaders: NonNullable<ModelAuth["headers"]> = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => {
      const lowerName = name.toLowerCase();
      return lowerName !== "authorization" && lowerName !== "x-api-key";
    }),
  );
  return {
    ...rest,
    apiKey,
    headers: { ...requestHeaders, Authorization: `Bearer ${apiKey}`, "X-Api-Key": null },
  };
}

/**
 * Claude models that publish an effort ladder without a `budget_tokens`
 * option (Opus 4.7+, Opus 5.x, Fable, ...) reject `thinking.type=enabled`
 * with a 400. pi-ai only sends adaptive thinking when
 * `compat.forceAdaptiveThinking` is set. Legacy projections can lack that
 * compatibility record, so derive the flag from published reasoning options.
 */
function requiresAdaptiveThinking(
  model: Pick<ModelConfig, "reasoning" | "reasoningOptions">,
): boolean {
  const options = model.reasoningOptions ?? [];
  return (
    model.reasoning &&
    options.some((option) => option.type === "effort") &&
    !options.some((option) => option.type === "budget_tokens")
  );
}

export function buildProviderModel(
  provider: RuntimeProviderConfig,
): Model<Api> {
  const binding = apiBindingForProviderModel(provider);
  const catalog = provider.modelConfig;
  const catalogModel = catalog
    ? (({ source: _source, transcriptBinding: _transcriptBinding, supportsReasoningEffort: _supportsReasoningEffort, nativeCost, ...model }) => ({
        ...model,
        ...(nativeCost ? { cost: nativeCost } : {}),
      }))(catalog)
    : {
        ...genericModelConfig(provider.modelId, provider.baseUrl ?? binding.defaultBaseUrl),
        reasoning: provider.supportsReasoning,
        supportedThinkingLevels: provider.supportedThinkingLevels,
      };
  const baseUrl = runtimeBaseUrlForApi(
    binding.api,
    providerRequestTransport(provider).baseUrl ?? binding.defaultBaseUrl,
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
    ...(provider.authKind === "none" && binding.api === "google-generative-ai"
      ? { "x-goog-api-key": "" }
      : {}),
  };
  const thinkingProtocolCompat = catalogModel.thinkingProtocol
    ? { forceAdaptiveThinking: catalogModel.thinkingProtocol === "adaptive" }
    : undefined;
  const autoAdaptiveThinking =
    catalogModel.thinkingProtocol === undefined && requiresAdaptiveThinking(catalogModel);
  // A generic model projection can still be present when the catalog misses a
  // model (#926). OAuth vendor rows may expose live-only Claude ids, so only
  // use the id heuristic for non-OAuth rows without protocol or options.
  const customClaudeId =
    catalog?.source === "generic" &&
    provider.authKind !== "oauth" &&
    catalogModel.reasoning === true &&
    catalogModel.thinkingProtocol === undefined &&
    (catalogModel.reasoningOptions?.length ?? 0) === 0 &&
    binding.api === "anthropic-messages" &&
    /claude/i.test(provider.modelId);
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
          ...(thinkingProtocolCompat ?? {}),
          ...(zhipuCompat ?? {}),
          ...(deepseekCompat ?? {}),
          // Only an explicit saved binding may override endpoint compatibility.
          ...(typeof catalog?.supportsReasoningEffort === "boolean"
            ? { supportsReasoningEffort: catalog.supportsReasoningEffort }
            : {}),
          supportsDeveloperRole: catalogModel.compat?.supportsDeveloperRole === true,
        }
      : binding.api === "anthropic-messages" &&
          (catalogModel.thinkingProtocol === "adaptive" ||
            autoAdaptiveThinking ||
            customClaudeId)
        ? {
            ...(catalogModel.compat ?? {}),
            ...(thinkingProtocolCompat ?? {}),
            // Explicit protocol selection wins, followed by per-model compat;
            // the Claude-id heuristic supplies only the missing default.
            forceAdaptiveThinking:
              thinkingProtocolCompat?.forceAdaptiveThinking ??
              catalogModel.compat?.forceAdaptiveThinking ??
              true,
          }
        : thinkingProtocolCompat
          ? { ...(catalogModel.compat ?? {}), ...thinkingProtocolCompat }
          : catalogModel.compat;
  return {
    ...catalogModel,
    id: provider.modelId,
    api: binding.api,
    provider: provider.extensionAgentKey ? provider.id : (provider.vendorKey?.trim() || provider.id),
    baseUrl,
    webSearch:
      resolveNativeWebSearch({
        wireApi: binding.api,
        modelWebSearch: catalogModel.webSearch,
      }) === "on"
        ? true
        : undefined,
    // The session-affinity default sits under the row's own compat, so a
    // catalog entry that already answers the question keeps its answer.
    compat: {
      ...(sessionAffinityCompat(provider, binding.api, baseUrl) ?? {}),
      ...compat,
      ...transcriptCompat(catalog, provider.modelId, binding.api, baseUrl),
    },
    ...(Object.keys(modelHeaders).length > 0 ? { headers: modelHeaders } : {}),
  } as Model<Api>;
}

/** Account-local operation registry. Vendor identity stays internal; auth stays row-scoped. */
export function createAccountModels(
  provider: RuntimeProviderConfig,
  operations: Pick<Parameters<typeof createProvider>[0], "models" | "api" | "images" | "classifiers">,
): Models {
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  const providerId = provider.extensionAgentKey ? provider.id : (provider.vendorKey?.trim() || provider.id);
  models.setProvider(createProvider({
    id: providerId,
    name: provider.name,
    baseUrl: provider.baseUrl,
    ...operations,
    models: operations.models.map((model) => ({ ...model, provider: providerId })),
    auth: {
      apiKey: {
        name: `${provider.name} credential`,
        resolve: async () => ({
          auth: provider.resolveAuth
            ? await provider.resolveAuth()
            : provider.authKind === "none" ? {} : { apiKey: providerRequestKey(provider) },
        }),
      },
    },
  }));
  return models;
}

/** A single account registry for an effective chat binding and optional other operations. */
export function createProviderModels(
  provider: RuntimeProviderConfig,
  model: Model<Api>,
  operations?: Pick<Parameters<typeof createProvider>[0], "models" | "images" | "classifiers">,
): Models {
  const resolveAuth = provider.resolveAuth;
  return createAccountModels({
    ...provider,
    resolveAuth: async () => resolveAuth
      ? copilotRequestAuth(provider, model.api, await resolveAuth())
      : { apiKey: providerRequestKey(provider) },
  }, {
    ...operations,
    models: [model, ...(operations?.models ?? [])],
    api: apiBindingForProviderModel(provider).adapter(),
  });
}
/** Build a pi-ai model collection for a trusted extension-owned agent. */
export function createExtensionAgentModels(input: {
  providerId: string;
  providerName: string;
  model: Model<Api>;
  stream: ProviderStreams;
}): Models {
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(
    createProvider({
      id: input.providerId,
      name: input.providerName,
      models: [input.model],
      auth: {
        apiKey: {
          name: `${input.providerName} plugin credential`,
          resolve: async () => ({ auth: { apiKey: "pi-desktop-plugin-agent" } }),
        },
      },
      api: input.stream,
    }),
  );
  return models;
}
