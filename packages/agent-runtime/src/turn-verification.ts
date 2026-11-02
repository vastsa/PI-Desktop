/**
 * Observational classification of a completed agent turn.
 *
 * This module is deliberately side-effect free and never influences run
 * scheduling: `runtime.ts` calls it from `finishTurn` only to record how a turn
 * ended. Returning an `AgentTurnDecision` from here would change the number of
 * provider requests and the `turn_end` / `agent_end` event sequence, which is a
 * separate, explicitly authorized change.
 *
 * Detection is run-scoped, not turn-scoped. pi reports `stopReason: "toolUse"`
 * on every turn that requested tools and then continues the loop with the
 * results, so a turn carrying tool results is always mid-flight and can never be
 * the turn where the model claimed an outcome. A false completion only becomes
 * visible on the *terminal* turn (`stopReason: "stop"`), and only in
 * combination with what the turn before it did. That is why the evaluator
 * carries state between turns instead of classifying each one in isolation.
 */

/** Facts about one completed turn, reduced to the fields worth classifying. */
export interface TurnOutcome {
  /** `stopReason` of the assistant message that completed the turn. */
  stopReason: string;
  /** Number of tool calls the assistant requested in this turn. */
  toolCallCount: number;
  /** Number of tool results the turn produced, including synthesized failures. */
  toolResultCount: number;
  /** Number of tool results flagged `isError`. */
  failedToolCount: number;
  /** Total assistant text length after trimming whitespace. */
  assistantTextLength: number;
}

/** State carried from one turn to the next within a single run. */
export interface TurnVerificationState {
  /** The most recent tool batch failed every call it made. */
  lastBatchAllFailed: boolean;
}

export const INITIAL_TURN_STATE: TurnVerificationState = { lastBatchAllFailed: false };

/**
 * - `pending` — the turn requested tools and the loop continues. Never flagged:
 *   the model has not claimed any outcome yet.
 * - `suspicious` — the model stopped speaking on a turn whose preceding tool
 *   batch failed every call, i.e. it answered without recovering.
 * - `incomplete` — the provider did not end the turn normally: truncated by the
 *   token limit, erroring, or aborted.
 * - `conversational` — a normal stop with no tool involvement at all.
 * - `clean` — a normal stop that was not preceded by an all-failed batch.
 */
export type TurnVerdict =
  | "pending"
  | "suspicious"
  | "incomplete"
  | "conversational"
  | "clean";

/** Verdict for this turn plus the state the next turn should start from. */
export interface TurnEvaluation {
  verdict: TurnVerdict;
  state: TurnVerificationState;
}

/**
 * Evaluate one turn and return the state the next turn should start from.
 *
 * `length` counts as `incomplete` rather than `suspicious`: pi fails every tool
 * call from a truncated message, so the truncation is the cause and must not be
 * double-counted.
 */
export function evaluateTurn(
  outcome: TurnOutcome,
  state: TurnVerificationState = INITIAL_TURN_STATE,
): TurnEvaluation {
  const { stopReason } = outcome;

  if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") {
    return { verdict: "incomplete", state: INITIAL_TURN_STATE };
  }

  // A batch counts as failed when nothing in it succeeded. A batch that mixes
  // failures with successes is the ordinary error-recovery cycle, and a turn
  // that asked for tools but produced no results was interrupted mid-batch.
  const allToolsFailed =
    outcome.toolResultCount > 0
      ? outcome.failedToolCount === outcome.toolResultCount
      : outcome.toolCallCount > 0;

  // Mid-flight: the model asked for tools, so it has concluded nothing yet.
  if (stopReason === "toolUse" || stopReason === "pending") {
    return { verdict: "pending", state: { lastBatchAllFailed: allToolsFailed } };
  }

  // Terminal turn: the model stopped speaking. This is the only place where a
  // preceding all-failed batch means it answered without recovering.
  if (state.lastBatchAllFailed) {
    return { verdict: "suspicious", state: INITIAL_TURN_STATE };
  }

  if (outcome.toolCallCount === 0 && outcome.toolResultCount === 0) {
    return { verdict: "conversational", state: INITIAL_TURN_STATE };
  }

  return { verdict: "clean", state: INITIAL_TURN_STATE };
}

/** Build a {@link TurnOutcome} from the pi turn context, without classifying it. */
export function describeTurn(input: {
  message: {
    stopReason: string;
    content: readonly { type: string; text?: unknown }[];
  };
  toolResults: readonly { isError?: boolean }[];
}): TurnOutcome {
  // Tests and partially-built messages can hand in a message whose `content`
  // was never populated. Treat anything that is not an array as "no blocks"
  // instead of throwing: this classifier must never be able to fail a turn.
  const content = Array.isArray(input.message.content) ? input.message.content : [];
  const toolResults = Array.isArray(input.toolResults) ? input.toolResults : [];

  let assistantTextLength = 0;
  let toolCallCount = 0;
  for (const block of content) {
    if (block.type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") assistantTextLength += text.trim().length;
    } else if (block.type === "toolCall") {
      toolCallCount += 1;
    }
  }

  let failedToolCount = 0;
  for (const result of toolResults) {
    if (result.isError === true) failedToolCount += 1;
  }

  return {
    stopReason: input.message.stopReason,
    toolCallCount,
    toolResultCount: toolResults.length,
    failedToolCount,
    assistantTextLength,
  };
}
