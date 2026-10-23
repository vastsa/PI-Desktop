# ADR: Model reasoning effort override

- Status: Proposed
- Date: 2026-10-23
- Related: issue #1821, issue #1701

## Context

DeepSeek-family Chat Completions compatibility disables `reasoning_effort`
for endpoints that reject that field. Model-name detection also covers custom
relays that do support it, so choosing High can silently omit the parameter.
Changing the automatic default would regress the endpoints protected by #1701.

## Decision

Add optional `supportsReasoningEffort: boolean | null` to the persisted model
binding. Missing/null retains automatic compatibility; true/false explicitly
allows/disallows the parameter. Keep this provenance separate from catalog
compatibility and apply it last, only when building a Chat Completions model.
The setting does not turn reasoning on or override the selected thinking level.

## Update (2026-10-23)

The automatic default for official `deepseek.com` endpoints changed after this
ADR landed: those rows now leave `supportsReasoningEffort` to pi-ai detection,
so the selected level reaches the wire by default (D672, #1821). The explicit
per-model override described here is unchanged and still takes precedence in
both directions.

Expose Auto / Send / Do not send in the existing per-model settings. Host
normalization, configuration copying and synchronization preserve the value.
Other APIs hide the setting and ignore it during request construction.

## Consequences

Legacy JSON needs no migration: an absent field retains its prior behavior.
Clearing a choice restores automatic compatibility. A user enabling Send is
responsible for selecting a gateway that accepts the parameter; provider errors
remain visible. No retry, silent protocol change or compatibility fallback is
introduced. The alternative of globally re-enabling the field is rejected
because it would undo the existing DeepSeek protection.
