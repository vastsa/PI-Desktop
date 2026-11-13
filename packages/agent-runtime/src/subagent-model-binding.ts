import { createToolCallIdentity } from "./tool-call-dedupe.js";
import { accountModelStream, type UsageObserver } from "./request-usage.js";
import {
  buildProviderModel,
  copilotRequestHeaders,
  createProviderModels,
  providerRequestFetch,
  providerRequestKey,
  type RuntimeProviderConfig,
} from "./provider-binding.js";
import {
  openCodeEndpointFromProvider,
  withOpenCodeSessionHeaders,
} from "./opencode-session-headers.js";
import { withSessionAffinityOptions } from "./session-affinity.js";
import { mergeProviderHeaders, withProviderHeaders } from "./provider-headers.js";
import { clampOutputToContext, requestTranscript } from "./output-cap.js";
import {
  agentThinkingLevel as agentThinkingLevelFor,
  omitThinkingModel as withOmittedThinking,
} from "./thinking-level.js";
import { captureProviderResponse, carriesRetryDelayHeaders, createProviderRetryStream } from "./provider-retry.js";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { SubagentThinkingLevel } from "@pi-desktop/shared";
import type { ClassifiedAgentError } from "./agent-errors.js";
import type { ProviderFetchFailure } from "./provider-transport-recovery.js";
import type { SubagentProviderAttempt } from "./subagent-provider-attempt.js";

export type SubagentProviderRetryState = {
  headers?: Record<string, string>;
  status?: number;
  failure?: ProviderFetchFailure;
  initialDelayMs?: number;
  fixedDelayMs?: number;
  claim: (error: ClassifiedAgentError, phase: "request" | "stream") => number | undefined;
};

/** Freshly authorized binding for one ordered user message. */
export type SubagentMessageModel = {
  key: string;
  provider: RuntimeProviderConfig;
  thinkingLevel: SubagentThinkingLevel;
};

/** Transport and credentials for one exact provider/model; replace together on fallback. */
export function subagentModelBinding(opts: {
  provider: RuntimeProviderConfig;
  thinkingLevel: SubagentThinkingLevel;
  sessionId: string;
  maxTokens?: number;
  onUsage?: UsageObserver;
  uniqueToolCalls?: ReturnType<typeof createToolCallIdentity>;
  attempts?: SubagentProviderAttempt;
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
  const agentThinkingLevel = agentThinkingLevelFor(opts.thinkingLevel);
  // The Responses adapter's low-level stream still uses a model-level
  // `off` mapping as its fallback. Null it only for the omit path so the
  // provider receives no synthesized reasoning setting at all.
  const omitThinkingModel = omitThinking ? withOmittedThinking(model) : model;
  const requestKey = providerRequestKey(opts.provider);
  const uniqueToolCalls = opts.uniqueToolCalls ?? createToolCallIdentity();
  return {
    model,
    agentThinkingLevel,
    streamFn: (m, context, options) => {
      retry.headers = undefined;
      retry.status = undefined;
      retry.failure = undefined;
      const requestContext = requestTranscript(m, context);
      const requestOptions = withProviderHeaders(
        withOpenCodeSessionHeaders(
          {
            ...options,
            // Same request-side output cap as the parent runtime: the
            // `omit` branch hits pi-ai's low-level `stream` which never
            // re-derives max_tokens (issue B).
            maxTokens: clampOutputToContext(m, requestContext, options?.maxTokens),
            maxRetries: 0,
            sessionId: opts.sessionId,
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
        m.api,
      );
      // The conversation key rides the same options object the retry stream
      // reuses, so every attempt of this delegate carries the parent session's
      // id rather than only the first.
      const sessionOptions = withSessionAffinityOptions(requestOptions, {
        provider: opts.provider,
        api: m.api,
        baseUrl: m.baseUrl,
        sessionId: opts.sessionId,
      });
      return uniqueToolCalls(createProviderRetryStream(
        m,
        requestContext,
        sessionOptions,
        (retryOptions) => accountModelStream(m, () => {
          const create = (attemptOptions: typeof retryOptions, isCurrent = () => true) => {
            retry.headers = undefined;
            retry.status = undefined;
            retry.failure = undefined;
            const physicalOptions = {
              ...attemptOptions,
              fetch: providerRequestFetch(m.api, captureProviderResponse(options?.fetch, (response, _bytes, failure) => {
                // Abandoned transports may finish after a new binding is active.
                if (!isCurrent()) return;
                retry.failure = failure;
                retry.status = response?.status;
                retry.headers = carriesRetryDelayHeaders(response?.status) ? response?.headers : undefined;
              }), opts.provider.authKind),
            };
            return omitThinking
              ? models.stream(omitThinkingModel, requestContext, physicalOptions)
              : models.streamSimple(m, requestContext, physicalOptions);
          };
          return opts.attempts ? opts.attempts.stream(m, retryOptions, create) : create(retryOptions);
        }, {
          providerId: opts.provider.id,
          nativeCost: opts.provider.modelConfig?.nativeCost,
          onUsage: opts.onUsage,
        }),
        {
          claim: (error, phase) => retry.claim(error, phase),
          headers: () => retry.headers,
          status: () => retry.status,
          failure: () => retry.failure,
          initialDelayMs: retry.initialDelayMs,
          fixedDelayMs: retry.fixedDelayMs,
        },
      ), context.messages);
    },
    getApiKey: async () => requestKey || undefined,
  } satisfies Pick<AgentOptions, "streamFn" | "getApiKey"> & {
    model: typeof model;
    agentThinkingLevel: typeof agentThinkingLevel;
  };
}
