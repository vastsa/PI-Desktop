import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
  CHECKPOINT_TRUNCATION_MARKER,
  COMPACTION_RETAINED_TAIL_SHAPE,
  isRetainedTailMessage,
  replayRetainedTail,
  selectRecentTail,
  stripDanglingToolCalls,
  truncateMessageToTail,
} from "./compaction-tail.js";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Tokens pi charges one message, so a budget assertion never guesses. */
const tokensOf = (message: AgentMessage) => Math.ceil(estimateTokens(message));

function user(body: string, timestamp = 1): AgentMessage {
  return { role: "user", content: [{ type: "text", text: body }], timestamp };
}

function assistant(
  body: string,
  options: { timestamp?: number; stopReason?: string } = {},
): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: body }],
    api: "openai-completions",
    provider: "local",
    model: "local-model",
    usage,
    stopReason: options.stopReason ?? "stop",
    timestamp: options.timestamp ?? 2,
  } as AgentMessage;
}

function toolCallAssistant(
  id: string,
  body = "reading",
  options: { timestamp?: number; stopReason?: string } = {},
): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: body },
      { type: "toolCall", id, name: "read", arguments: { path: "a.ts" } },
    ],
    api: "openai-completions",
    provider: "local",
    model: "local-model",
    usage,
    stopReason: options.stopReason ?? "toolUse",
    timestamp: options.timestamp ?? 3,
  } as AgentMessage;
}

function toolResult(id: string, body: string, timestamp = 4): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text: body }],
    isError: false,
    timestamp,
  };
}

const body = (chars: number) => "x".repeat(chars);

