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
  `initialState`. It does not pass `prepareNextTurnWithContext`. That hook has
  exactly one wiring in the source tree,
  `packages/agent-runtime/src/runtime.ts:1894`, and it belongs to the parent
  session.
- `subagent.ts` has no notion of `contextWindow`, holds no token budget, and
  calls no compaction primitive. A delegate's context grows until the provider
  rejects the request.
- The parent has three layers the delegate lacks: `contextBudget()`
  (`runtime.ts:5652`, `hardLimit = contextWindow − requestHeadroom`), a
  pre-flight compaction in `prompt()` (`runtime.ts:7434`), and turn-boundary
  compaction in `prepareNextTurn()` (`runtime.ts:5839`, ADR 0064).
- A delegate cannot compact on its own initiative either: `new_context` is on
  `SUBAGENT_INHERIT_DENY_TOOLS`
  (`packages/shared/src/subagent-definition.ts:117`), because executing it sets
  the *parent* runtime's `pendingModelCompaction` flag. That denial is correct
  and stays.
- A resumed chain (ADR 0279) is seeded whole: `seedDelegateMessages()`
  (`packages/agent-runtime/src/delegation-history.ts:311`) puts the original
  task first and appends every converted chain row, de-duplicating the task
  brief and truncating nothing. The chain-level `MAX_RESUMABLE_READ_LINES`
  guard removes an over-read chain from the reusable list; it does not bound
  what a still-reusable chain seeds.
- On overflow the provider error classifies as `CONTEXT_TOO_LARGE` with
  `retriable = false` (`packages/agent-runtime/src/agent-errors.ts:407`, `:412`,
  `:426`) and `SubagentRun.run()` returns `result("failed", ...)`
  (`subagent.ts:275`). What reaches the parent model is the provider's raw
  English sentence, which names no recovery it can act on.
- `fallbackModels` is the only escape today, and it does not work for this
  failure: `useNextModel()` (`subagent.ts:302`) carries the accumulated context
  across unchanged, so an alternative whose window is not larger fails
  identically and burns a model slot doing it.

ADR 0064 does not mention subagents or delegates anywhere. This is an omission
from that design, not a deliberate exclusion: the delegate loop is a second
`Agent` in the same sidecar, running the same provider requests against the
same kind of window, and nothing in ADR 0064's reasoning distinguishes it. The
practical consequence is that the feature whose purpose is to keep large reads
out of the session's window (ADR 0062) is the one path with no window
protection at all.

## Decision

1. **One budget formula, shared.** The parent's budget derivation moves
   verbatim into a pure module, `packages/agent-runtime/src/context-budget.ts`,
   and both `PiRuntime` and `SubagentRun` call it.
   `hardLimit = contextWindow − requestHeadroom` with the existing headroom,
   reserve-floor, and `keepRecentTokens` clamps is unchanged, so the session's
   observable behavior is identical before and after the extraction. The module
   takes a model window and maximum output and returns a budget; it reads no
   runtime state, so the two callers cannot drift.

2. **A delegate budget derives from the delegate's own model.** The window and
   output cap come from the model the run actually resolved — a `Task.model`
   override, a definition pin, or the inherited session model (§5f) — not from
   the session model and not from the definition. A per-definition `maxTokens`
   cap (ADR 0210) participates as the output budget it already is.

3. **Turn-boundary compaction for delegates.** `SubagentRun` wires
   `prepareNextTurnWithContext`. At a delegate turn boundary the run
   re-estimates its own context; automatic compaction starts at
   `floor(hardLimit * 0.9)` (the shared threshold in ADR 0064) before the next
   provider request. The hard limit remains a final guard: if compaction is
   disabled or cannot reduce the context below budget, the next request is
   rejected rather than sent over budget. Compaction uses the
   `prepareCompaction` and `generateSummary` primitives
   `@earendil-works/pi-agent-core` 0.85.1 already exports. Retention follows the
   parent's rule (ADR 0136): a boundary with pending tool results retains as an
   active turn, a completed turn retains as a completed turn. There is no
   pre-computation.

4. **Degradation before failure.** When a summary cannot be generated, or the
   compacted context still exceeds `hardLimit`, the run keeps the original task
   brief plus the most recent message(s) and discards the rest of its history.
   The run continues and records that it was degraded, so the parent's report
   and the lifecycle details say the delegate lost history rather than
   presenting a complete answer.

