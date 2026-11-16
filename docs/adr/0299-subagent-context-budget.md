# ADR 0299: Subagent context budget and delegate compaction

- Status: Accepted for implementation
- Date: 2026-09-20
- Amends: ADR 0064 (extends its compaction contract to delegates); extends
  ADR 0062 / ADR 0279
- Related: ADR 0030, ADR 0049, ADR 0136, ADR 0210, ADR 0246, ADR 0253,
  ADR subagent-model-fallback

## Context

Every context protection the session Agent has is wired for the session Agent
only. A delegate (`Task`, ADR 0062) runs the same pi `Agent` class without
`prepareNextTurnWithContext`, `contextBudget()`, pre-flight or turn-boundary
compaction, and cannot compact on its own because `new_context` is deny-listed
for it. Its context therefore grows until the provider rejects the request with
an unactionable `CONTEXT_TOO_LARGE`, and `fallbackModels` cannot help because
the carried context moves across unchanged. ADR 0064 never mentions delegates;
this is an omission, and it leaves the feature built to keep large reads out of
the session window as the one path with no window protection.

## Decision

### 1. One budget formula, shared

The parent's derivation moves verbatim into a pure module,
`packages/agent-runtime/src/context-budget.ts`, used by both `PiRuntime` and
`SubagentRun`, so `hardLimit = contextWindow − requestHeadroom` and its clamps
behave identically and the two callers cannot drift.

### 2. A delegate budget derives from the delegate's own model

The window and output cap come from the model the run resolved — a `Task.model`
override, a definition pin, or the inherited session model — not from the session
or the definition, with a per-definition `maxTokens` cap (ADR 0210) as its output
budget.

### 3. Turn-boundary compaction for delegates

`SubagentRun` wires `prepareNextTurnWithContext`, re-estimates its own context,
and compacts from `floor(hardLimit * 0.9)` before the next request using the
`prepareCompaction` and `generateSummary` primitives of
`@earendil-works/pi-agent-core`. The hard limit stays a final guard that rejects
an over-budget request, and retention follows ADR 0136's active-task boundary.

### 4. Degradation before failure

When a summary cannot be generated or the compacted context still exceeds
`hardLimit`, the run keeps the original task brief and the most recent messages,
discards the rest, and records that it was degraded. A summary that is empty or
whitespace-only counts as a summarization failure, not a successful checkpoint.

### 5. A terminal code the parent can act on

When even the degraded context does not fit, the run fails with
`SUBAGENT_CONTEXT_OVERFLOW` (`retriable: no`) and guidance to narrow the task,
delegate to a larger-window model, or read less at once, replacing the provider's
raw overflow text.

### 6. Fallback models are re-evaluated against their own window

Before advancing, the controller checks the carried context against the
alternative's budget and records an unsuitable alternative in `modelFailures`
instead of attempting it, leaving ordering, duplicate skipping, and retry budgets
unchanged.

### 7. Resume seeds within the budget

`seedDelegateMessages()` truncates the seeded chain against the delegate's budget,
keeping the task brief and recent turns and dropping the oldest tool results
first, so a resume starts below `hardLimit`.

### 8. `new_context` stays denied to delegates

Delegate compaction is entirely automatic, because the tool mutates parent
runtime state and inheriting it would let a delegate compact its parent.

## Consequences

- A long delegate compacts, then degrades, and only then fails with a code the
  parent can act on.
- A compacted delegate is lossy in the way a compacted session is, and a degraded
  run must say so or the parent reads a partial answer as complete.
- One shared budget module makes the parent's formula load-bearing for two
  callers: its existing budget tests are the regression surface for delegates.
