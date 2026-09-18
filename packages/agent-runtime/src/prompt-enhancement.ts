import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@pi-desktop/shared";
import {
  PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT,
  renderPromptEnhancementUserPrompt,
  resolvePromptEnhancementTemplates,
  type PromptEnhancementTemplateOverrides,
} from "@pi-desktop/shared";
import { completeOneShot } from "./one-shot-complete.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

export type PromptEnhancementStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type PromptEnhancementOptions = PromptEnhancementTemplateOverrides & {
  signal?: AbortSignal;
  /** Test seam for a provider stream; production uses the resolved model registry. */
  stream?: PromptEnhancementStream;
  /** Conversation id forwarded to OpenCode as `x-opencode-session`. */
  sessionId?: string;
};

/**
 * Build the one-shot context from the effective templates. `overrides` carries
 * the user's saved templates; blank or missing values fall back to the shared
 * defaults.
 */
export function promptEnhancementContext(
  draft: string,
  overrides: PromptEnhancementTemplateOverrides = {},
): Context {
  const templates = resolvePromptEnhancementTemplates(overrides);
  return {
    systemPrompt: templates.systemPrompt,
    messages: [
      {
        role: "user",
        content: renderPromptEnhancementUserPrompt(draft, templates.userTemplate),
        timestamp: Date.now(),
      },
    ],
  };
}

/**
 * Models sometimes wrap an otherwise correct rewrite in quotation marks, or
 * answer with a quoted draft. Only a matching, wrapping pair is stripped: an
 * unmatched leading or trailing quote belongs to the text and is left alone.
 * Straight and curly single/double quotes are supported.
 */
const WRAPPING_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["\u201C", "\u201D"],
  ["\u2018", "\u2019"],
];

export function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  for (const [open, close] of WRAPPING_QUOTE_PAIRS) {
    if (trimmed.length <= open.length + close.length) continue;
    if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) continue;
    const inner = trimmed.slice(open.length, trimmed.length - close.length).trim();
    if (!inner) continue;
    // A genuine wrapping pair is the only place these quote characters occur:
    // `"a" and "b"` or `'it's fine'` keep their quotes.
    if (inner.includes(open) || inner.includes(close)) continue;
    return inner;
  }
  return trimmed;
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
    promptEnhancementContext(draft, options),
    thinkingLevel,
    {
      signal: options.signal,
      stream: options.stream,
      sessionId: options.sessionId,
      emptyErrorCode: "PROMPT_ENHANCEMENT_EMPTY",
      emptyErrorMessage: "The model returned an empty enhanced draft.",
    },
  );
  const stripped = stripWrappingQuotes(result.text);
  if (!stripped) {
    // A quote-only answer is not a usable rewrite: keep the same terminal
    // classification the empty-completion path uses.
    throw Object.assign(new Error("The model returned an empty enhanced draft."), {
      errorCode: "PROMPT_ENHANCEMENT_EMPTY",
    });
  }
  return stripped;
}

/**
 * Kept as a runtime-owned alias so existing callers and specs that name the
 * system prompt keep working now that the text lives in `@pi-desktop/shared`.
 */
export const PROMPT_ENHANCEMENT_SYSTEM_PROMPT =
  PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT;
