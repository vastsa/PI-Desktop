import {
  buildProviderModel,
  copilotRequestHeaders,
  createProviderModels,
  providerRequestKey,
  type RuntimeProviderConfig,
} from "./provider-binding.js";
import {
  openCodeEndpointFromProvider,
  withOpenCodeSessionHeaders,
} from "./opencode-session-headers.js";
import { mergeProviderHeaders, withProviderHeaders } from "./provider-headers.js";
import { captureProviderResponse, carriesRetryDelayHeaders, createProviderRetryStream } from "./provider-retry.js";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { SubagentThinkingLevel } from "@pi-desktop/shared";
import type { ClassifiedAgentError } from "./agent-errors.js";

export type SubagentProviderRetryState = {
  headers?: Record<string, string>;
  status?: number;
  claim: (error: ClassifiedAgentError, phase: "request" | "stream") => number | undefined;
};

/** Transport and credentials for one exact provider/model; replace together on fallback. */
export function subagentModelBinding(opts: {
  provider: RuntimeProviderConfig;
  thinkingLevel: SubagentThinkingLevel;
  sessionId: string;
  maxTokens?: number;
}, retry: SubagentProviderRetryState) {
  // A definition may cap the delegate's own output (issue #171). The
  // catalog's published limit keeps applying otherwise, so this is an
  // override on the built model, never a substituted default. The adapters
  // derive max_tokens / max_completion_tokens / max_output_tokens from this
  // field, which is why the sibling `thinkingLevelMap` override below can
  // share the same object.
  const builtModel = buildProviderModel(opts.provider);
  const model =
    opts.maxTokens !== undefined
      ? { ...builtModel, maxTokens: opts.maxTokens }
      : builtModel;
  const models = createProviderModels(opts.provider, model);
  const omitThinking = opts.thinkingLevel === "omit";
  const agentThinkingLevel =
    opts.thinkingLevel === "omit" ? "off" : opts.thinkingLevel;
  // The Responses adapter's low-level stream still uses a model-level
  // `off` mapping as its fallback. Null it only for the omit path so the
  // provider receives no synthesized reasoning setting at all.
  const omitThinkingModel = omitThinking
    ? {
        ...model,
        thinkingLevelMap: { ...model.thinkingLevelMap, off: null },
      }
    : model;
  const requestKey = providerRequestKey(opts.provider);
  return {
    model,
    agentThinkingLevel,
    streamFn: (m, context, options) => {
      retry.headers = undefined;
      retry.status = undefined;
      const requestOptions = withProviderHeaders(
        withOpenCodeSessionHeaders(
          {
            ...options,
            maxRetries: 0,
            sessionId: opts.sessionId,
            fetch: captureProviderResponse(options?.fetch, (response) => {
              retry.status = response?.status;
              retry.headers = carriesRetryDelayHeaders(
                response?.status,
              )
                ? response?.headers
                : undefined;
            }),
          },
          {
            ...openCodeEndpointFromProvider(opts.provider, m),
            sessionId: opts.sessionId,
          },
        ),
        mergeProviderHeaders(
          copilotRequestHeaders(opts.provider, context),
          opts.provider.headers,
        ),
      );
      return createProviderRetryStream(
        m,
        context,
        requestOptions,
        (retryOptions) =>
          omitThinking
            ? models.stream(omitThinkingModel, context, retryOptions)
            : models.streamSimple(m, context, retryOptions),
        {
          claim: (error, phase) => retry.claim(error, phase),
          headers: () => retry.headers,
          status: () => retry.status,
        },
      );
    },
    getApiKey: async () => requestKey || undefined,
  } satisfies Pick<AgentOptions, "streamFn" | "getApiKey"> & {
    model: typeof model;
    agentThinkingLevel: typeof agentThinkingLevel;
  };
}
