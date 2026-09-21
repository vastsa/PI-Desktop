import { describe, expect, it } from "vitest";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { DEEPSEEK_REASONING_REPLAY_PLACEHOLDER } from "@pi-desktop/shared";

// Guards the pnpm patch on @earendil-works/pi-ai (patches/@earendil-works__pi-ai@0.86.1.patch):
// DeepSeek-style endpoints accept a history where either every assistant message
// carries a reasoning field or none does, and reject a mix. A relayed model that
// is not in the catalogue has `reasoning: false`, so pi's per-message backfill
// never ran and a mixed history was sent as is (#223). OpenCode / third-party
// relays for DeepSeek V4.1 Flash further reject empty-string echoes (#296).

const baseCompat = {
  supportsDeveloperRole: false,
  supportsOpenAIGrammarTools: false,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek" as const,
  deferredToolsMode: "none" as const,
};

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

function assistantParams(
  messages: unknown[],
  compat: Record<string, unknown> = baseCompat,
  reasoning = false,
) {
  return convertMessages(
    model(reasoning),
    { systemPrompt: "", messages, tools: [] } as never,
    compat as never,
  )
    .filter((message) => message.role === "assistant")
    .map((message) => ({
      reasoning_content: (message as { reasoning_content?: unknown }).reasoning_content,
      reasoning_text: (message as { reasoning_text?: unknown }).reasoning_text,
    }));
}

describe("reasoning_content backfill for non-catalogue DeepSeek models", () => {
  it("fills an empty reasoning_content on assistant turns without thinking once any turn has it", () => {
    // #223
    const reasoning = assistantParams([
      user("first"),
      assistant([
        { type: "thinking", thinking: "let me think", thinkingSignature: "reasoning_content" },
        { type: "text", text: "thought answer" },
      ]),
      user("second"),
      assistant([{ type: "text", text: "plain answer" }]),
    ]);
    expect(reasoning).toEqual([
      { reasoning_content: "let me think", reasoning_text: undefined },
      { reasoning_content: "", reasoning_text: undefined },
    ]);
  });

  it("leaves a history without any thinking untouched", () => {
    // #223
    const reasoning = assistantParams([
      user("first"),
      assistant([{ type: "text", text: "one" }]),
      user("second"),
      assistant([{ type: "text", text: "two" }]),
    ]);
    expect(reasoning).toEqual([
      { reasoning_content: undefined, reasoning_text: undefined },
      { reasoning_content: undefined, reasoning_text: undefined },
    ]);
  });

  it("uses the documented non-empty placeholder when requiresNonEmptyReasoningReplay is set", () => {
    // #296
    const compat = {
      ...baseCompat,
      requiresNonEmptyReasoningReplay: true,
    };
    const reasoning = assistantParams(
      [
        user("first"),
        assistant([
          {
            type: "thinking",
            thinking: "real plan",
            thinkingSignature: "reasoning_content",
          },
          { type: "text", text: "thought answer" },
        ]),
        user("second"),
        assistant([{ type: "text", text: "plain answer" }]),
      ],
      compat,
    );
    expect(reasoning).toEqual([
      { reasoning_content: "real plan", reasoning_text: undefined },
      {
        reasoning_content: DEEPSEEK_REASONING_REPLAY_PLACEHOLDER,
        reasoning_text: undefined,
      },
    ]);
  });

  it("backfills reasoning_text when that is the field present on the history", () => {
    // #296 — DeepSeek V4.1 Flash / some relays echo reasoning_text
    const compat = {
      ...baseCompat,
      requiresNonEmptyReasoningReplay: true,
    };
    const reasoning = assistantParams(
      [
        user("first"),
        assistant([
          {
            type: "thinking",
            thinking: "real plan",
            thinkingSignature: "reasoning_text",
          },
          { type: "text", text: "thought answer" },
        ]),
        user("second"),
        assistant([{ type: "text", text: "plain answer" }]),
      ],
      compat,
    );
    expect(reasoning).toEqual([
      { reasoning_content: undefined, reasoning_text: "real plan" },
      {
        reasoning_content: undefined,
        reasoning_text: DEEPSEEK_REASONING_REPLAY_PLACEHOLDER,
      },
    ]);
  });

  it("restores thinking without a live signature when history rebuild stamps reasoning_content", () => {
    // #296 — historyToEntries must set thinkingSignature so this path is used
    const reasoning = assistantParams([
      user("summary"),
      assistant([
        {
          type: "thinking",
          thinking: "from prior turn",
          thinkingSignature: "reasoning_content",
        },
        { type: "text", text: "old answer" },
      ]),
      user("next"),
      assistant([
        {
          type: "thinking",
          thinking: "live think",
          thinkingSignature: "reasoning_content",
        },
        { type: "text", text: "new answer" },
      ]),
    ]);
    expect(reasoning.map((row) => row.reasoning_content)).toEqual([
      "from prior turn",
      "live think",
    ]);
  });

  it("fills empty reasoning_content for catalogue reasoning models with no thinking (#223)", () => {
    const reasoning = assistantParams(
      [
        user("first"),
        assistant([{ type: "text", text: "one" }]),
        user("second"),
        assistant([{ type: "text", text: "two" }]),
      ],
      baseCompat,
      true,
    );
    expect(reasoning).toEqual([
      { reasoning_content: "", reasoning_text: undefined },
      { reasoning_content: "", reasoning_text: undefined },
    ]);
  });
});
