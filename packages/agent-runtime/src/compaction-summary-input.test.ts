import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
  addSummaryUsage,
  compactionSummaryInputLimit,
  COMPACTION_REDUCED_TOOL_RESULT_CHARS,
  COMPACTION_SUMMARY_MAX_CHUNKS,
  COMPACTION_SUMMARY_MAX_RETRIES,
  COMPACTION_SUMMARY_PROMPT_SAFETY_TOKENS,
  COMPACTION_SUMMARY_RETRY_BASE_MS,
  COMPACTION_SUMMARY_RETRY_POLICY,
  estimateSummaryPromptTokens,
  planSummaryChunks,
  reduceSummaryInput,
  SUMMARY_CHUNK_TRUNCATION_MARKER,
  type CompactionSummaryInput,
} from "./compaction-summary-input.js";

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistant(
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  >,
): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "local",
    model: "local-model",
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
  } as AgentMessage;
}

function toolResult(text: string, id = "tool-1"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "Read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
  };
}

function input(
  messagesToSummarize: AgentMessage[],
  overrides: Partial<CompactionSummaryInput> = {},
): CompactionSummaryInput {
  return {
    messagesToSummarize,
    turnPrefixMessages: [],
    isSplitTurn: false,
    previousSummary: undefined,
    ...overrides,
  };
}

describe("COMPACTION_SUMMARY_RETRY_POLICY", () => {
  it("is a bounded, enabled pi-ai retry policy", () => {
    expect(COMPACTION_SUMMARY_RETRY_POLICY).toEqual({
      enabled: true,
      maxRetries: COMPACTION_SUMMARY_MAX_RETRIES,
      baseDelayMs: COMPACTION_SUMMARY_RETRY_BASE_MS,
    });
    expect(COMPACTION_SUMMARY_MAX_RETRIES).toBeGreaterThan(0);
    expect(COMPACTION_SUMMARY_MAX_RETRIES).toBeLessThanOrEqual(5);
  });
});

describe("estimateSummaryPromptTokens", () => {
  it("sizes the prompt pi serializes, not the raw messages", () => {
    // pi caps every tool result at 2 000 characters when it serializes the
    // conversation, so a 400 000-character result costs ~500 tokens of prompt,
    // not the ~100 000 the raw message estimate would report.
    const oversized = input([user("read it"), toolResult("x".repeat(400_000))]);
    const tokens = estimateSummaryPromptTokens(oversized);
    expect(tokens).toBeGreaterThan(400);
    expect(tokens).toBeLessThan(1_000);
  });

  it("counts the previous summary as part of the history request", () => {
    const base = input([user("ask")]);
    const carried = input([user("ask")], { previousSummary: "s".repeat(4_000) });
    expect(estimateSummaryPromptTokens(carried) - estimateSummaryPromptTokens(base)).toBe(
      1_000,
    );
  });

  it("uses the larger of the two requests on a split turn", () => {
    const history = [user("h".repeat(400))];
    const prefix = [user("p".repeat(4_000))];
    const split = input(history, { isSplitTurn: true, turnPrefixMessages: prefix });
    expect(estimateSummaryPromptTokens(split)).toBe(
      estimateSummaryPromptTokens(input(prefix)),
    );
    // The turn prefix only counts when pi will actually summarize it.
    const unsplit = input(history, { isSplitTurn: false, turnPrefixMessages: prefix });
    expect(estimateSummaryPromptTokens(unsplit)).toBe(estimateSummaryPromptTokens(input(history)));
  });
});

describe("reduceSummaryInput", () => {
  it("returns undefined when there is nothing to reduce", () => {
    const small = input([
      user("ask"),
      assistant([{ type: "text", text: "answer" }]),
      toolResult("short"),
    ]);
    expect(reduceSummaryInput(small)).toBeUndefined();
  });

  it("keeps a bounded prefix of each tool result and marks the cut", () => {
    const reduced = reduceSummaryInput(
      input([user("ask"), toolResult("a".repeat(10_000)), toolResult("b".repeat(10_000), "tool-2")]),
    );
    expect(reduced).toBeDefined();
    const results = reduced!.messagesToSummarize.filter(
      (message) => message.role === "toolResult",
    );
    expect(results).toHaveLength(2);
    for (const result of results) {
      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      expect(text.startsWith("a".repeat(10)) || text.startsWith("b".repeat(10))).toBe(true);
      expect(text).toMatch(/truncated for the summary request\]$/);
      expect(text.length).toBeLessThan(COMPACTION_REDUCED_TOOL_RESULT_CHARS + 100);
    }
  });

  it("drops assistant thinking but keeps text and tool calls", () => {
    const reduced = reduceSummaryInput(
      input([
        assistant([
          { type: "thinking", thinking: "long private reasoning" },
          { type: "text", text: "visible answer" },
          { type: "toolCall", id: "t1", name: "Read", arguments: { path: "a.txt" } },
        ]),
      ]),
    );
    expect(reduced).toBeDefined();
    const content = (reduced!.messagesToSummarize[0] as { content: Array<{ type: string }> })
      .content;
    expect(content.map((block) => block.type)).toEqual(["text", "toolCall"]);
  });

  it("does not mutate the input and never changes the message count", () => {
    const original = input([user("ask"), toolResult("z".repeat(5_000))]);
    const snapshot = JSON.stringify(original);
    const reduced = reduceSummaryInput(original);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(reduced!.messagesToSummarize).toHaveLength(original.messagesToSummarize.length);
    expect(reduced!.messagesToSummarize[0]).toBe(original.messagesToSummarize[0]);
  });

  it("reduces the turn prefix of a split turn as well", () => {
    const reduced = reduceSummaryInput(
      input([user("older")], {
        isSplitTurn: true,
        turnPrefixMessages: [toolResult("q".repeat(5_000))],
      }),
    );
    expect(reduced).toBeDefined();
    expect(
      (reduced!.turnPrefixMessages[0] as { content: Array<{ text: string }> }).content[0].text
        .length,
    ).toBeLessThan(1_000);
  });
});

