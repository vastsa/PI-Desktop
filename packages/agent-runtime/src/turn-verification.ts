/**
 * Observational classification of a completed agent turn.
 *
 * This module is deliberately side-effect free and never influences run
 * scheduling: `runtime.ts` calls it from `finishTurn` only to record how a turn
 * ended. Returning an `AgentTurnDecision` from here would change the number of
 * provider requests and the `turn_end` / `agent_end` event sequence, which is a
 * separate, explicitly authorized change.
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

/**
 * - `clean` — the turn ran to a normal stop with nothing to flag.
 * - `suspicious` — the turn stopped normally but evidence suggests it did not
 *   actually accomplish what it claimed (failed tools, or a request for tool
 *   use that produced no results).
 * - `incomplete` — the provider did not end the turn normally: truncated by the
 *   token limit, erroring, or aborted.
 * - `conversational` — a normal stop with no tool involvement at all. Plain
 *   question/answer turns land here; they are never suspicious.
 */
export type TurnVerdict = "clean" | "suspicious" | "incomplete" | "conversational";

/**
 * Classify a completed turn from observable facts only.
 *
 * `stopReason === "length"` is treated as incomplete rather than suspicious:
 * pi fails every tool call from a truncated message, so a length stop already
 * surfaces as failed tools and should not be double-counted.
 */
export function classifyTurn(outcome: TurnOutcome): TurnVerdict {
  const { stopReason } = outcome;

  if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") {
    return "incomplete";
  }

  if (outcome.toolCallCount === 0 && outcome.toolResultCount === 0) {
    return "conversational";
  }

  // A turn that requested tools but produced no results stopped mid-flight:
  // the tool batch was interrupted before any result reached the context.
  if (outcome.toolCallCount > 0 && outcome.toolResultCount === 0) {
    return "suspicious";
  }

  if (outcome.failedToolCount > 0) {
    return "suspicious";
  }

  return "clean";
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
