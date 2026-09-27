# ADR 0049: Recover automatic context compaction failures with a retained tail

- Status: Accepted
- Date: 2026-08-04
- Amends: ADR 0030 / D158
- Amended by: ADR 0061 (the fallback stays reserved for the blocking hard
  boundary; a failed background build is discarded silently) / ADR 0064 (there
  is no background build left to discard, and the `fresh_window` family issues
  no summary request, so this path cannot trigger there)

## Context

The turn-boundary context guard correctly prevents an oversized provider
request, but an LLM summary request can fail after the session has already
reached the hard boundary. Treating every automatic summary failure as a
terminal turn leaves the complete transcript durable but forces the next user
message to recover the session manually. It also makes a transient or
provider-specific summarizer failure indistinguishable from an inability to
persist a checkpoint.

The visible transcript and the model-facing context are already separate. A
checkpoint can therefore preserve the recent provider-valid message tail even
when no new natural-language summary is available. The checkpoint must still
be durable and must pass the same hard-budget recheck; otherwise the provider
request remains blocked.

This also covers the boundary case where the newest checkpoint is the current
transcript leaf. pi reports no new history to summarize in that shape, but a
new prompt can still make the retained tail too large. The full transcript is
the source for rebuilding a smaller tail while the existing summary is carried
forward.

## Decision

For automatic `threshold` and `overflow` compaction only, PI-Desktop uses a
three-outcome controller:

1. Preflight the summary input against the provider model window. If the
   serialized history plus the summary output allowance cannot fit, skip the
   doomed summary request; otherwise run the normal pi-agent-core summary
   compaction.
2. If summary generation fails, or a generated checkpoint remains above the
   safe budget, prepare a deterministic fallback checkpoint. It reuses the
   previous checkpoint summary when available, adds a short recovery marker,
   keeps an aggressively bounded recent tail, and records
   `details.fallback = "retained_tail"`.
3. Append the fallback through host-core and re-estimate the model context. A
   successful fallback emits `compaction_end` with
   `fallback: "retained_tail"`; the active run continues, and the renderer
   shows a warning rather than a normal success toast.

Manual `/compact` never silently falls back. Durable append failures, missing
transcript boundaries, and fallback checkpoints that remain oversized emit
`CONTEXT_COMPACTION_FAILED` and block the guarded provider request.

The complete transcript is never deleted, rewritten, or replaced by the
fallback. The fallback is only the model-context view rebuilt after restart.

## Consequences

- Automatic compaction failures no longer terminate a run when a safe durable
  retained tail can be installed.
- The model may lose older task details when summary generation fails; the
  warning and checkpoint metadata make that degradation explicit.
- Host persistence and hard-budget validation remain mandatory, so recovery
  cannot trade a better UX for an unsafe provider request.
- Manual compaction remains an explicit user action with fail-fast semantics.
- The event and checkpoint metadata provide a stable diagnostic signal without
  persisting provider error text that may contain sensitive endpoint details.

## Alternatives

### Continue without a checkpoint

Rejected because the next provider request would bypass the hard guard and
could reproduce the provider context-limit failure.

### Delete visible transcript history

Rejected because it destroys searchability, diagnostics, fork inputs, and the
user's complete conversation.

### Retry the summary indefinitely

Rejected because a long or incompatible provider failure can hold the session
busy indefinitely. The bounded deterministic fallback is predictable and
keeps the provider request gate intact.
