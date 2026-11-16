# ADR 0194: Optional subagent thinking override

- Status: Accepted for implementation
- Date: 2026-09-09
- Related: D356, E2E-203, ADR 0062, ADR 0063, ADR 0144

## Context

The subagent editor offered inheritance and explicit thinking levels but no way
to leave the provider default untouched, because the provider-neutral stream
path translates the agent `off` state into an explicit provider setting.

## Decision

Subagent frontmatter and input accept `thinkingLevel: omit` alongside the empty
inherit value and the seven canonical levels, scoped to subagents only. The
runtime represents `omit` as the bookkeeping `off` state but sends the provider
request through pi-ai's low-level stream so no thinking override is
synthesized, while explicit `off` keeps the simple stream path. The value is
additive and needs no migration or protocol bump.

## Consequences

- Users can tell inherit, explicit off, and no provider override apart.
- Existing definitions remain valid and behave unchanged.
- Provider adapters decide their own default when a subagent selects `omit`.
