import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@pi-desktop/shared";
import { completeOneShot } from "./one-shot-complete.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

export const SESSION_TITLE_SUMMARIZE_SYSTEM_PROMPT =
  "You generate a short, concise, descriptive session title summarizing the conversation based on the user's initial prompt and context.\n" +
  "Rules:\n" +
  "1. Output ONLY the title text. Do NOT wrap in quotes, brackets, or backticks.\n" +
  "2. Do not include markdown formatting, trailing punctuation, or emojis.\n" +
  "3. Keep it under 25 characters (or 4-7 words).\n" +
  "4. Use the primary language of the user's prompt (e.g. Chinese for Chinese requests, English for English requests).\n" +
  "5. Focus on the key topic or action (e.g. \"Debug WebSocket reconnect\", \"重构用户认证模块\").";

export type SessionTitleSummarizeStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type SessionTitleSummarizeOptions = {
  signal?: AbortSignal;
  stream?: SessionTitleSummarizeStream;
  sessionId?: string;
};

export function sessionTitleSummarizeContext(
  userPrompt: string,
  assistantReply?: string,
): Context {
  const cleanPrompt = userPrompt.trim().slice(0, 1000);
  const cleanReply = assistantReply ? assistantReply.trim().slice(0, 500) : "";
  const content = cleanReply
    ? `User Prompt:\n${cleanPrompt}\n\nAssistant Response Summary:\n${cleanReply}`
    : `User Prompt:\n${cleanPrompt}`;

  return {
    systemPrompt: SESSION_TITLE_SUMMARIZE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content,
        timestamp: Date.now(),
      },
    ],
  };
}

export function cleanSummarizedTitle(raw: string): string {
  let text = raw.trim();
  // Remove markdown quotes, code blocks, bold markers
  text = text.replace(/^[`"'\u201c\u201d\u300c\u300d]+|[`"'\u201c\u201d\u300c\u300d]+$/g, "").trim();
  // Remove possible "Title: " prefix
  text = text.replace(/^(Title|Session Title|会话标题|标题)\s*[:：]\s*/i, "").trim();
  // Collapse whitespace
  text = text.replace(/\s+/g, " ");
  // Remove trailing period or punctuation
  text = text.replace(/[.。!！?？]+$/, "").trim();
  return text.slice(0, 80);
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
    sessionTitleSummarizeContext(userPrompt, assistantReply),
    thinkingLevel,
    {
      signal: options.signal,
      stream: options.stream,
      sessionId: options.sessionId,
      emptyErrorCode: "TITLE_SUMMARIZATION_EMPTY",
      emptyErrorMessage: "The model returned an empty session title.",
    },
  );
  return cleanSummarizedTitle(result.text);
}
