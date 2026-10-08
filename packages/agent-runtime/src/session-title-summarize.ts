import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@pi-desktop/shared";
import {
  SESSION_TITLE_DEFAULT_PROMPT,
  SESSION_TITLE_IDEAL_LENGTH_DEFAULT,
  SESSION_TITLE_MAX_LENGTH_DEFAULT,
  renderSessionTitleSystemPrompt,
  resolveSessionTitleSystemPrompt,
  resolveSessionTitleLengths,
  type SessionTitleSettingsOverrides,
} from "@pi-desktop/shared";
import { completeOneShot } from "./one-shot-complete.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

/**
 * The built-in prompt rendered with the default ideal length. Kept as a
 * runtime-owned alias so callers and specs that name it keep working now that
 * the text lives in `@pi-desktop/shared` (ADR 0322).
 */
export const SESSION_TITLE_SUMMARIZE_SYSTEM_PROMPT = renderSessionTitleSystemPrompt(
  SESSION_TITLE_DEFAULT_PROMPT,
  SESSION_TITLE_IDEAL_LENGTH_DEFAULT,
);

export type SessionTitleSummarizeStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * `customPrompt` / `prompt` / `idealLength` / `maxLength` carry the user's
 * saved settings; absent or unusable values fall back to the built-in prompt
 * and default lengths.
 */
export type SessionTitleSummarizeOptions = SessionTitleSettingsOverrides & {
  signal?: AbortSignal;
  stream?: SessionTitleSummarizeStream;
  sessionId?: string;
};

/**
 * Build the one-shot context. The system prompt is overridable; the user
 * message framing is built in so a custom prompt can never drop the
 * conversation content.
 */
export function sessionTitleSummarizeContext(
  userPrompt: string,
  assistantReply?: string,
  overrides: SessionTitleSettingsOverrides = {},
): Context {
  const cleanPrompt = userPrompt.trim().slice(0, 1000);
  const cleanReply = assistantReply ? assistantReply.trim().slice(0, 500) : "";
  const content = cleanReply
    ? `User Prompt:\n${cleanPrompt}\n\nAssistant Response Summary:\n${cleanReply}`
    : `User Prompt:\n${cleanPrompt}`;

  return {
    systemPrompt: resolveSessionTitleSystemPrompt(overrides),
    messages: [
      {
        role: "user",
        content,
        timestamp: Date.now(),
      },
    ],
  };
}

/**
 * Sanitize a model answer into a title, capped at `maxLength` Unicode code
 * points so a cut never leaves half a surrogate pair. This runs whatever the
 * prompt says, which is why the prompt itself can be user-editable.
 */
export function cleanSummarizedTitle(
  raw: string,
  maxLength: number = SESSION_TITLE_MAX_LENGTH_DEFAULT,
): string {
  let text = raw.trim();
  // Remove markdown quotes, code blocks, bold markers
  text = text.replace(/^[`"'\u201c\u201d\u300c\u300d]+|[`"'\u201c\u201d\u300c\u300d]+$/g, "").trim();
  // Remove possible "Title: " prefix
  text = text.replace(/^(Title|Session Title|会话标题|标题)\s*[:：]\s*/i, "").trim();
  // Collapse whitespace
  text = text.replace(/\s+/g, " ");
  // Remove trailing period or punctuation
  text = text.replace(/[.。!！?？]+$/, "").trim();
  const codePoints = [...text];
  return codePoints.length > maxLength ? codePoints.slice(0, maxLength).join("") : text;
}

/**
 * Run a one-shot completion to generate a smart summary title for a session.
 */
export async function summarizeSessionTitle(
  provider: RuntimeProviderConfig,
  userPrompt: string,
  assistantReply?: string,
  thinkingLevel: ThinkingLevel = "off",
  options: SessionTitleSummarizeOptions = {},
): Promise<string> {
  const result = await completeOneShot(
    provider,
    sessionTitleSummarizeContext(userPrompt, assistantReply, options),
    thinkingLevel,
    {
      signal: options.signal,
      stream: options.stream,
      sessionId: options.sessionId,
      emptyErrorCode: "TITLE_SUMMARIZATION_EMPTY",
      emptyErrorMessage: "The model returned an empty session title.",
    },
  );
  return cleanSummarizedTitle(result.text, resolveSessionTitleLengths(options).maxLength);
}
