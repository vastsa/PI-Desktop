import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@pi-desktop/shared";
import {
  PROMPT_ENHANCEMENT_SYSTEM_PROMPT,
  PROMPT_ENHANCEMENT_USER_PREFIX,
} from "./prompt-templates.js";
import {
  buildProviderModel,
  createProviderModels,
  type RuntimeProviderConfig,
} from "./provider-binding.js";
import {
  captureProviderResponse,
  createProviderRetryStream,
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  PROVIDER_TRANSIENT_MAX_RETRIES,
  isTransientProviderRetryCode,
} from "./provider-retry.js";
import { classifyAgentError } from "./agent-errors.js";

export type PromptEnhancementStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type PromptEnhancementOptions = {
  signal?: AbortSignal;
  /** Test seam for a provider stream; production uses the resolved model registry. */
  stream?: PromptEnhancementStream;
};

export function promptEnhancementContext(draft: string): Context {
  return {
    systemPrompt: PROMPT_ENHANCEMENT_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `${PROMPT_ENHANCEMENT_USER_PREFIX}${draft}`,
        timestamp: Date.now(),
      },
    ],
  };
}

function enhancementError(
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

function textFromAssistantMessage(message: Awaited<ReturnType<AssistantMessageEventStream["result"]>>): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

/**
 * Run one independent completion with no session history or tools.
 * Provider setup retries follow the same controller as the agent runtime.
 */
export async function enhancePromptDraft(
  provider: RuntimeProviderConfig,
  draft: string,
  thinkingLevel: ThinkingLevel,
  options: PromptEnhancementOptions = {},
): Promise<string> {
  const model = buildProviderModel(provider);
  const models = createProviderModels(provider, model);
  const streamSimple = options.stream ?? ((requestModel, context, streamOptions) =>
    models.streamSimple(requestModel, context, streamOptions));
  const context = promptEnhancementContext(draft);
  let providerStatus: number | undefined;
  let providerHeaders: Record<string, string> | undefined;
  let transientRetryAttempt = 0;
  let rateLimitRetryAttempt = 0;

  const requestOptions: SimpleStreamOptions = {
    ...(options.signal ? { signal: options.signal } : {}),
    maxRetries: 0,
    ...(thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
    fetch: captureProviderResponse(undefined, (response) => {
      providerStatus = response?.status;
      providerHeaders = response?.headers;
    }),
  };
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
        // Share the runtime's bounded transient budget so an upstream 502 does
        // not surface as an immediate enhancement failure.
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
    throw enhancementError("TURN_ABORTED", "Prompt enhancement was aborted.");
  }
  if (result.stopReason === "error") {
    const classified = classifyAgentError(
      result.errorMessage || "Prompt enhancement failed.",
    );
    throw enhancementError(
      classified.code,
      classified.message,
      classified.details,
      classified.retriable,
    );
  }

  const enhancedDraft = textFromAssistantMessage(result);
  if (!enhancedDraft) {
    throw enhancementError(
      "PROMPT_ENHANCEMENT_EMPTY",
      "The model returned an empty enhanced draft.",
    );
  }
  return enhancedDraft;
}
