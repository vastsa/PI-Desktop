# ADR 0282: Retry and right-size the compaction summary before retained-tail recovery

- Status: Accepted
- Date: 2026-09-18
- Amends: ADR 0049 (decision 1, the preflight guard), D203 / ADR 0064 (the
  summary family only)
- Amended by: ADR 0302 (an oversized prompt is summarized in chunks)
- Related: issue #543 · PR #554 (superseded) ·
  [03-runtime/02-agent-runtime](../spec/03-runtime/02-agent-runtime.md) ·
  E2E-084

## Context

ADR 0049 made a failed compaction summary survivable through a retained-tail
checkpoint, but on long sessions that fallback became the common outcome: the
summary request had no `RetryPolicy`, the preflight guard summed raw message
estimates instead of the serialized prompt pi actually sends (which caps tool
results), and the transcript row could not tell a fallback from a real summary.

## Decision

The summary request retries transient failures through a bounded pi-ai
`RetryPolicy` (`COMPACTION_SUMMARY_RETRY_POLICY`) whose classifier retries
overload, 429/5xx, dropped streams, timeouts, and resets while returning
quota, billing, auth, and malformed requests on the first attempt, with backoff
sleeps that honour the compaction abort signal. The preflight guard
(`compactionSummaryWouldExceedBudget`) serializes the input with pi's own
`convertToLlm` + `serializeConversation` and applies the runtime's
characters-per-token heuristic, counting the larger of the two requests for a
split turn, with the unchanged window limit. When the full prompt still exceeds
the limit the runtime tries exactly one reduced input that cuts tool results to
a 500-character prefix and drops assistant thinking while touching no message,
and only then falls back per ADR 0049. `ContextCompactionMark` gains an optional
`fallback?: "retained_tail"` derived from `details.fallback`, so the row reads
as a failure instead of `summary ≈N tokens`, additively and with no schema or
protocol change. Manual `/compact` inherits retry and sizing but keeps its
fail-fast semantics.

## Consequences

- Sessions on a flapping provider keep a real model summary, and tool-heavy
  sessions no longer skip summarization on an overestimated size.
- A sustained outage can delay the fallback by the retry window, which Stop
  aborts immediately.
- A reduced prompt may summarize tool output more thinly, but it still covers
  every message behind the checkpoint boundary.

## Alternatives

- An outer retry loop around `buildCheckpoint` (PR #554): rejected, it retried
  deterministic failures and duplicated pi-ai's classifier.
- Dropping the oldest messages: rejected, the checkpoint still claimed a range
  the summary had not seen.
