import { describe, expect, it } from "vitest";
import type {
  AgentMessage,
  CompactionEntry,
  MessageEntry,
} from "@earendil-works/pi-agent-core";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { DEEPSEEK_REASONING_REPLAY_PLACEHOLDER } from "@pi-desktop/shared";
import {
  alignRetainedReasoningIdentity,
  harvestRetainedReasoning,
  retainedReasoningFromDetails,
  retainedReasoningToMessages,
  RETAINED_REASONING_CONTENT_STANDIN,
  RETAINED_REASONING_PROVIDER,
  type ReasoningReplayIdentity,
} from "./reasoning-replay.js";
import { buildSessionContext } from "./session-context.js";

const liveIdentity: ReasoningReplayIdentity = {
  api: "openai-completions",
  provider: "custom-relay",
  model: "deepseek-relay",
};

function assistant(
  thinking: string,
  text = "ok",
  thinkingSignature = "reasoning_content",
): AgentMessage {
  const content: unknown[] = [
    { type: "thinking", thinking, thinkingSignature },
  ];
  if (text) content.push({ type: "text", text });
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "local",
    model: "local",
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
  } as AgentMessage;
}

describe("harvestRetainedReasoning", () => {
  it("keeps the newest thinking turns and skips thinking-less assistants", () => {
    // #296
    const turns = harvestRetainedReasoning(
      [
        { role: "user", content: "a", timestamp: 1 },
        assistant("plan one", "answer one"),
        { role: "user", content: "b", timestamp: 2 },
        {
          role: "assistant",
          api: "openai-completions",
          provider: "local",
          model: "local",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
          content: [{ type: "text", text: "no think" }],
        } as AgentMessage,
        { role: "user", content: "c", timestamp: 3 },
        assistant("plan two", "answer two"),
      ],
      3,
    );
    expect(turns).toEqual([
      {
        thinking: "plan one",
        text: "answer one",
        thinkingSignature: "reasoning_content",
        api: "openai-completions",
        provider: "local",
        model: "local",
      },
      {
        thinking: "plan two",
        text: "answer two",
        thinkingSignature: "reasoning_content",
        api: "openai-completions",
        provider: "local",
        model: "local",
      },
    ]);
  });

  it("preserves a live Completions thinkingSignature when known", () => {
    // #296
    const turns = harvestRetainedReasoning([
      assistant("flash plan", "flash answer", "reasoning_text"),
    ]);
    expect(turns[0]).toMatchObject({
      thinking: "flash plan",
      text: "flash answer",
      thinkingSignature: "reasoning_text",
    });
  });
});

describe("retainedReasoning replay messages", () => {
  it("round-trips details into assistants stamped for Completions replay", () => {
    // #296
    const details = {
      retainedReasoning: [{ thinking: "kept plan", text: "kept answer" }],
    };
    const messages = retainedReasoningToMessages(
      retainedReasoningFromDetails(details),
      10,
      liveIdentity,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.provider).toBe(liveIdentity.provider);
    expect(messages[0]?.model).toBe(liveIdentity.model);
    expect(messages[0]?.content).toEqual([
      {
        type: "thinking",
        thinking: "kept plan",
        thinkingSignature: "reasoning_content",
      },
      { type: "text", text: "kept answer" },
    ]);
  });

  it("uses a non-empty content stand-in for thinking-only retained turns", () => {
    // #296 — convertMessages would otherwise drop empty-text assistants
    const messages = retainedReasoningToMessages(
      [{ thinking: "think only", text: "" }],
      1,
      liveIdentity,
    );
    expect(messages[0]?.content).toEqual([
      {
        type: "thinking",
        thinking: "think only",
        thinkingSignature: "reasoning_content",
      },
      { type: "text", text: RETAINED_REASONING_CONTENT_STANDIN },
    ]);
  });

  it("replays a preserved thinkingSignature instead of hardcoding reasoning_content", () => {
    // #296
    const messages = retainedReasoningToMessages(
      [
        {
          thinking: "flash plan",
          text: "flash answer",
          thinkingSignature: "reasoning_text",
        },
      ],
      1,
      liveIdentity,
    );
    expect(messages[0]?.content[0]).toMatchObject({
      type: "thinking",
      thinkingSignature: "reasoning_text",
    });
  });

  it("aligns sentinel retained assistants to the live model identity", () => {
    const [message] = retainedReasoningToMessages(
      [{ thinking: "plan", text: "answer" }],
      1,
    );
    expect(message?.provider).toBe(RETAINED_REASONING_PROVIDER);
    const aligned = alignRetainedReasoningIdentity(
      [message!],
      liveIdentity,
    );
    expect(aligned[0]).toMatchObject(liveIdentity);
  });
});

