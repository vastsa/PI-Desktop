# ADR: Model reasoning effort override

- Status: Proposed
- Date: 2026-10-23
- Related: issue #1821, issue #1701

## Context

DeepSeek-family Chat Completions compatibility disables `reasoning_effort` for
endpoints that reject that field. Model-name detection also covers custom relays
that do support it, so choosing High can silently omit the parameter.

## Decision

Add optional `supportsReasoningEffort: boolean | null` to the persisted model
binding. Missing/null retains automatic compatibility; true/false explicitly
allows/disallows the parameter.

## Update (2026-10-23)

The automatic default for official `deepseek.com` endpoints changed after this
ADR landed: those rows now leave `supportsReasoningEffort` to pi-ai detection,
so the selected level reaches the wire by default (D672, #1821). The explicit
per-model override described here is unchanged and still takes precedence in
both directions.

Expose Auto / Send / Do not send in the existing per-model settings. Host
normalization, configuration copying and synchronization preserve the value.

## Consequences

Legacy JSON needs no migration: an absent field retains its prior behavior.