5. **A terminal code the parent can act on.** When even the degraded context
   does not fit, the run fails with `SUBAGENT_CONTEXT_OVERFLOW`
   (`retriable: no`) carrying guidance the parent model can execute: narrow the
   task, delegate to a model with a larger context window, or read less at
   once. The provider's raw overflow text is no longer what the parent receives
   for this failure.

6. **Fallback models are re-evaluated against their own window.** Before
   advancing to an alternative, the controller checks the carried context
   against that alternative's budget. An alternative that cannot fit is skipped
   and recorded in `modelFailures` with that reason instead of being attempted
   into the same failure. Ordering, duplicate skipping, retry budgets, and the
   rest of ADR subagent-model-fallback are unchanged.

7. **Resume seeds within the budget.** `seedDelegateMessages()` truncates the
   seeded chain against the delegate's budget. The original task brief and the
   most recent turns are preserved; the oldest tool results are dropped first.
   A resume therefore starts below `hardLimit` instead of overflowing on its
   first request.

8. **`new_context` stays denied to delegates.** Delegate compaction is entirely
   automatic. The tool mutates parent runtime state, so inheriting it would
   let a delegate compact its parent; `SUBAGENT_INHERIT_DENY_TOOLS` keeps it
   out.

## Consequences

- A long delegate no longer ends in a provider overflow error. It compacts,
  and if it cannot compact it degrades, and only then fails — with a code that
  tells the parent what to change.
- A compacted delegate is lossier in exactly the way a compacted session is:
  assistant reasoning and tool output survive only through the summary. A
  delegate's report is the only thing the parent ever sees, so this is less
  visible than for the session — and for the same reason, a degraded run must
  say so, or the parent would read a partial answer as a complete one.
- Compaction costs the delegate a summary request at the moment it is already
  working, so a delegate that crosses the boundary is slower and more
  expensive than one that does not. The alternative it replaces is a failed
  run.
- Sharing one budget module makes the parent's formula load-bearing for two
  callers. A change to it now changes both, which is the point; it also means
  the parent's existing budget tests are the regression surface for delegates.
- Fallback re-evaluation can leave a configured alternative unused. The
  `modelFailures` entry names the reason, so the skip is auditable rather than
  silent.
- Resume truncation means a resumed delegate can start without history it had
  in an earlier round. It keeps the task brief and the recent turns, so the
  resume is still warmer than a cold start, but it is no longer a promise that
  the whole chain is in context.

## Not decided here / out of scope

- **Transcript rows.** Delegate compaction affects the delegate's model context
  only. It rewrites no persisted transcript row. The delegate's rows stay
  complete and visible, and the session runtime already keeps rows carrying
  `parentToolCallId` out of the parent's model context (§5f, Events and
  context), so nothing about the parent's context changes.
- **Durable checkpoints.** No host-core compaction record is written for a
  delegate. The checkpoint chain of ADR 0064 clause 6 remains the session's.
  A delegate's compaction is in-memory for the duration of its run.
- **Transcript presentation.** No compaction divider row, no warning toast, and
  no context-inspector line for a delegate. The user's visible surface for a
  delegate stays the delegation card and its report.
- **`new_context` for delegates.** Denied, per clause 8.
- **Parent behavior.** Clause 1 is an extraction, not a change. Nothing in
  this record alters when or how the session Agent compacts.
- **Cross-run budget accounting.** Concurrent delegates are budgeted
  independently, each against its own model. There is no session-wide ceiling
  across delegates and none is proposed here.

## References

- `docs/adr/0064-codex-parity-context-compaction.md`
- `docs/adr/0062-bounded-subagents-behind-a-task-tool.md`
- `docs/adr/0279-resumable-subagent-delegations.md`
- `docs/adr/0136-active-task-boundary-across-compaction.md`
- `docs/adr/subagent-model-fallback.md`
- `docs/spec/03-runtime/02-agent-runtime.md` §5.1, §5f
- `docs/spec/03-runtime/08-error-codes.md` §3.2
- `docs/spec/06-delivery/04-e2e-test-plan.md`
