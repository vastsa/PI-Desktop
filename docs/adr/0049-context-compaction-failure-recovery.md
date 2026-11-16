# ADR 0049: Recover automatic context compaction failures with a retained tail

- Status: Accepted
- Date: 2026-08-04
- Amends: ADR 0030 / D158
- Amended by: ADR 0061 (the fallback stays reserved for the blocking hard
  boundary) / ADR 0064 (no background build is left to discard, and the
  `fresh_window` family never reaches this path) / ADR 0282 (the summary
  request retries transient failures and a preflight guard sizes the serialized
  prompt before this fallback runs) / ADR 0302 (the fallback keeps the real
  recent window)

## Context

The turn-boundary guard stops an oversized provider request, but an LLM summary
can fail after the session already reached the hard boundary, turning a
transient summarizer failure into a terminal turn. Since the visible transcript
and the model-facing context are separate, a durable checkpoint can keep a
provider-valid recent tail even when no new summary exists.

## Decision

For automatic `threshold` and `overflow` compaction only, a three-outcome
controller applies. It first preflights the summary input against the model
window and skips a doomed summary request. If summary generation fails, or a
generated checkpoint stays above the safe budget, it prepares a deterministic
fallback checkpoint that reuses the previous summary, adds a recovery marker,
keeps a bounded recent tail, and records `details.fallback = "retained_tail"`.
The fallback is appended through host-core and re-estimated; success emits
`compaction_end` with `fallback: "retained_tail"` and the run continues with a
renderer warning.

Manual `/compact` never falls back. Durable append failures, missing transcript
boundaries, and still-oversized fallbacks emit `CONTEXT_COMPACTION_FAILED` and
block the provider request. The full transcript is never deleted or rewritten;
the fallback is only the model-context view rebuilt after restart.

## Consequences

- Automatic failures no longer end a run when a durable retained tail is safe.
- Older task detail may be lost; the warning and checkpoint metadata make that
  degradation explicit.
- Host persistence and hard-budget validation stay mandatory.

## Alternatives

- Continue without a checkpoint: rejected; the next request would bypass the
  hard guard.
- Delete visible transcript history: rejected; it destroys search, diagnostics,
  and fork inputs.
