import { describe, expect, it } from "vitest";
import {
  describeTurn,
  evaluateTurn,
  INITIAL_TURN_STATE,
  type TurnOutcome,
  type TurnVerificationState,
} from "./turn-verification.js";

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

/** A mid-flight turn: the model asked for tools and the loop continues. */
function toolTurn(calls: number, results: number, failed: number): TurnOutcome {
  return outcome({
    stopReason: "toolUse",
    toolCallCount: calls,
    toolResultCount: results,
    failedToolCount: failed,
  });
}

/** The terminal turn: the model stopped speaking, with no tool call of its own. */
function finalTurn(): TurnOutcome {
  return outcome({ stopReason: "stop" });
}

describe("evaluateTurn — mid-flight turns are never flagged", () => {
  it("reports a tool turn as pending even when every tool failed", () => {
    const result = evaluateTurn(toolTurn(2, 2, 2), INITIAL_TURN_STATE);
    expect(result.verdict).toBe("pending");
    expect(result.state.lastBatchAllFailed).toBe(true);
  });

  it("does not flag a tool turn that produced no results yet", () => {
    const result = evaluateTurn(toolTurn(1, 0, 0), INITIAL_TURN_STATE);
    expect(result.verdict).toBe("pending");
    expect(result.state.lastBatchAllFailed).toBe(true);
  });

  it("clears the failure flag when a later batch succeeds", () => {
    const result = evaluateTurn(toolTurn(1, 1, 0), { lastBatchAllFailed: true });
    expect(result.verdict).toBe("pending");
    expect(result.state.lastBatchAllFailed).toBe(false);
  });

  it("does not carry a failure across a mixed batch", () => {
    // One call failed, one succeeded: the ordinary recovery cycle.
    const result = evaluateTurn(toolTurn(2, 2, 1), INITIAL_TURN_STATE);
    expect(result.state.lastBatchAllFailed).toBe(false);
  });
});

describe("evaluateTurn — terminal turns", () => {
  it("flags a final answer that follows an all-failed batch", () => {
    const midFlight = evaluateTurn(toolTurn(1, 1, 1), INITIAL_TURN_STATE);
    const terminal = evaluateTurn(finalTurn(), midFlight.state);
    expect(terminal.verdict).toBe("suspicious");
  });

  it("does not flag a final answer after the model recovered", () => {
    // tool fails -> model retries successfully -> final answer
    const first = evaluateTurn(toolTurn(1, 1, 1), INITIAL_TURN_STATE);
    const second = evaluateTurn(toolTurn(1, 1, 0), first.state);
    const terminal = evaluateTurn(finalTurn(), second.state);
    // The final turn carries no tool call of its own, so it is conversational —
    // what matters is that the recovered run is not flagged.
    expect(terminal.verdict).not.toBe("suspicious");
    expect(terminal.verdict).toBe("conversational");
  });

  it("treats a plain answer as conversational", () => {
    expect(evaluateTurn(outcome(), INITIAL_TURN_STATE).verdict).toBe("conversational");
  });

  it("reports a terminal turn that used only successful tools as clean", () => {
    expect(evaluateTurn(outcome({ toolCallCount: 1, toolResultCount: 1 }), INITIAL_TURN_STATE).verdict)
      .toBe("clean");
  });

  it("resets the failure flag after it has been reported", () => {
    const flagged = evaluateTurn(finalTurn(), { lastBatchAllFailed: true });
    expect(flagged.verdict).toBe("suspicious");
    expect(flagged.state.lastBatchAllFailed).toBe(false);
    expect(evaluateTurn(finalTurn(), flagged.state).verdict).toBe("conversational");
  });
});

describe("evaluateTurn — provider failures", () => {
  it.each(["error", "aborted", "length"])('marks stopReason "%s" as incomplete', (stopReason) => {
    expect(evaluateTurn(outcome({ stopReason }), INITIAL_TURN_STATE).verdict).toBe("incomplete");
  });

  it("prefers incomplete over suspicious when a truncated turn also failed tools", () => {
    expect(evaluateTurn(
      outcome({ stopReason: "length", toolCallCount: 2, toolResultCount: 2, failedToolCount: 2 }),
      { lastBatchAllFailed: true },
    ).verdict).toBe("incomplete");
  });

  it("clears carried state on a provider failure", () => {
    const result = evaluateTurn(outcome({ stopReason: "error" }), { lastBatchAllFailed: true });
    expect(result.state.lastBatchAllFailed).toBe(false);
  });
});

describe("evaluateTurn — the reported regression", () => {
  it("does not flag the observed false positive", () => {
    // Real session log: one tool call failed, stopReason "toolUse", 199 chars of
    // text. That turn is mid-flight; the model had not claimed anything yet.
    const observed = outcome({
      stopReason: "toolUse",
      toolCallCount: 1,
      toolResultCount: 1,
      failedToolCount: 1,
      assistantTextLength: 199,
    });
    expect(evaluateTurn(observed, INITIAL_TURN_STATE).verdict).toBe("pending");
  });

  it("flags the run only if the model then answers without recovering", () => {
    const observed = outcome({
      stopReason: "toolUse",
      toolCallCount: 1,
      toolResultCount: 1,
      failedToolCount: 1,
      assistantTextLength: 199,
    });
    const midFlight = evaluateTurn(observed, INITIAL_TURN_STATE);
    expect(evaluateTurn(finalTurn(), midFlight.state).verdict).toBe("suspicious");
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
    expect(evaluateTurn(described, INITIAL_TURN_STATE).verdict).toBe("conversational");
  });

  it("feeds the evaluator without losing the carried state type", () => {
    const state: TurnVerificationState = INITIAL_TURN_STATE;
    expect(evaluateTurn(describeTurn({
      message: { stopReason: "stop", content: [] },
      toolResults: [],
    }), state).verdict).toBe("conversational");
  });
});
