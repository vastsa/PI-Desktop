import { describe, expect, it } from "vitest";
import {
  createCompactionSummaryMessage,
  type AgentMessage,
  type PrepareNextTurnContext,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Model,
  Models,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  buildProviderModel,
  type RuntimeProviderConfig,
} from "./provider-binding.js";
import { automaticCompactionThresholdFor, contextBudgetFor } from "./context-budget.js";
import {
  degradedDelegateMessages,
  delegateRetentionMode,
  prepareDelegateTurnContext,
  subagentContextOverflowError,
} from "./subagent-context.js";

const provider: RuntimeProviderConfig = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  modelId: "local-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};

/** A 4 096-token window whose safe budget lands at 2 048 tokens. */
function smallModel(): Model<Api> {
  return {
    ...buildProviderModel(provider),
    contextWindow: 4_096,
    maxTokens: 1_024,
  };
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string): UserMessage {
  return { role: "user", content: text, timestamp: 1 };
}

function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "local",
    model: "local-model",
    stopReason: "stop",
    timestamp: 1,
    usage: ZERO_USAGE,
    content: [{ type: "text", text }],
  };
}

function assistantToolCall(id: string, preamble = ""): AssistantMessage {
  return {
    ...assistantText(preamble),
    content: [
      ...(preamble ? [{ type: "text" as const, text: preamble }] : []),
      { type: "toolCall" as const, id, name: "Read", arguments: { path: "a.ts" } },
    ],
  };
}

function toolResult(text: string, toolCallId = "call-1"): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "Read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

/** Fake `Models` registry whose summary completion is caller-controlled. */
function summaryModels(
  respond: () => AssistantMessage,
): { factory: () => Models; prompts: string[] } {
  const prompts: string[] = [];
  const factory = () =>
    ({
      completeSimple: async (
        _model: unknown,
        context: { messages: Array<{ content: unknown }> },
      ) => {
        const content = context.messages[0]?.content;
        prompts.push(
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .map((block) =>
                    typeof block === "object" && block !== null && "text" in block
                      ? String((block as { text: unknown }).text)
                      : "",
                  )
                  .join("")
              : "",
        );
        return respond();
      },
    }) as unknown as Models;
  return { factory, prompts };
}

function summarySuccess(text: string): AssistantMessage {
  return {
    ...assistantText(text),
    usage: {
      ...ZERO_USAGE,
      input: 5,
      output: 2,
      totalTokens: 7,
    },
  };
}

function summaryFailure(errorMessage: string): AssistantMessage {
  return {
    ...assistantText(""),
    stopReason: "error",
    errorMessage,
  } as AssistantMessage;
}

function turnContext(
  overrides: Partial<PrepareNextTurnContext> = {},
): PrepareNextTurnContext {
  return {
    message: assistantText("done"),
    toolResults: [],
    context: { messages: [], tools: [] },
    newMessages: [],
    ...overrides,
  };
}

/** Messages that overflow the small model: brief plus ~750-token results. */
function overflowingMessages(brief: string): AgentMessage[] {
  return [
    userMessage(brief),
    assistantToolCall("call-1"),
    toolResult("a".repeat(3_000), "call-1"),
    assistantToolCall("call-2"),
    toolResult("b".repeat(3_000), "call-2"),
    assistantToolCall("call-3"),
    toolResult("c".repeat(3_000), "call-3"),
  ];
}

describe("delegateRetentionMode", () => {
  it("retains the active turn when tool results are pending", () => {
    expect(
      delegateRetentionMode(
        turnContext({ toolResults: [toolResult("ok")] }),
      ),
    ).toBe("active_turn");
    expect(
      delegateRetentionMode(
        turnContext({
          message: { ...assistantText(""), stopReason: "toolUse" },
        }),
      ),
    ).toBe("active_turn");
  });

  it("treats a settled turn as completed", () => {
    expect(delegateRetentionMode(turnContext())).toBe("completed_turn");
  });
});

