/**
 * Host-owned one-shot completion used by prompt enhancement and plugin
 * `agent.complete`. No session history is implied: the caller supplies the
 * full Context. tools stay empty.
 */

import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { MessageUsage, ThinkingLevel } from "@pi-desktop/shared";
import { classifyAgentError } from "./agent-errors.js";
import { assistantContent, usageFromPi } from "./agent-messages.js";
import {
  buildProviderModel,
  copilotRequestHeaders,
  createProviderModels,
  type RuntimeProviderConfig,
} from "./provider-binding.js";
import {
  openCodeEndpointFromProvider,
  withOpenCodeSessionHeaders,
} from "./opencode-session-headers.js";
import { mergeProviderHeaders, withProviderHeaders } from "./provider-headers.js";
import {
  captureProviderResponse,
  createProviderRetryStream,
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  PROVIDER_TRANSIENT_MAX_RETRIES,
  isTransientProviderRetryCode,
} from "./provider-retry.js";

export type OneShotCompleteStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type OneShotCompleteOptions = {
  signal?: AbortSignal;
  stream?: OneShotCompleteStream;
  emptyErrorCode?: string;
  emptyErrorMessage?: string;
  /** Conversation id forwarded to OpenCode as `x-opencode-session`. */
  sessionId?: string;
};

export type OneShotCompleteResult = {
  text: string;
  usage?: MessageUsage;
};

function completeError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  retriable = false,
): Error & { errorCode: string; data?: Record<string, unknown> } {
  return Object.assign(new Error(message), {
    errorCode: code,
    data: { ...(details ?? {}), errorCode: code, retriable },
  });
}

/**
 * Run one independent completion with the caller's context and no tools.
 * Provider setup retries follow the same controller as the agent runtime.
 */
export async function completeOneShot(
  provider: RuntimeProviderConfig,
  context: Context,
  thinkingLevel: ThinkingLevel,
  options: OneShotCompleteOptions = {},
): Promise<OneShotCompleteResult> {
  const model = buildProviderModel(provider);
  const models = createProviderModels(provider, model);
  const streamSimple =
    options.stream ??
    ((requestModel, requestContext, streamOptions) =>
      models.streamSimple(requestModel, requestContext, streamOptions));
  let providerStatus: number | undefined;
  let providerHeaders: Record<string, string> | undefined;
  let transientRetryAttempt = 0;
  let rateLimitRetryAttempt = 0;

  const requestOptions: SimpleStreamOptions = withProviderHeaders(
    withOpenCodeSessionHeaders(
      {
        ...(options.signal ? { signal: options.signal } : {}),
        maxRetries: 0,
        ...(thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
        fetch: captureProviderResponse(undefined, (response) => {
          providerStatus = response?.status;
          providerHeaders = response?.headers;
        }),
      },
      {
        ...openCodeEndpointFromProvider(provider, model),
        sessionId: options.sessionId,
      },
    ),
    mergeProviderHeaders(
      copilotRequestHeaders(provider, context),
      provider.headers,
    ),
  );
  const stream = createProviderRetryStream(
    model,
    context,
    requestOptions,
    (retryOptions) => streamSimple(model, context, retryOptions),
    {
      claim: (error, phase) => {
        if (phase !== "request" || !error.retriable) return undefined;
        if (error.code === "PROVIDER_RATE_LIMITED") {
          if (rateLimitRetryAttempt >= PROVIDER_RATE_LIMIT_MAX_RETRIES) {
            return undefined;
          }
          rateLimitRetryAttempt += 1;
          return rateLimitRetryAttempt;
        }
        if (!isTransientProviderRetryCode(error.code)) return undefined;
        if (transientRetryAttempt >= PROVIDER_TRANSIENT_MAX_RETRIES) {
          return undefined;
        }
        transientRetryAttempt += 1;
        return transientRetryAttempt;
      },
      headers: () => providerHeaders,
      status: () => providerStatus,
    },
  );
  const result = await stream.result();

  if (result.stopReason === "aborted") {
    throw completeError("TURN_ABORTED", "The completion was aborted.");
  }
  if (result.stopReason === "error") {
    const classified = classifyAgentError(result.errorMessage || "Completion failed.");
    throw completeError(
      classified.code,
      classified.message,
      classified.details,
      classified.retriable,
    );
  }

  const text = assistantContent(result.content).text.trim();
  if (!text) {
    throw completeError(
      options.emptyErrorCode ?? "EMPTY_COMPLETION",
      options.emptyErrorMessage ?? "The model returned no text.",
    );
  }
  return { text, usage: usageFromPi(result.usage) };
}