describe("compactionSummaryInputLimit", () => {
  it("leaves the summary its own output allowance and the prompt template", () => {
    const limit = compactionSummaryInputLimit({
      hardLimit: 100_000,
      requestHeadroom: 20_000,
      modelMaxTokens: 8_000,
    });

    expect(limit).toBe(
      120_000 - 8_000 - COMPACTION_SUMMARY_PROMPT_SAFETY_TOKENS,
    );
  });

  it("caps the output allowance at the model's own output budget", () => {
    const limit = compactionSummaryInputLimit({
      hardLimit: 1_000_000,
      requestHeadroom: 200_000,
      modelMaxTokens: 8_192,
    });

    expect(limit).toBe(1_200_000 - 8_192 - COMPACTION_SUMMARY_PROMPT_SAFETY_TOKENS);
  });
});

describe("planSummaryChunks", () => {
  const options = { summaryInputLimit: 10_000, reserveTokens: 1_000 };

  it("splits a range into contiguous chunks that each fit the request budget", () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      toolResult("t".repeat(2_000), `tool-${index}`),
    );

    const chunks = planSummaryChunks(input(messages), options);

    expect(chunks).toBeDefined();
    expect(chunks!.length).toBeGreaterThan(1);
    // Contiguous and complete: concatenating the chunks reproduces the range in
    // order, so every message the checkpoint files behind its boundary is
    // summarized by exactly one request.
    expect(chunks!.flat()).toEqual(messages);
    for (const chunk of chunks!) {
      expect(
        estimateSummaryPromptTokens(input(chunk, { previousSummary: "s".repeat(4_000) })),
      ).toBeLessThanOrEqual(options.summaryInputLimit);
    }
  });

  it("keeps a range that already fits as one chunk", () => {
    const messages = [user("read the log"), toolResult("short output")];

    expect(planSummaryChunks(input(messages), options)).toEqual([messages]);
  });

  it("truncates a single message that is larger than a chunk instead of dropping it", () => {
    const messages = [user("u".repeat(200_000))];

    const chunks = planSummaryChunks(input(messages), options);

    expect(chunks).toHaveLength(1);
    expect(chunks![0]).toHaveLength(1);
    const text = (chunks![0]![0] as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain(SUMMARY_CHUNK_TRUNCATION_MARKER.trim());
    expect(text.length).toBeLessThan(200_000);
    expect(chunks![0]![0]!.role).toBe("user");
  });

  it("plans nothing for an empty range", () => {
    expect(planSummaryChunks(input([]), options)).toBeUndefined();
  });

  it("refuses a range that would need more requests than the bound allows", () => {
    const tiny = { summaryInputLimit: 100, reserveTokens: 0 };
    const messages = Array.from({ length: COMPACTION_SUMMARY_MAX_CHUNKS + 4 }, (_, index) =>
      user(`request ${index} ${"x".repeat(200)}`),
    );

    expect(planSummaryChunks(input(messages), tiny)).toBeUndefined();
  });

  it("splits a range with known-token messages by the same budget the guard uses", () => {
    const messages = Array.from({ length: 12 }, (_, index) =>
      user(`note ${index} ${"y".repeat(1_000)}`),
    );
    const perMessage = Math.ceil(estimateTokens(messages[0]!));

    // Four messages' worth of budget, less the planner's margin: three fit.
    const chunks = planSummaryChunks(input(messages), {
      summaryInputLimit: perMessage * 4,
      reserveTokens: 0,
    });

    expect(chunks!.map((chunk) => chunk.length)).toEqual([3, 3, 3, 3]);
  });
});

describe("addSummaryUsage", () => {
  const usage = (input: number, output: number) => ({
    input,
    output,
    cacheRead: 1,
    cacheWrite: 2,
    totalTokens: input + output,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
  });

  it("adds the requests one chunked summary took", () => {
    const total = addSummaryUsage(usage(10, 5), usage(20, 7));

    expect(total).toEqual({
      input: 30,
      output: 12,
      cacheRead: 2,
      cacheWrite: 4,
      totalTokens: 42,
      cost: { input: 0.2, output: 0.4, cacheRead: 0.6, cacheWrite: 0.8, total: 2 },
    });
  });

  it("keeps an optional field only when a request reported it", () => {
    const withReasoning = { ...usage(1, 1), reasoning: 4 };

    expect(addSummaryUsage(undefined, usage(1, 1))).not.toHaveProperty("reasoning");
    expect(addSummaryUsage(withReasoning, usage(1, 1))).toMatchObject({
      reasoning: 4,
    });
  });

  it("returns whichever side exists", () => {
    expect(addSummaryUsage(undefined, usage(1, 1))).toEqual(usage(1, 1));
    expect(addSummaryUsage(usage(1, 1), undefined)).toEqual(usage(1, 1));
    expect(addSummaryUsage(undefined, undefined)).toBeUndefined();
  });
});
