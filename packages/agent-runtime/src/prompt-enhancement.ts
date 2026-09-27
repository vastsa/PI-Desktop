import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@pi-desktop/shared";
import { completeOneShot } from "./one-shot-complete.js";
import {
  PROMPT_ENHANCEMENT_SYSTEM_PROMPT,
  PROMPT_ENHANCEMENT_USER_PREFIX,
} from "./prompt-templates.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

export type PromptEnhancementStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type PromptEnhancementOptions = {
  signal?: AbortSignal;
  /** Test seam for a provider stream; production uses the resolved model registry. */
  stream?: PromptEnhancementStream;
  /** Conversation id forwarded to OpenCode as `x-opencode-session`. */
  sessionId?: string;
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
  const result = await completeOneShot(
    provider,
    promptEnhancementContext(draft),
    thinkingLevel,
    {
      signal: options.signal,
      stream: options.stream,
      sessionId: options.sessionId,
      emptyErrorCode: "PROMPT_ENHANCEMENT_EMPTY",
      emptyErrorMessage: "The model returned an empty enhanced draft.",
    },
  );
  return result.text;
}
