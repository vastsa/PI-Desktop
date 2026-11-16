# ADR 0049: Recover automatic context compaction failures with a retained tail

- Status: Accepted
- Date: 2026-08-04
- Amends: ADR 0030 / D158
- Amended by: ADR 0061 (the fallback stays reserved for the blocking hard
  boundary; a failed background build is discarded silently) / ADR 0064 (there
  is no background build left to discard, and the `fresh_window` family issues
  no summary request, so this path cannot trigger there) / ADR 0282 (the
  summary request retries transient failures and the preflight guard sizes
  the serialized prompt, with one reduced pass, before this fallback runs) /
  ADR 0302 (the fallback keeps the real recent window rather than one user

## Context

The turn-boundary context guard correctly prevents an oversized provider
request, but an LLM summary request can fail after the session has already
reached the hard boundary. Treating every automatic summary failure as a
terminal turn leaves the complete transcript durable but forces the next user
message to recover the session manually.

## Decision

For automatic `threshold` and `overflow` compaction only, PI-Desktop uses a
three-outcome controller:

1. Preflight the summary input against the provider model window.
2. If summary generation fails, or a generated checkpoint remains above the safe
   budget, prepare a deterministic fallback checkpoint.
3. Append the fallback through host-core and re-estimate the model context.

Manual `/compact` never silently falls back. Durable append failures, missing
transcript boundaries, and fallback checkpoints that remain oversized emit
`CONTEXT_COMPACTION_FAILED` and block the guarded provider request.

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

Rejected because the next provider request would bypass the hard guard and could
reproduce the provider context-limit failure.

### Delete visible transcript history

Rejected because it destroys searchability, diagnostics, fork inputs, and the
user's complete conversation.

### Retry the summary indefinitely

Rejected because a long or incompatible provider failure can hold the session
busy indefinitely.