describe("retained reasoning reaches convertMessages after compaction", () => {
  const strictCompat = {
    supportsDeveloperRole: false,
    supportsOpenAIGrammarTools: false,
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: true,
    requiresNonEmptyReasoningReplay: true,
    thinkingFormat: "deepseek" as const,
    deferredToolsMode: "none" as const,
  };

  function model() {
    return {
      id: liveIdentity.model,
      name: "deepseek-relay",
      api: liveIdentity.api,
      provider: liveIdentity.provider,
      baseUrl: "https://relay.example/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 8_192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {},
    } as never;
  }

  it("never emits empty reasoning_* for prior thinking turns under requiresNonEmptyReasoningReplay", () => {
    // #296 — proof that retained thinking survives convertMessages, including
    // thinking-only turns that previously vanished after mapping. Live OpenCode
    // / aggregator verification remains deferred (E2E-005E).
    const keptUser: AgentMessage = {
      role: "user",
      content: "keep me",
      timestamp: 3,
    };
    const compactionEntry: CompactionEntry = {
      type: "compaction",
      id: "c1",
      parentId: null,
      seq: 2,
      timestamp: 2,
      summary: "older work summarized",
      tokensBefore: 1000,
      retainedTail: [keptUser],
      fromHook: false,
      details: {
        retainedReasoning: [
          { thinking: "prior plan with text", text: "prior answer" },
          { thinking: "prior thinking only", text: "" },
          {
            thinking: "prior plan three",
            text: "answer three",
            thinkingSignature: "reasoning_content",
          },
        ],
      },
    };
    const older: MessageEntry = {
      type: "message",
      id: "u0",
      parentId: null,
      seq: 0,
      timestamp: 0,
      message: { role: "user", content: "old", timestamp: 0 },
    };
    const next: MessageEntry = {
      type: "message",
      id: "u3",
      parentId: null,
      seq: 4,
      timestamp: 4,
      message: { role: "user", content: "next", timestamp: 4 },
    };

    const context = buildSessionContext(
      [older, compactionEntry, next],
      liveIdentity,
    );

    const wire = convertMessages(
      model(),
      { systemPrompt: "", messages: context.messages, tools: [] } as never,
      strictCompat as never,
    ).filter((message) => message.role === "assistant");

    expect(wire.length).toBeGreaterThanOrEqual(3);

    const reasoningValues = wire.map((message) => {
      const row = message as {
        reasoning_content?: unknown;
        reasoning_text?: unknown;
        reasoning?: unknown;
      };
      return {
        reasoning_content: row.reasoning_content,
        reasoning_text: row.reasoning_text,
        reasoning: row.reasoning,
      };
    });

    expect(reasoningValues[0]).toEqual({
      reasoning_content: "prior plan with text",
      reasoning_text: undefined,
      reasoning: undefined,
    });
    expect(reasoningValues[1]).toEqual({
      reasoning_content: "prior thinking only",
      reasoning_text: undefined,
      reasoning: undefined,
    });
    expect(reasoningValues[2]).toEqual({
      reasoning_content: "prior plan three",
      reasoning_text: undefined,
      reasoning: undefined,
    });

    for (const row of reasoningValues) {
      const values = [
        row.reasoning_content,
        row.reasoning_text,
        row.reasoning,
      ].filter((value) => typeof value === "string");
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        expect(value.length).toBeGreaterThan(0);
        expect(value).not.toBe("");
      }
    }

    expect(wire[1]).toMatchObject({
      content: RETAINED_REASONING_CONTENT_STANDIN,
      reasoning_content: "prior thinking only",
    });

    // Placeholder remains the documented fill for turns that never retained
    // thinking; this fixture has none.
    expect(DEEPSEEK_REASONING_REPLAY_PLACEHOLDER.length).toBeGreaterThan(0);
  });
});
