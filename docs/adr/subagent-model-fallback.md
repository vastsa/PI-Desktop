# ADR: Ordered subagent model fallback

- Status: Accepted for implementation
- Date: 2026-09-14
- Related: ADR 0062, ADR 0063, ADR 0202, ADR subagent-model-opt-in

## Context

A subagent can select only one model, and its bounded provider retries cannot
recover when that model stays unavailable, while restarting the delegated task on
another agent could repeat tools that already changed files.

## Decision

A definition, the user-subagent record and input, and the internal launch definition
accept an optional `fallbackModels` ordered list of `provider/model` strings —
managed Markdown and host RPC, parsed into model pins in Shared — alongside the
unchanged primary `model` and Task override priority; a missing list keeps
single-model behavior, an omitted update preserves the list, and `[]` clears it,
with no database or protocol version change. Electron resolves alternatives through
the same credential, provider-count, and model-capability boundaries as primary
pins, scoped to their owning definition, and a primary pin that cannot resolve still
fails before launch while an unresolved alternative is reported when reached and
skipped. After the current model's retries are exhausted, or on a non-retryable
provider error, the runtime tries the next alternative, each resolved
provider-id/model-id pair at most once per delegation: the same agent keeps its
system prompt, original task, successful assistant and tool history, tool scope,
counters, and usage, only the failed assistant request leaves model context before
`continue()` while staying in the visible transcript, and no task or completed tool
is replayed. The model, adapter, credentials, headers, output cap, and thinking
level change together, with thinking re-clamped per model from the definition or
original parent selection; the original abort signal owns the whole chain, and
host/tool failures, missing reports, thrown errors, and cancellation do not initiate
fallback.

## Consequences

- Failed attempts stay visible in child transcript diagnostics and the bounded
  parent report, and lifecycle snapshots keep the final effective model, thinking,
  and additive `modelFailures` diagnostics.
- Exhausting the chain returns `failed` with the final provider error; it never
  selects an unlisted model or silently inherits the parent as recovery.
- Settings lists fallback models in priority order under Advanced, each movable and
  removable.

## Alternatives

- Restart the delegated task on another agent: could repeat tools that already
  changed files.
