import { describe, expect, it } from "vitest";
import { classifyTurn, describeTurn, type TurnOutcome } from "./turn-verification.js";

function outcome(overrides: Partial<TurnOutcome> = {}): TurnOutcome {
  return {
    stopReason: "stop",
    toolCallCount: 0,
    toolResultCount: 0,
    failedToolCount: 0,
    assistantTextLength: 42,
    ...overrides,
  };
}

describe("classifyTurn", () => {
  it("treats a plain answer as conversational, never suspicious", () => {
    expect(classifyTurn(outcome())).toBe("conversational");
  });

  it("treats a turn with only successful tools as clean", () => {
    expect(classifyTurn(outcome({ toolCallCount: 3, toolResultCount: 3 }))).toBe("clean");
  });

  it("flags a normal stop that left tool failures behind", () => {
    expect(classifyTurn(outcome({ toolCallCount: 2, toolResultCount: 2, failedToolCount: 1 })))
      .toBe("suspicious");
  });

  it("flags tool calls that produced no results at all", () => {
    expect(classifyTurn(outcome({ toolCallCount: 1, toolResultCount: 0 }))).toBe("suspicious");
  });

  it.each(["error", "aborted", "length"])('marks stopReason "%s" as incomplete', (stopReason) => {
    expect(classifyTurn(outcome({ stopReason }))).toBe("incomplete");
  });

  it("prefers incomplete over suspicious when a truncated turn also failed tools", () => {
    expect(classifyTurn(outcome({
      stopReason: "length",
      toolCallCount: 2,
      toolResultCount: 2,
      failedToolCount: 2,
    }))).toBe("incomplete");
  });

  it("does not treat zero-length text as evidence on its own", () => {
    expect(classifyTurn(outcome({ assistantTextLength: 0 }))).toBe("conversational");
    expect(classifyTurn(outcome({ assistantTextLength: 0, toolCallCount: 1, toolResultCount: 1 })))
      .toBe("clean");
  });
});

describe("describeTurn", () => {
  it("counts text blocks and tool calls from the assistant message", () => {
    const described = describeTurn({
      message: {
        stopReason: "stop",
        content: [
          { type: "text", text: "  hello  " },
          { type: "toolCall" },
          { type: "toolCall" },
          { type: "reasoning" },
        ],
      },
      toolResults: [{ isError: false }, { isError: true }],
    });

    expect(described).toEqual({
      stopReason: "stop",
      toolCallCount: 2,
      toolResultCount: 2,
      failedToolCount: 1,
      assistantTextLength: 5,
    });
  });

  it("ignores tool results without an explicit isError flag", () => {
    const described = describeTurn({
      message: { stopReason: "stop", content: [{ type: "toolCall" }] },
      toolResults: [{}, { isError: undefined }, { isError: false }],
    });
    expect(described.failedToolCount).toBe(0);
    expect(describeTurn.call(null, {
      message: { stopReason: "stop", content: [] },
      toolResults: [],
    }).toolResultCount).toBe(0);
  });

  it("never throws on a message whose content was never populated", () => {
    const described = describeTurn({
      message: { stopReason: "stop", content: undefined as never },
      toolResults: undefined as never,
    });
    expect(described).toEqual({
      stopReason: "stop",
      toolCallCount: 0,
      toolResultCount: 0,
      failedToolCount: 0,
      assistantTextLength: 0,
    });
    expect(classifyTurn(described)).toBe("conversational");
  });
});
