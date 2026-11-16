# ADR 0299: Subagent context budget and delegate compaction

- Status: Accepted for implementation
- Date: 2026-09-20
- Deciders: PI-Desktop core
- Amends: ADR 0064 (extends its compaction contract to delegates); extends
  ADR 0062 / ADR 0279
- Related: ADR 0030 (hard boundary), ADR 0049 (retained-tail recovery),
  ADR 0136 (active task boundary), ADR 0246, ADR 0253,
  ADR subagent-model-fallback

## Context

Every context protection the session Agent has is wired for the session Agent
only. A delegate (`Task`, ADR 0062) runs the same pi `Agent` class with none of
it:

- `SubagentRun`'s constructor (`packages/agent-runtime/src/subagent.ts:214`)
  passes `streamFn`, `getApiKey`, `convertToLlm`, `afterToolCall` and
  `initialState`.
- `subagent.ts` has no notion of `contextWindow`, holds no token budget, and
  calls no compaction primitive.
- The parent has three layers the delegate lacks: `contextBudget()`
  (`runtime.ts:5652`, `hardLimit = contextWindow − requestHeadroom`), a
  pre-flight compaction in `prompt()` (`runtime.ts:7434`), and turn-boundary
  compaction in `prepareNextTurn()` (`runtime.ts:5839`, ADR 0064).
- A delegate cannot compact on its own initiative either: `new_context` is on
  `SUBAGENT_INHERIT_DENY_TOOLS`
  (`packages/shared/src/subagent-definition.ts:117`), because executing it sets
  the *parent* runtime's `pendingModelCompaction` flag.

## Decision

1. **One budget formula, shared.** The parent's budget derivation moves verbatim
   into a pure module, `packages/agent-runtime/src/context-budget.ts`, and both
   `PiRuntime` and `SubagentRun` call it.

2. **A delegate budget derives from the delegate's own model.** The window and
   output cap come from the model the run actually resolved — a `Task.model`
   override, a definition pin, or the inherited session model (§5f) — not from
   the session model and not from the definition.

3. **Turn-boundary compaction for delegates.** `SubagentRun` wires
   `prepareNextTurnWithContext`.

4. **Degradation before failure.** When a summary cannot be generated, or the
   compacted context still exceeds `hardLimit`, the run keeps the original task
   brief plus the most recent message(s) and discards the rest of its history.

5. **A terminal code the parent can act on.** When even the degraded context
   does not fit, the run fails with `SUBAGENT_CONTEXT_OVERFLOW` (`retriable:
   no`) carrying guidance the parent model can execute: narrow the task,
   delegate to a model with a larger context window, or read less at once.

6. **Fallback models are re-evaluated against their own window.** Before
   advancing to an alternative, the controller checks the carried context
   against that alternative's budget.

7. **Resume seeds within the budget.** `seedDelegateMessages()` truncates the
   seeded chain against the delegate's budget.

8. **`new_context` stays denied to delegates.** Delegate compaction is entirely
   automatic.

## Consequences

- A long delegate no longer ends in a provider overflow error.
- A compacted delegate is lossier in exactly the way a compacted session is:
  assistant reasoning and tool output survive only through the summary.
- Compaction costs the delegate a summary request at the moment it is already
  working, so a delegate that crosses the boundary is slower and more expensive
  than one that does not.
- Sharing one budget module makes the parent's formula load-bearing for two
  callers.
- Fallback re-evaluation can leave a configured alternative unused.

## Not decided here / out of scope

- **Transcript rows.** Delegate compaction affects the delegate's model context
  only.
- **Durable checkpoints.** No host-core compaction record is written for a
  delegate.
- **Transcript presentation.** No compaction divider row, no warning toast, and
  no context-inspector line for a delegate.
- **`new_context` for delegates.** Denied, per clause 8.
- **Parent behavior.** Clause 1 is an extraction, not a change.
- **Cross-run budget accounting.** Concurrent delegates are budgeted
  independently, each against its own model.

## References

- `docs/adr/0064-codex-parity-context-compaction.md`
- `docs/adr/0062-bounded-subagents-behind-a-task-tool.md`
- `docs/adr/0279-resumable-subagent-delegations.md`
- `docs/adr/0136-active-task-boundary-across-compaction.md`
- `docs/adr/subagent-model-fallback.md`
- `docs/spec/03-runtime/02-agent-runtime.md` §5.1, §5f
- `docs/spec/03-runtime/08-error-codes.md` §3.2
- `docs/spec/06-delivery/04-e2e-test-plan.md`
