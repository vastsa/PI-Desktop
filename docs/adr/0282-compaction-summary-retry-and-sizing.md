# ADR 0282: Retry and right-size the compaction summary before retained-tail recovery

- Status: Accepted
- Date: 2026-09-18
- Deciders: PI-Desktop runtime maintainers
- Amends: ADR 0049 (decision 1, the preflight guard; the "retry indefinitely"
  rejection stands), D203 / ADR 0064 (the summary family only)
- Amended by: ADR 0302 (a prompt that still does not fit after the reduced pass
  is summarized in chunks; only a range the planner cannot split falls back)
- Related: issue #543 · PR #554 (superseded) ·
  [03-runtime/02-agent-runtime](../spec/03-runtime/02-agent-runtime.md) ·
  [03-runtime/01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) ·
  E2E-084

## Context

ADR 0049 made an automatic compaction failure survivable: when the summary
request fails, the runtime writes a retained-tail checkpoint (previous summary
if any, a fixed recovery notice, and a bounded tail) and the run continues.
Issue #543 reports that on real long sessions this fallback is the common
outcome rather than the exception: six of ten checkpoints on the reporter's
machine were the ~112-token recovery notice, and the transcript row labelled
every one of them `summary ≈112 tokens`.

Three things in the summary path made a fallback far more likely than the
provider's actual failure rate:

1. **No retry on the summary request.** `compact()` was called with no
   `RetryPolicy`, so pi-ai returned the first failed response as-is. The
   main turn's provider requests already retry transient failures through the
   `streamFn` wrapper (D186), but pi-agent-core's summary request goes through
   `Models.completeSimple` and never reaches that wrapper. One dropped stream
   or 503 discarded the whole summary.
2. **The preflight guard measured the wrong thing.** It summed
   `estimateTokens` over the raw messages, but pi-agent-core serializes the
   conversation into one text prompt and caps every tool result at 2 000
   characters while doing so. A tool-heavy session looked several times larger
   than the prompt it would actually send, and the guard skipped the model for
   summaries that would have fit. The reporter's `tokensBefore` values
   (~200k–885k on a 200k window) are exactly this shape.
3. **The UI could not tell a fallback from a summary.** `ContextCompactionMark`
   only distinguishes the `fresh_window` rollover; a retained-tail checkpoint
   rendered as a successful summary of N tokens.

PR #554 proposed an outer retry loop around `buildCheckpoint` and a shrink step
that dropped the oldest messages from the summary input. The loop retried every
`recoverable` failure including deterministic ones (quota, auth, "no new
context"), and dropping messages silently narrowed what the checkpoint claimed
to summarize. Its direction — retry, then reduce, then fall back — is kept
here; those two mechanisms are not.

## Decision

1. **The summary request retries transient failures, bounded.**
   `generateCompaction` passes pi-ai a `RetryPolicy` of three retries with
   2 s / 4 s / 8 s backoff (`COMPACTION_SUMMARY_RETRY_POLICY`). pi-ai's own
   classifier decides what is transient: overload, 429/5xx, dropped streams,
   timeouts, and connection resets retry; quota, billing, auth, and malformed
   requests return on the first attempt. The backoff sleeps honour the
   compaction abort signal, so Stop still cancels immediately. A flapping
   provider costs at most ~14 s before the ADR 0049 fallback runs; ADR 0049's
   rejection of unbounded retry stands.
2. **The preflight guard sizes the prompt pi will send.**
   `compactionSummaryWouldExceedBudget` serializes the input with pi's own
   `convertToLlm` + `serializeConversation` (tool results already capped) and
   applies the four-characters-per-token heuristic the rest of the runtime
   uses. A split turn counts the larger of its two requests. The limit itself
   (window − output allowance − safety margin) is unchanged.
3. **One bounded reduction before giving up.** When the full prompt still
   exceeds the limit, the runtime tries exactly one reduced input: every tool
   result cut to a 500-character prefix with a visible marker, assistant
   thinking dropped. User text, assistant text, and tool-call arguments are
   never touched, and no message is removed, so the summary still covers every
   message the checkpoint files behind its boundary. If the reduced prompt
   still does not fit, or nothing was reducible, the ADR 0049 fallback runs as
   before. The checkpoint's `messagesToSummarize` and `retainedTail` are the
   originals; only the request payload is reduced.
4. **The mark says when a checkpoint is a fallback.** `ContextCompactionMark`
   gains an optional `fallback?: "retained_tail"`, derived from the persisted
   `details.fallback` the same way `summarized` is derived from
   `details.strategy`. The transcript row renders such a mark as
   "summary generation failed · recent context retained" instead of
   `summary ≈N tokens`; the inspector line is unchanged. The field is
   additive: older marks without it render exactly as before, and no record
   schema, protocol version, or host-core change is needed.

Manual `/compact` inherits the retry and sizing (it is the same request) and
keeps its fail-fast, no-fallback semantics. The `fresh_window` family issues no
summary request and is untouched.

## Consequences

- Sessions on a flapping provider keep a real model summary far more often;
  the fallback is reserved for sustained failures and inputs that cannot be
  reduced under the window.
- Tool-heavy sessions no longer skip the summary because of a raw-size
  estimate that pi's serialization would never have sent.
- A compaction can now take up to ~14 s longer on a sustained outage before
  the fallback lands. The compacting activity state already covers this; Stop
  aborts the backoff immediately.
- The reduced prompt can produce a thinner summary of tool output than the
  full one would; it is still a model summary of the complete message range,
  which is strictly better than the recovery notice it replaces.
- The transcript row is honest about fallbacks. Users who saw
  `summary ≈112 tokens` will now see the failure label on the same rows,
  including historical ones, because the mark is derived from persisted
  details on session open.

## Alternatives

### Outer retry loop around `buildCheckpoint` (PR #554)

Rejected. It re-ran preparation and retried every recoverable failure
including deterministic ones, and could not tell a transient provider error
from "no new context to compact" without re-implementing pi-ai's classifier.
The policy hook on `compact()` already exists for exactly this.

### Shrink by dropping the oldest messages (PR #554)

Rejected. The checkpoint's `throughMessageId` still covered the dropped
messages, so the summary silently claimed a range it had not seen. Reducing
tool output keeps the range intact.

### Map-reduce summarization for oversized inputs

Deferred. It is the right answer for inputs that do not fit even reduced, but
it changes the summary prompt contract and needs its own budget model. The
fallback remains for that case; #543's reported failures fit after reduction.

### Retry inside the runtime with `provider-retry.ts`

Rejected. That module wraps `streamFn` and classifies streamed events; the
summary is a `completeSimple` call that pi-agent-core builds itself. Using
pi-ai's policy keeps one retry implementation per request shape.