describe("selectRecentTail", () => {
  it("keeps the newest messages that fit the tail budget", () => {
    const messages = [
      user(body(400), 1),
      assistant(body(400), { timestamp: 2 }),
      user(body(400), 3),
      assistant(body(400), { timestamp: 4 }),
      user(body(400), 5),
      assistant(body(400), { timestamp: 6 }),
    ];
    const budget = tokensOf(messages[3]!) + tokensOf(messages[4]!) + tokensOf(messages[5]!);

    const tail = selectRecentTail(messages, budget);

    expect(tail).toEqual(messages.slice(3));
    expect(tail.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("keeps the newest message even when it alone exceeds the budget", () => {
    const messages = [
      user(body(400), 1),
      assistant(body(20_000), { timestamp: 2 }),
    ];

    const tail = selectRecentTail(messages, 50);

    expect(tail).toHaveLength(1);
    expect(tail[0]!.role).toBe("assistant");
    const text = (tail[0] as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain(CHECKPOINT_TRUNCATION_MARKER.trim());
    expect(text.length).toBeLessThan(20_000);
  });

  it("keeps the active turn's goal when the window cannot hold it", () => {
    const messages = [
      user("continue the long migration", 1),
      assistant(body(20_000), { timestamp: 2 }),
    ];

    const tail = selectRecentTail(messages, 50, { latestUserGoal: true });

    expect(tail.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect((tail[0] as { content: unknown }).content).toEqual([
      { type: "text", text: "continue the long migration" },
    ]);
  });

  it("never retains a tool result whose tool call is outside the window", () => {
    // The budget carries the newest result only, so its call is not retained
    // either: a provider rejects a result whose call is missing.
    const messages = [
      toolCallAssistant("call-1", body(20_000), { timestamp: 2 }),
      toolResult("call-1", "ok"),
    ];

    const tail = selectRecentTail(messages, tokensOf(messages[1]!) + 1);

    expect(tail.some((message) => message.role === "toolResult")).toBe(false);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.role).toBe("assistant");
  });

  it("drops an errored assistant message and the results it produced", () => {
    // pi removes an errored assistant message from the rebuilt context, taking
    // its tool calls with it, so its results must not be retained.
    const messages = [
      toolCallAssistant("call-1", "half a turn", { timestamp: 2, stopReason: "error" }),
      toolResult("call-1", "partial output"),
      user("a later request", 4),
    ];

    const tail = selectRecentTail(messages, 10_000);

    expect(tail.map((message) => message.role)).toEqual(["user"]);
  });

  it("keeps its own newest message when pruning would empty the tail", () => {
    const messages = [
      toolCallAssistant("call-1", body(20_000), { timestamp: 2 }),
      toolResult("call-1", "ok"),
    ];

    const tail = selectRecentTail(messages, 400);

    expect(tail).toHaveLength(1);
    expect(tail[0]!.role).toBe("assistant");
    expect((tail[0] as { content: unknown[] }).content).toEqual([
      {
        type: "text",
        text: expect.stringContaining(CHECKPOINT_TRUNCATION_MARKER.trim()),
      },
    ]);
  });

  it("returns an empty tail when only tool results remain", () => {
    // Neither a bare result nor a bare tool call is a message a provider
    // accepts, so there is nothing this path can keep.
    const messages = [toolResult("call-1", "ok"), toolResult("call-2", "ok", 5)];

    expect(selectRecentTail(messages, 20)).toEqual([]);
  });
});

describe("truncateMessageToTail", () => {
  it("bounds every text block and keeps the tool call identity", () => {
    const message = toolCallAssistant("call-1", body(4_000));

    const truncated = truncateMessageToTail(message, 100) as unknown as {
      content: Array<{ type: string; text?: string; id?: string }>;
    };

    expect(truncated.content).toHaveLength(2);
    expect(truncated.content[0]!.text!.length).toBeLessThan(4_000);
    expect(truncated.content[1]).toMatchObject({ type: "toolCall", id: "call-1" });
  });
});

describe("stripDanglingToolCalls", () => {
  it("keeps the text and drops the calls of an assistant message", () => {
    const stripped = stripDanglingToolCalls(toolCallAssistant("call-1")) as unknown as {
      content: unknown[];
    };

    expect(stripped.content).toEqual([{ type: "text", text: "reading" }]);
  });

  it("leaves a message with no tool call untouched", () => {
    const message = assistant("done");

    expect(stripDanglingToolCalls(message)).toBe(message);
  });
});

describe("replayRetainedTail", () => {
  it("replays a persisted window in order", () => {
    const window = [
      user("continue", 1),
      toolCallAssistant("call-1", "reading", { timestamp: 2 }),
      toolResult("call-1", "file contents"),
    ];

    expect(replayRetainedTail(JSON.parse(JSON.stringify(window)))).toEqual(window);
  });

  it("rejects entries that are not model messages", () => {
    const value = [
      { role: "user", content: [{ type: "text", text: "kept" }], timestamp: 1 },
      { role: "system", content: "not part of a tail" },
      { role: "toolResult", content: [{ type: "text", text: "no call id" }] },
      "not a message",
      null,
    ];

    expect(replayRetainedTail(value)).toEqual([
      { role: "user", content: [{ type: "text", text: "kept" }], timestamp: 1 },
    ]);
  });

  it("drops a result whose call is missing from the recorded window", () => {
    const value = [
      toolResult("call-9", "orphan"),
      user("continue", 2),
    ];

    expect(replayRetainedTail(value)).toEqual([user("continue", 2)]);
  });

  it("restores a missing timestamp so pi can file the message", () => {
    const replayed = replayRetainedTail([
      { role: "user", content: [{ type: "text", text: "kept" }] },
    ]);

    expect(replayed).toEqual([
      { role: "user", content: [{ type: "text", text: "kept" }], timestamp: 0 },
    ]);
  });

  it("returns undefined when the stored value is not a tail", () => {
    expect(replayRetainedTail(undefined)).toBeUndefined();
    expect(replayRetainedTail("two user lines")).toBeUndefined();
  });
});

describe("isRetainedTailMessage", () => {
  it("accepts the roles a tail carries", () => {
    expect(isRetainedTailMessage(user("a"))).toBe(true);
    expect(isRetainedTailMessage(assistant("a"))).toBe(true);
    expect(isRetainedTailMessage(toolResult("call-1", "a"))).toBe(true);
  });

  it("rejects anything the provider would not accept as context", () => {
    expect(isRetainedTailMessage({ role: "custom", content: "x" })).toBe(false);
    expect(isRetainedTailMessage({ role: "user" })).toBe(false);
    expect(isRetainedTailMessage({ role: "user", content: 42 })).toBe(false);
    expect(isRetainedTailMessage(null)).toBe(false);
  });
});

describe("the tail shape marker", () => {
  it("names the window a rebuild replays in full", () => {
    // `retainedTailForContext` narrows a tail to one user message unless the
    // checkpoint recorded this exact value, so it is a persisted contract.
    expect(COMPACTION_RETAINED_TAIL_SHAPE).toBe("recent_window");
  });
});
