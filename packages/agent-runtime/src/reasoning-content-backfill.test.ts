import { describe, expect, it } from "vitest";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";

// Guards the pnpm patch on @earendil-works/pi-ai (patches/@earendil-works__pi-ai@0.85.1.patch):
// DeepSeek-style endpoints accept a history where either every assistant message
// carries reasoning_content or none does, and reject a mix. A relayed model that
// is not in the catalogue has `reasoning: false`, so pi's per-message backfill
// never ran and a mixed history was sent as is (#223).

const compat = {
  supportsDeveloperRole: false,
  supportsOpenAIGrammarTools: false,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek",
  deferredToolsMode: "none",
} as never;

function model(reasoning: boolean) {
  return {
    id: "deepseek-relay",
    name: "deepseek-relay",
    api: "openai-completions",
    provider: "custom-relay",
    baseUrl: "https://relay.example/v1",
    reasoning,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {},
  } as never;
}

function assistant(content: unknown[]) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "custom-relay",
    model: "deepseek-relay",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
    content,
  };
}

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });

function assistantParams(messages: unknown[]) {
  return convertMessages(model(false), { systemPrompt: "", messages, tools: [] } as never, compat)
    .filter((message) => message.role === "assistant")
    .map((message) => (message as { reasoning_content?: unknown }).reasoning_content);
}

describe("reasoning_content backfill for non-catalogue DeepSeek models", () => {
  it("fills an empty reasoning_content on assistant turns without thinking once any turn has it", () => {
    const reasoning = assistantParams([
      user("first"),
      assistant([
        { type: "thinking", thinking: "let me think", thinkingSignature: "reasoning_content" },
        { type: "text", text: "thought answer" },
      ]),
      user("second"),
      assistant([{ type: "text", text: "plain answer" }]),
    ]);
    expect(reasoning).toEqual(["let me think", ""]);
  });

  it("leaves a history without any thinking untouched", () => {
    const reasoning = assistantParams([
      user("first"),
      assistant([{ type: "text", text: "one" }]),
      user("second"),
      assistant([{ type: "text", text: "two" }]),
    ]);
    expect(reasoning).toEqual([undefined, undefined]);
  });
});