describe("prepareDelegateTurnContext", () => {
  it("leaves a context below the hard limit untouched and never builds the summary registry", () => {
    const { factory, prompts } = summaryModels(() => summarySuccess("S"));
    let built = 0;
    return prepareDelegateTurnContext({
      messages: [userMessage("Find the permission dialog.")],
      model: smallModel(),
      taskBrief: "Find the permission dialog.",
      retentionMode: "active_turn",
      summaryModels: () => {
        built += 1;
        return factory();
      },
      signal: new AbortController().signal,
    }).then((outcome) => {
      expect(outcome).toEqual({ kind: "unchanged" });
      expect(built).toBe(0);
      expect(prompts).toHaveLength(0);
    });
  });

  it("compacts at the shared early trigger before the hard limit", async () => {
    const taskBrief = "Read the permission flow.";
    const messages: AgentMessage[] = [
      userMessage(taskBrief),
      assistantToolCall("soft-trigger"),
      toolResult("x".repeat(7_500), "soft-trigger"),
    ];
    const budget = contextBudgetFor(smallModel(), messages);
    const { factory, prompts } = summaryModels(() => summarySuccess("SUMMARY TEXT"));

    expect(budget.tokens).toBeLessThan(budget.hardLimit);
    expect(budget.tokens).toBeGreaterThanOrEqual(
      automaticCompactionThresholdFor(budget),
    );
    const outcome = await prepareDelegateTurnContext({
      messages,
      model: smallModel(),
      taskBrief,
      retentionMode: "active_turn",
      summaryModels: factory,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("compacted");
    expect(prompts).toHaveLength(1);
  });
  it("charges pending task, system prompt, and tool schemas against the budget", async () => {
    const taskBrief = "Read the permission flow.";
    const messages: AgentMessage[] = [
      userMessage(taskBrief),
      assistantToolCall("call-1"),
      toolResult("a".repeat(2_300), "call-1"),
      assistantToolCall("call-2"),
      toolResult("b".repeat(2_300), "call-2"),
    ];
    const baseBudget = contextBudgetFor(smallModel(), messages);
    expect(baseBudget.tokens).toBeLessThan(
      automaticCompactionThresholdFor(baseBudget),
    );
    const { factory, prompts } = summaryModels(() => summarySuccess("SUMMARY TEXT"));

    const outcome = await prepareDelegateTurnContext({
      messages,
      additionalMessages: [userMessage("Continue scanning.")],
      model: smallModel(),
      taskBrief,
      systemPrompt: "s".repeat(2_600),
      tools: [{ name: "Read", description: "t".repeat(800) }],
      retentionMode: "active_turn",
      summaryModels: factory,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("compacted");
    expect(prompts).toHaveLength(1);
  });

  it("compacts synchronously at the hard limit and retains the task brief of an active turn", async () => {
    const { factory, prompts } = summaryModels(() => summarySuccess("SUMMARY TEXT"));
    const outcome = await prepareDelegateTurnContext({
      messages: overflowingMessages("Read the three files."),
      model: smallModel(),
      taskBrief: "Read the three files.",
      retentionMode: "active_turn",
      summaryModels: factory,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    expect(outcome.tokensBefore).toBeGreaterThan(0);
    expect(outcome.summaryUsage?.totalTokens).toBe(7);
    expect(outcome.messages[0]?.role).toBe("compactionSummary");
    expect(
      (outcome.messages[0] as { summary?: string }).summary,
    ).toContain("SUMMARY TEXT");
    // The active turn retains the latest user message — the task brief.
    expect(outcome.messages.at(-1)).toEqual(userMessage("Read the three files."));
    // The summary request covered the folded history, tool output included.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Read the three files.");
    // Everything past the boundary fits under the hard limit again.
    const fit = contextBudgetFor(smallModel(), outcome.messages);
    expect(fit.tokens).toBeLessThan(fit.hardLimit);
  });

  it("retains no bare user message across a completed turn", async () => {
    const { factory } = summaryModels(() => summarySuccess("SUMMARY TEXT"));
    const outcome = await prepareDelegateTurnContext({
      messages: overflowingMessages("Read the three files."),
      model: smallModel(),
      taskBrief: "Read the three files.",
      retentionMode: "completed_turn",
      summaryModels: factory,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    expect(outcome.messages).toHaveLength(1);
    expect(outcome.messages[0]?.role).toBe("compactionSummary");
  });

  it("threads a prior in-memory summary into the next compaction instead of re-summarizing it", async () => {
    const { factory, prompts } = summaryModels(() => summarySuccess("SUMMARY TWO"));
    const messages: AgentMessage[] = [
      createCompactionSummaryMessage("SUMMARY ONE", 3_000, 1),
      assistantToolCall("call-9"),
      toolResult("d".repeat(3_000), "call-9"),
      assistantToolCall("call-10"),
      toolResult("e".repeat(3_000), "call-10"),
      assistantToolCall("call-11"),
      toolResult("f".repeat(3_000), "call-11"),
    ];
    const outcome = await prepareDelegateTurnContext({
      messages,
      model: smallModel(),
      taskBrief: "Read the three files.",
      retentionMode: "completed_turn",
      summaryModels: factory,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("compacted");
    expect(prompts[0]).toContain("<previous-summary>");
    expect(prompts[0]).toContain("SUMMARY ONE");
    expect(prompts[0]).not.toContain("<summary>");
  });

  it("degrades to the task brief plus the recent tail when the summary cannot be generated", async () => {
    const { factory } = summaryModels(() => summaryFailure("invalid api key"));
    const outcome = await prepareDelegateTurnContext({
      messages: overflowingMessages("Read the three files."),
      model: smallModel(),
      taskBrief: "Read the three files.",
      retentionMode: "active_turn",
      summaryModels: factory,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("degraded");
    if (outcome.kind !== "degraded") return;
    expect(outcome.messages[0]).toEqual(userMessage("Read the three files."));
    expect(outcome.messages.length).toBeGreaterThan(1);
    expect(outcome.messages[1]?.role).not.toBe("toolResult");
  });

  it("degrades when the compacted context still exceeds the hard limit", async () => {
    // A summary that is itself larger than the safe budget.
    const { factory } = summaryModels(() => summarySuccess("s".repeat(12_000)));
    const outcome = await prepareDelegateTurnContext({
      messages: overflowingMessages("Read the three files."),
      model: smallModel(),
      taskBrief: "Read the three files.",
      retentionMode: "completed_turn",
      summaryModels: factory,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("degraded");
  });

  it("reports the terminal overflow when even the task brief does not fit", async () => {
    const { factory } = summaryModels(() => summaryFailure("invalid api key"));
    const brief = "x".repeat(12_000);
    const outcome = await prepareDelegateTurnContext({
      messages: overflowingMessages(brief),
      model: smallModel(),
      taskBrief: brief,
      retentionMode: "active_turn",
      summaryModels: factory,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("overflow");
    if (outcome.kind !== "overflow") return;
    expect(outcome.hardLimit).toBe(2_048);
    expect(outcome.tokens).toBeGreaterThanOrEqual(outcome.hardLimit);
  });

  it("rethrows an abort that lands mid-summary instead of degrading", async () => {
    const controller = new AbortController();
    const { factory } = summaryModels(() => {
      controller.abort();
      return { ...summaryFailure("aborted"), stopReason: "aborted" } as AssistantMessage;
    });
    await expect(
      prepareDelegateTurnContext({
        messages: overflowingMessages("Read the three files."),
        model: smallModel(),
        taskBrief: "Read the three files.",
        retentionMode: "active_turn",
        summaryModels: factory,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted while compacting");
  });
});

describe("degradedDelegateMessages", () => {
  it("charges retained search only when the target adapter replays it", () => {
    const target: Model<Api> = { ...smallModel(), api: "openai-responses" };
    const brief = userMessage("Keep the useful answer.");
    const search: AssistantMessage = {
      ...assistantText("useful answer"), api: target.api,
      content: [
        { type: "hostedSearch", phase: "web_search_call", blockId: "ws", wire: {
          type: "web_search_call", id: "ws", status: "completed", action: { type: "search", query: "x".repeat(20_000) },
        } },
        { type: "text", text: "useful answer" },
      ],
    };
    const messages = [brief, search];
    expect(degradedDelegateMessages(messages, "brief", target)).toEqual([brief]);
    expect(degradedDelegateMessages(messages, "brief", { ...target, id: "other-model" })).toEqual(messages);
    expect(degradedDelegateMessages(messages, "brief", { contextWindow: target.contextWindow, maxTokens: target.maxTokens })).toEqual([brief]);
  });

  it("keeps the brief plus the most recent complete exchanges that still fit", () => {
    const brief = userMessage("Survey the module.");
    const exchange = (id: string, text: string): AgentMessage[] => [
      assistantToolCall(id),
      toolResult(text, id),
    ];
    const messages: AgentMessage[] = [
      brief,
      ...exchange("call-1", "a".repeat(3_000)),
      ...exchange("call-2", "b".repeat(3_000)),
      ...exchange("call-3", "c".repeat(3_000)),
    ];

    const degraded = degradedDelegateMessages(messages, "Survey the module.", smallModel());

    // ~750 tokens per result against a 2 048-token budget: the oldest
    // exchange drops, and the kept suffix starts on an assistant, so every
    // retained result still has its call.
    expect(degraded).toEqual([brief, ...messages.slice(3)]);
  });

  it("drops an orphaned leading tool result when its call no longer fits", () => {
    const brief = userMessage("Survey the module.");
    // The assistant's own bulk is what pushes the budget over, so the cut
    // lands between the call and its result.
    const call = assistantToolCall("call-1", "p".repeat(5_200));
    const result = toolResult("r".repeat(3_000), "call-1");

    const degraded = degradedDelegateMessages(
      [brief, call, result],
      "Survey the module.",
      smallModel(),
    );

    expect(degraded).toEqual([brief]);
  });

  it("skips failed and empty assistant rows when keeping the recent tail", () => {
    const brief = userMessage("Survey the module.");
    const failed = {
      ...assistantText("partial"),
      stopReason: "error",
    } as AssistantMessage;

    const degraded = degradedDelegateMessages(
      [brief, failed, assistantText("final answer")],
      "Survey the module.",
      smallModel(),
    );

    expect(degraded?.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(degraded?.[1]).toEqual(assistantText("final answer"));
  });

  it("returns undefined when the brief alone crosses the hard limit", () => {
    const brief = "x".repeat(12_000);
    expect(
      degradedDelegateMessages([userMessage(brief)], brief, smallModel()),
    ).toBeUndefined();
  });
});

describe("carried-context budget check", () => {
  it("measures a carried context against a candidate model's own window", () => {
    const fits = contextBudgetFor(smallModel(), [userMessage("small")]);
    expect(fits).toEqual(
      expect.objectContaining({ tokens: 2, hardLimit: 2_048 }),
    );
    const tooBig = contextBudgetFor(smallModel(), [
      userMessage("y".repeat(12_000)),
    ]);
    expect(tooBig.tokens).toBeGreaterThanOrEqual(tooBig.hardLimit);
  });
});

describe("subagentContextOverflowError", () => {
  it("names the code the parent can act on and the ways out", () => {
    const error = subagentContextOverflowError("local-model");
    expect(error.code).toBe("SUBAGENT_CONTEXT_OVERFLOW");
    expect(error.message).toContain("local-model");
    expect(error.message).toContain("Narrow the task");
    expect(error.message).toContain("larger context window");
    expect(error.message).toContain("read less at once");
  });
});
